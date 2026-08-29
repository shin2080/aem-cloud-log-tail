/**
 * Phase 0b — gzip 판정이 나온 뒤, tail 전략을 확정하기 위한 추가 조사.
 *
 *   npm run phase0b -- --org acme --program 12345 --env 987654
 *
 * Phase 0 에서 당일 파일이 gzip 으로 확인됐다. SPEC 11장은 (a) 전체 재다운로드 /
 * (b) 꼬리 부분 해제 두 가지를 대안으로 뒀지만, 그 전에 확인할 게 둘 더 있다.
 *
 *   A. logs/tail 링크    — Adobe 가 tail 전용 엔드포인트를 준다. 평문이면 (a)/(b) 둘 다 불필요
 *   B. 멀티멤버 gzip 여부 — .gz 가 멤버 단위로 append 되면 Range 델타를 그대로 해제할 수 있다.
 *                          그러면 SPEC 6.3 알고리즘이 거의 그대로 산다
 *   C. 증가 속도         — (a) 를 골랐을 때의 대역폭 비용을 실측한다
 *
 * 읽기 전용이다.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync, constants as zlibConstants } from 'node:zlib';
import { loadConfig, type OrgConfig } from '../server/config/env.js';
import { ImsTokenCache } from '../server/adobe/ims.js';
import { CloudManagerClient, type LogOption } from '../server/adobe/cloudmanager.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const GROWTH_WAIT_MS = Number(arg('wait') ?? 60_000);

const out: string[] = [];
function say(line = ''): void {
  console.log(line);
  out.push(line);
}
function section(title: string): void {
  say();
  say(`## ${title}`);
  say();
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}?<${[...u.searchParams.keys()].sort().join(', ')}>`;
  } catch {
    return '<파싱 불가>';
  }
}

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
}

const GZIP_MAGIC = [0x1f, 0x8b, 0x08];

function isGzipStart(b: Uint8Array, at = 0): boolean {
  return GZIP_MAGIC.every((m, i) => b[at + i] === m);
}

/** 잘린 gzip 이어도 나온 데까지 뱉게 한다. 꼬리 부분 해제 가능성을 판정하는 핵심. */
function gunzipPartial(buf: Uint8Array): string | null {
  try {
    return gunzipSync(buf, { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString('utf8');
  } catch {
    return null;
  }
}

/** 버퍼 안의 gzip 멤버 시작 후보 오프셋. 실제로 해제되는 것만 남긴다. */
function findMemberBoundaries(buf: Uint8Array, limit = 50): number[] {
  const found: number[] = [];
  for (let i = 0; i + 3 < buf.length && found.length < limit; i++) {
    if (!isGzipStart(buf, i)) continue;
    // 매직이 압축 데이터 안에 우연히 나올 수 있다. 실제로 풀리는지로 검증한다.
    const probe = gunzipPartial(buf.subarray(i, Math.min(buf.length, i + 65536)));
    if (probe !== null && probe.length > 0) found.push(i);
  }
  return found;
}

function isLogText(s: string): boolean {
  return /\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}\.\d{3}/.test(s) || /\*(INFO|WARN|ERROR|DEBUG|TRACE)\*/.test(s);
}

async function sizeOf(url: string): Promise<number> {
  const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  const cr = res.headers.get('content-range');
  await res.body?.cancel();
  return cr ? Number(cr.split('/')[1]) : Number(res.headers.get('content-length') ?? 0);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const orgKey = arg('org') ?? [...cfg.orgs.keys()][0]!;
  const org = cfg.orgs.get(orgKey);
  if (!org) {
    console.error(`조직 '${orgKey}' 가 .env 에 없다. 등록된 조직: ${[...cfg.orgs.keys()].join(', ')}`);
    process.exit(1);
  }

  const ims = new ImsTokenCache();
  const cm = new CloudManagerClient(ims);

  say('# Phase 0b — gzip tail 전략 조사');
  say();
  say(`- 실행 시각: ${new Date().toISOString()}`);
  say(`- 대상 조직: \`${org.key}\``);

  const programId = arg('program') ?? (await cm.listPrograms(org))[0]!.id;
  const envs = await cm.listEnvironments(org, programId);
  const envId = arg('env') ?? (envs.find((e) => e.type === 'dev') ?? envs[0]!).id;
  const envType = envs.find((e) => e.id === envId)?.type ?? '?';
  say(`- 대상: program=${programId} environment=${envId} (${envType})`);

  const options = await cm.listLogOptions(org, programId, envId, 1);
  const today = new Date().toISOString().slice(0, 10);
  const service = arg('service') ?? 'author';
  const name = arg('name') ?? 'aemerror';
  const target =
    options.find((o) => o.service === service && o.name === name && o.date === today) ??
    options.find((o) => o.service === service && o.name === name);

  if (!target) {
    say(`\n> service=${service} name=${name} 옵션을 찾지 못했다.`);
    finish();
    return;
  }
  say(`- 선택: service=\`${target.service}\` name=\`${target.name}\` date=\`${target.date}\``);

  /* ── A. tail 링크 ─────────────────────────────────── */
  section('A. `logs/tail` 링크 조사 ← 이게 되면 (a)/(b) 둘 다 불필요');

  if (!target.tailHref) {
    say('- 이 항목에 tail 링크가 없다. B 로 넘어간다.');
  } else {
    say(`- tail href: \`${redactUrl(target.tailHref)}\``);
    say(`- 경로: \`${(() => { try { return new URL(target.tailHref!).pathname; } catch { return target.tailHref!; } })()}\``);
    try {
      const signed = await cm.resolveSignedUrl(org, target.tailHref);
      say(`- 서명 URL: \`${redactUrl(signed.url)}\``);
      say(`- 만료: ${signed.expiresAt ? new Date(signed.expiresAt).toISOString() : '(파라미터 없음)'}`);

      const res = await fetch(signed.url, { headers: { Range: 'bytes=0-4095' } });
      const buf = new Uint8Array(await res.arrayBuffer());
      const cr = res.headers.get('content-range');
      const total = cr ? Number(cr.split('/')[1]) : buf.byteLength;
      const gz = isGzipStart(buf);

      say(`- HTTP ${res.status}, \`Content-Type\`: ${res.headers.get('content-type') ?? '-'}`);
      say(`- \`Content-Encoding\`: ${res.headers.get('content-encoding') ?? '(없음)'}`);
      say(`- \`Content-Range\`: ${cr ?? '(없음)'} → 전체 ${total.toLocaleString()} bytes`);
      say(`- 첫 3바이트: ${hex(buf.slice(0, 3))} ${gz ? '← gzip' : ''}`);

      const text = gz ? (gunzipPartial(buf) ?? '') : new TextDecoder().decode(buf);
      say();
      if (!gz && isLogText(text)) {
        say('### 결론: tail 링크는 **평문이다** ✅');
        say();
        say('SPEC 6.3 의 Range 폴링을 이 URL 에 대고 그대로 쓴다. gzip 문제가 사라진다.');
        say('다운로드 링크(.gz)는 시간대 조회(Phase 4)에서 하루치를 훑을 때만 쓴다.');
      } else if (gz) {
        say('### tail 링크도 gzip 이다. B 의 멀티멤버 여부가 결정한다.');
      } else {
        say('### 결론 보류 — 평문도 로그 형식도 아니다. 아래 헤더를 보고 판단한다.');
      }
      say('```');
      say(
        (text.split('\n').find((l) => l.trim().length > 0) ?? '(빈 응답)').slice(0, 160),
      );
      say('```');
      say('(첫 한 줄만 발췌)');
    } catch (err) {
      say(`- tail 링크 호출 실패: ${err instanceof Error ? err.message : String(err)}`);
      say('- → 권한 부족이거나 이 환경에서 미지원. B 로 판단한다.');
    }
  }

  /* ── B. 멀티멤버 gzip 여부 ────────────────────────── */
  section('B. `.gz` 가 멀티멤버인가 ← 되면 SPEC 6.3 이 거의 그대로 산다');

  const dl = target.downloadHref
    ? await cm.resolveSignedUrl(org, target.downloadHref)
    : await cm.getSignedLogUrl(org, programId, envId, target.service, target.name, target.date ?? today);

  const size = await sizeOf(dl.url);
  say(`- 파일 크기: ${size.toLocaleString()} bytes`);

  // 1) 파일 맨 앞이 gzip 인 건 Phase 0 에서 확인했다. 꼬리에도 멤버 경계가 있는지 본다.
  const tailWindow = Math.min(size, 512 * 1024);
  const tailRes = await fetch(dl.url, { headers: { Range: `bytes=${size - tailWindow}-` } });
  const tailBuf = new Uint8Array(await tailRes.arrayBuffer());
  say(`- 꼬리 ${tailWindow.toLocaleString()} bytes 를 받아 멤버 경계를 찾는다.`);

  const boundaries = findMemberBoundaries(tailBuf);
  say(`- 검증된 멤버 시작 오프셋: ${boundaries.length}개 ${boundaries.length > 0 ? `(창 내 상대 위치 ${boundaries.slice(0, 8).join(', ')}${boundaries.length > 8 ? ' …' : ''})` : ''}`);

  say();
  if (boundaries.length > 0) {
    const last = boundaries[boundaries.length - 1]!;
    const decoded = gunzipPartial(tailBuf.subarray(last)) ?? '';
    const lines = decoded.split('\n').filter((l) => l.trim().length > 0);
    say('### 결론: **멀티멤버 gzip 이다** ✅');
    say();
    say(`마지막 멤버(파일 오프셋 ${(size - tailWindow + last).toLocaleString()})부터 해제해 ${lines.length}줄을 읽었다.`);
    say(`로그 형식 확인: ${isLogText(decoded) ? '통과' : '실패 — 사람이 확인 필요'}`);
    say();
    say('이러면 SPEC 6.3 을 이렇게만 고쳐 쓴다:');
    say('```');
    say('  offset 은 압축 바이트 기준으로 유지한다');
    say('  Range: bytes={offset}- 로 받은 델타는 완결된 멤버들의 연속이다');
    say('  → 그대로 gunzip 에 흘려 평문 라인을 얻는다 (Node zlib 은 연결된 멤버를 알아서 처리한다)');
    say('  → 마지막 멤버가 잘렸으면 그 바이트는 소비하지 않고 다음 폴링으로 넘긴다');
    say('```');
    say('대역폭은 평문 tail 과 같은 수준(오히려 압축된 만큼 적다). (a) 도 (b) 도 필요 없다.');
  } else {
    say('### 결론: **단일 스트림 gzip 이다** ⚠️');
    say();
    say('꼬리에서 멤버 경계를 찾지 못했다. Range 로 받은 델타만 따로 해제할 수 없다.');
    say('A 의 tail 링크가 평문이 아니었다면 SPEC 11장 (a)/(b) 중에서 골라야 한다.');
  }

  /* ── C. 증가 속도 ─────────────────────────────────── */
  section('C. 증가 속도 — 전체 재다운로드(a) 를 골랐을 때의 비용');

  say(`${GROWTH_WAIT_MS / 1000}초 기다렸다가 다시 잰다.`);
  await new Promise((r) => setTimeout(r, GROWTH_WAIT_MS));
  const size2 = await sizeOf(dl.url);
  const grew = size2 - size;

  say('```');
  say(`  이전: ${size.toLocaleString()} bytes`);
  say(`  이후: ${size2.toLocaleString()} bytes`);
  say(`  증가: ${grew.toLocaleString()} bytes / ${GROWTH_WAIT_MS / 1000}초`);
  say('```');

  if (grew > 0) {
    const perPoll = (grew / (GROWTH_WAIT_MS / 1000)) * (cfg.TAIL_POLL_INTERVAL_MS / 1000);
    say(`- 델타 방식이면 폴링(${cfg.TAIL_POLL_INTERVAL_MS}ms)당 약 **${Math.round(perPoll).toLocaleString()} bytes**`);
    say(`- 전체 재다운로드(a) 면 폴링당 **${size2.toLocaleString()} bytes** — ${Math.round(size2 / Math.max(perPoll, 1))}배`);
    say(`- 하루 환산: (a) 는 세션 하나당 약 ${((size2 * (86400_000 / cfg.TAIL_POLL_INTERVAL_MS)) / 1024 ** 3).toFixed(1)} GB`);

    // 멀티멤버라면 실제로 델타가 독립 해제되는지 여기서 최종 확인한다.
    const deltaRes = await fetch(dl.url, { headers: { Range: `bytes=${size}-` } });
    const delta = new Uint8Array(await deltaRes.arrayBuffer());
    say();
    say(`- 증가분 첫 3바이트: ${hex(delta.slice(0, 3))} ${isGzipStart(delta) ? '← 새 멤버로 시작한다 ✅' : '← 멤버 경계가 아니다'}`);
    if (isGzipStart(delta)) {
      const t = gunzipPartial(delta);
      say(`- 증가분만 독립 해제: ${t !== null ? `성공, ${t.split('\n').filter((l) => l.trim()).length}줄` : '실패'}`);
      if (t) say(`- 로그 형식 확인: ${isLogText(t) ? '통과 ✅' : '실패'}`);
    }
  } else {
    say('- 측정 구간에 파일이 자라지 않았다. 트래픽이 있는 시간대나 환경에서 다시 실행한다.');
    say(`- \`--wait 300000\` 으로 대기 시간을 늘려볼 수 있다.`);
  }

  finish();
}

function finish(): void {
  section('결정');
  say();
  say('- [ ] A 가 평문 → tail 링크로 간다. 가장 깔끔하다');
  say('- [ ] A 는 아니지만 B 가 멀티멤버 → SPEC 6.3 + 멤버 단위 해제');
  say('- [ ] 둘 다 아니면 → SPEC 11장 (a)/(b) 중 선택. C 의 대역폭 수치로 판단한다');

  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/findings-0b.md', out.join('\n') + '\n', 'utf8');
  console.log('\n→ docs/findings-0b.md 에 기록했다.');
}

main().catch((err) => {
  console.error(`\n[Phase 0b 실패] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
