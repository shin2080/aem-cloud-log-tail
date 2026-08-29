/**
 * Phase 0 — 코드 작성 전 실환경 검증.
 *
 *   npm run phase0 -- --org acme
 *   npm run phase0 -- --org acme --program 12345 --env 67890 --service author --samples 5
 *
 * SPEC 10장이 요구하는 다섯 가지를 실제 환경에 물어보고 docs/findings.md 를 쓴다.
 *   1. 302 Location 서명 URL 의 만료 시간
 *   2. 당일 파일이 gzip 인가 평문인가   ← 가장 중요. tail 전략이 여기서 갈린다
 *   3. 서명 URL 이 Range 에 206 으로 답하는가
 *   4. 새 로그 반영 지연 (여러 번 측정, 중앙값)
 *   5. logs?days=N 응답 스키마 실물
 *
 * 이 스크립트는 읽기 전용이다. 쓰기 API 를 부르지 않는다.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadConfig, type OrgConfig } from '../server/config/env.js';
import { ImsTokenCache } from '../server/adobe/ims.js';
import { CloudManagerClient, signedUrlExpiry, type LogOption } from '../server/adobe/cloudmanager.js';

/* ── 인자 ────────────────────────────────────────────── */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const SAMPLES = Number(arg('samples') ?? 5);
const SAMPLE_INTERVAL_MS = Number(arg('interval') ?? 5000);

/* ── 출력 누적 ───────────────────────────────────────── */

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

/** 서명 URL 전체는 기록하지 않는다. 호스트와 경로 모양만 남긴다. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.keys()].sort();
    return `${u.origin}${u.pathname}?<${params.join(', ')}>`;
  } catch {
    return '<파싱 불가>';
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** 값은 지우고 구조만 남긴다. 로그 본문·자격증명이 findings.md 에 새지 않게. */
function shape(v: unknown, depth = 0): unknown {
  if (depth > 4) return '…';
  if (Array.isArray(v)) return v.length === 0 ? [] : [shape(v[0], depth + 1), `…(${v.length}건)`];
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = shape(val, depth + 1);
    return o;
  }
  return typeof v;
}

/* ── 본체 ────────────────────────────────────────────── */

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

  say(`# Phase 0 검증 결과`);
  say();
  say(`- 실행 시각: ${iso(Date.now())}`);
  say(`- 대상 조직: \`${org.key}\` (${org.label})`);
  say(`- 표본 수: ${SAMPLES}, 폴링 간격: ${SAMPLE_INTERVAL_MS}ms`);

  /* 0. IMS 토큰 */
  section('0. IMS 토큰');
  const t0 = Date.now();
  await ims.getToken(org);
  say(`- OK. 발급 소요 ${Date.now() - t0}ms (토큰 값은 기록하지 않는다)`);

  /* 대상 환경 고르기 */
  const programId = arg('program') ?? (await pickProgram(cm, org));
  const { environmentId, environmentType } = await pickEnvironment(cm, org, programId, arg('env'));
  say(`- 대상: program=${programId} environment=${environmentId} (${environmentType})`);

  /* 5. logs?days=N 응답 스키마 */
  section('5. `logs?days=1` 응답 스키마 실물');
  const rawLogs = await rawJson(cm, org, `/api/program/${programId}/environment/${environmentId}/logs?days=1`);
  say('```json');
  say(JSON.stringify(shape(rawLogs), null, 2));
  say('```');

  const options = await cm.listLogOptions(org, programId, environmentId, 1);
  say();
  say('파싱된 옵션:');
  say('```');
  for (const o of options) say(`  service=${o.service} name=${o.name} date=${o.date ?? '-'}`);
  if (options.length === 0) say('  (없음)');
  say('```');

  const wantService = arg('service');
  const wantName = arg('name') ?? 'aemerror';
  const target = pickLogOption(options, wantService, arg('name'));
  if (!target) {
    say();
    say(`> **대상을 못 골랐다.** service=\`${wantService ?? '(지정 안 함)'}\` name=\`${wantName}\` 로 찾았다.`);
    say(`> 이 환경에 있는 조합: ${[...new Set(options.map((o) => `${o.service}/${o.name}`))].join(', ') || '(없음)'}`);
    say('>');
    say('> `--service` / `--name` 을 위 목록에 있는 값으로 지정해 다시 실행한다.');
    finish();
    return;
  }
  const date = target.date ?? new Date().toISOString().slice(0, 10);
  say();
  say(`선택: service=\`${target.service}\` name=\`${target.name}\` date=\`${date}\``);

  /* 1. 302 Location 만료 */
  section('1. 302 Location 서명 URL 의 만료 시간');
  const issuedAt = Date.now();
  const signed = await cm.getSignedLogUrl(org, programId, environmentId, target.service, target.name, date);

  // Phase 0b 에서 확인: tail 링크는 평문 파일을 가리키는, 이미 서명된 스토리지 URL 이다.
  // 실시간 tail 과 반영 지연 측정은 전부 이 URL 로 한다.
  let tailUrl: string | null = null;
  if (target.tailHref) {
    try {
      tailUrl = (await cm.resolveSignedUrl(org, target.tailHref)).url;
    } catch (err) {
      say(`- tail 링크 해석 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  say(`- URL 형태: \`${redactUrl(signed.url)}\``);
  if (signed.expiresAt !== undefined) {
    const ttlSec = Math.round((signed.expiresAt - issuedAt) / 1000);
    say(`- 만료: ${iso(signed.expiresAt)} → 발급 시점 기준 **약 ${ttlSec}초 (${(ttlSec / 60).toFixed(1)}분)**`);
    say(`- → 재발급 임계값은 이 값의 80% 지점을 쓴다.`);
  } else {
    say('- 쿼리스트링에서 만료 파라미터를 찾지 못했다. (`se`/`X-Amz-Expires` 둘 다 없음)');
    say('- → 만료를 예측할 수 없으므로 403/401 을 만나면 재발급하는 방식으로 간다.');
  }

  /* 2. gzip 여부 — 가장 중요 */
  section('2. 당일 파일이 gzip 인가 평문인가 ← 핵심');
  say('`logs?days=N` 응답에는 링크가 둘 있고 가리키는 파일이 다르다. 둘 다 본다.');
  say();
  say(`- download: \`${redactUrl(signed.url)}\``);
  say(`- tail:     ${tailUrl ? `\`${redactUrl(tailUrl)}\`` : '(없음)'}`);
  say();
  const head = await fetch(signed.url, { headers: { Range: 'bytes=0-1023' } });
  const cr = head.headers.get('content-range');
  const totalBytes = cr ? Number(cr.split('/')[1]) : Number(head.headers.get('content-length') ?? 0);
  const ce = head.headers.get('content-encoding');
  const ct = head.headers.get('content-type');
  const first = new Uint8Array(await head.arrayBuffer());
  const isGzipMagic = first.length >= 2 && first[0] === 0x1f && first[1] === 0x8b;
  const looksText = !isGzipMagic && isMostlyPrintable(first);

  say(`- HTTP ${head.status}`);
  say(`- \`Content-Type\`: ${ct ?? '(없음)'}`);
  say(`- \`Content-Encoding\`: ${ce ?? '(없음)'}`);
  say(`- \`Content-Range\`: ${cr ?? '(없음)'}  → 전체 크기 ${totalBytes.toLocaleString()} bytes`);
  say(`- 첫 2바이트: ${hex(first.slice(0, 2))} ${isGzipMagic ? '← gzip 매직(1f 8b)' : ''}`);
  say();
  if (isGzipMagic) {
    say('### download 링크는 **gzip 이다**');
    say();
    say('이 파일은 Range 로 부분 디코딩이 안 되므로 실시간 tail 에 쓰지 않는다.');
    say('하루치를 통째로 스트리밍하는 Phase 4 의 시간대 조회 전용이다.');
    say('실시간 tail 은 아래 2b 의 평문 파일을 쓴다.');
  } else if (looksText) {
    say('### 결론: **평문이다**');
    say();
    say('SPEC 6.3 의 Range 폴링 tail 알고리즘을 그대로 쓸 수 있다.');
    say('```');
    say(new TextDecoder().decode(first.slice(0, 200)).split('\n')[0] ?? '');
    say('```');
    say('(첫 라인 한 줄만 발췌. 로그 본문은 findings.md 에 남기지 않는다)');
  } else {
    say('### 결론: **판정 불가** — 텍스트도 gzip 매직도 아니다. 위 헤더를 보고 사람이 판단한다.');
  }

  /* 2b. tail 링크 (평문) */
  section('2b. tail 링크 — 실시간 tail 이 실제로 쓰는 파일');

  let tailSize = 0;
  let tailIsText = false;
  if (!tailUrl) {
    say('- tail 링크가 없다. 이 환경/로그는 실시간 tail 을 지원하지 않는다.');
  } else {
    const th = await fetch(tailUrl, { headers: { Range: 'bytes=0-2047' } });
    const tb = new Uint8Array(await th.arrayBuffer());
    const tcr = th.headers.get('content-range');
    tailSize = tcr ? Number(tcr.split('/')[1]) : Number(th.headers.get('content-length') ?? 0);
    const tGzip = tb.length >= 2 && tb[0] === 0x1f && tb[1] === 0x8b;
    tailIsText = !tGzip && isMostlyPrintable(tb);

    say(`- HTTP ${th.status}, \`Accept-Ranges\`: ${th.headers.get('accept-ranges') ?? '(없음)'}`);
    say(`- 첫 3바이트: ${hex(tb.slice(0, 3))} ${tGzip ? '← gzip' : ''}`);
    say(`- 전체 크기: **${tailSize.toLocaleString()} bytes** (압축본 ${totalBytes.toLocaleString()} bytes 대비 ${totalBytes > 0 ? (tailSize / totalBytes).toFixed(1) : '?'}배)`);
    say();
    say(tailIsText ? '### 평문이다 ✅ SPEC 6.3 을 그대로 쓴다' : '### 평문이 아니다 ⚠️ tail 전략을 다시 봐야 한다');
  }

  /* 3. Range → 206 */
  section('3. 서명 URL 의 Range 지원');
  say(`- \`Range: bytes=0-1023\` → HTTP **${head.status}** ${head.status === 206 ? '(206 Partial Content — 지원)' : '(206 아님)'}`);
  say(`- \`Accept-Ranges\`: ${head.headers.get('accept-ranges') ?? '(없음)'}`);

  if (totalBytes > 0) {
    const from = Math.max(0, totalBytes - 4096);
    const tailRes = await fetch(signed.url, { headers: { Range: `bytes=${from}-` } });
    say(`- 꼬리 \`Range: bytes=${from}-\` → HTTP **${tailRes.status}**, ${(await tailRes.arrayBuffer()).byteLength} bytes 수신`);

    const past = await fetch(signed.url, { headers: { Range: `bytes=${totalBytes}-` } });
    say(`- 파일 끝 너머 \`Range: bytes=${totalBytes}-\` → HTTP **${past.status}** ${past.status === 416 ? '(416 — 새 데이터 없음 판정에 쓸 수 있다)' : '(416 이 아니다. 새 데이터 없음 판정 방식을 다시 정해야 한다)'}`);
    await past.body?.cancel();
  }

  /* 4. 반영 지연 */
  section('4. 새 로그 반영 지연');
  say(`평문 tail 파일의 끝을 ${SAMPLE_INTERVAL_MS}ms 간격으로 ${SAMPLES}회 읽어, 새로 나타난 마지막 라인의 타임스탬프와 관측 시각의 차이를 잰다.`);
  say();
  if (!tailUrl || !tailIsText) {
    say('> 평문 tail URL 이 없어 잴 수 없다. 2b 절을 먼저 확인한다.');
  } else {
    const delays = await measureIngestDelay(tailUrl, tailSize);
    say('```');
    for (const [i, d] of delays.entries()) {
      const label =
        d.kind === 'no-data'
          ? '증가 없음 (flush 대기 중)'
          : d.kind === 'unparsed'
            ? `${d.bytes.toLocaleString()} bytes 받았으나 타임스탬프를 못 읽음 ← 파서 확인 필요`
            : `${(d.delayMs / 1000).toFixed(1)}초 지연 (${d.bytes.toLocaleString()} bytes)`;
      say(`  표본 ${i + 1}: ${label}`);
    }
    say('```');
    const ok = delays.filter((d): d is Extract<Sample, { kind: 'ok' }> => d.kind === 'ok').map((d) => d.delayMs);
    const grew = delays.filter((d) => d.kind !== 'no-data').length;
    say();
    say(`- 데이터가 온 폴링: ${grew}/${delays.length}회. 나머지는 flush 사이의 빈 구간이다.`);
    if (ok.length > 0) {
      say(`- **반영 지연 중앙값 ${(median(ok) / 1000).toFixed(1)}초** (표본 ${ok.length}건)`);
      say(`- 이 지연은 Adobe 쪽 파이프라인 지연이다. 폴링을 아무리 자주 해도 줄지 않는다.`);
    } else {
      say('- **측정 구간에 새 로그가 없었다.** 이 값은 지연이 아니라 "트래픽 없음"이다.');
      say('- 이 스크립트가 도는 동안 대상 환경에 요청을 보내야 한다.');
      say(`- aemerror 는 error.log 라 일반 요청으로는 조용할 수 있다. 오류를 유발하는 요청을 섞거나`);
      say('  `--interval 15000 --samples 10` 으로 창을 넓힌다.');
    }
  }

  finish();
}

function finish(): void {
  section('결정이 필요한 사항');
  say();
  say('- [x] tail 전략: `logs/tail` 의 평문 파일에 Range 폴링 (Phase 0b 에서 확정)');
  say('- [ ] 4번의 반영 지연 중앙값에 맞춰 `TAIL_POLL_INTERVAL_MS` 조정');

  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/findings.md', out.join('\n') + '\n', 'utf8');
  console.log('\n→ docs/findings.md 에 기록했다.');
}

/* ── 헬퍼 ────────────────────────────────────────────── */

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
}

function isMostlyPrintable(b: Uint8Array): boolean {
  let printable = 0;
  const n = Math.min(b.length, 512);
  for (let i = 0; i < n; i++) {
    const c = b[i]!;
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 128) printable++;
  }
  return n > 0 && printable / n > 0.9;
}

async function pickProgram(cm: CloudManagerClient, org: OrgConfig): Promise<string> {
  const programs = await cm.listPrograms(org);
  if (programs.length === 0) throw new Error('프로그램이 없다. 자격증명의 권한을 확인한다.');
  say(`- 프로그램 ${programs.length}개: ${programs.map((p) => `${p.id}(${p.name})`).join(', ')}`);
  return programs[0]!.id;
}

async function pickEnvironment(
  cm: CloudManagerClient,
  org: OrgConfig,
  programId: string,
  wanted: string | undefined,
): Promise<{ environmentId: string; environmentType: string }> {
  const envs = await cm.listEnvironments(org, programId);
  if (envs.length === 0) throw new Error(`program ${programId} 에 환경이 없다.`);
  say(`- 환경 ${envs.length}개: ${envs.map((e) => `${e.id}(${e.name}/${e.type})`).join(', ')}`);
  // prod 를 기본 대상으로 삼지 않는다. dev 를 우선한다.
  const chosen = wanted ? envs.find((e) => e.id === wanted) : (envs.find((e) => e.type === 'dev') ?? envs[0]);
  if (!chosen) throw new Error(`환경 ${wanted} 을 찾을 수 없다.`);
  return { environmentId: chosen.id, environmentType: chosen.type };
}

function pickLogOption(options: LogOption[], service?: string, name?: string): LogOption | undefined {
  const byName = options.filter((o) => (name ? o.name === name : o.name === 'aemerror'));
  const pool = byName.length > 0 ? byName : options;
  return service ? pool.find((o) => o.service === service) : pool[0];
}

/** CloudManagerClient 를 거치지 않고 원본 JSON 을 그대로 본다 (스키마 확인용). */
async function rawJson(cm: CloudManagerClient, org: OrgConfig, path: string): Promise<unknown> {
  // 클라이언트의 private request 를 쓰지 않고, 같은 헤더를 직접 구성한다.
  const ims = new ImsTokenCache();
  const token = await ims.getToken(org);
  const res = await fetch(`https://cloudmanager.adobe.io${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-gw-ims-org-id': org.imsOrgId,
      'x-api-key': org.clientId,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

const LINE_TS = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) /;

function parseLineTs(line: string): number | null {
  const m = LINE_TS.exec(line);
  if (!m) return null;
  const [, dd, MM, yyyy, hh, mm, ss, ms] = m;
  return Date.UTC(+yyyy!, +MM! - 1, +dd!, +hh!, +mm!, +ss!, +ms!);
}

type Sample =
  | { kind: 'no-data' }
  | { kind: 'unparsed'; bytes: number }
  | { kind: 'ok'; delayMs: number; bytes: number };

async function measureIngestDelay(url: string, startSize: number): Promise<Sample[]> {
  const delays: Sample[] = [];
  let offset = startSize;

  for (let i = 0; i < SAMPLES; i++) {
    await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL_MS));
    const res = await fetch(url, { headers: { Range: `bytes=${offset}-` } });
    const observedAt = Date.now();

    if (res.status === 416) {
      delays.push({ kind: 'no-data' });
      await res.body?.cancel();
      continue;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0) {
      delays.push({ kind: 'no-data' });
      continue;
    }
    offset += buf.byteLength;

    const lines = new TextDecoder().decode(buf).split('\n');
    let ts: number | null = null;
    for (let j = lines.length - 1; j >= 0 && ts === null; j--) ts = parseLineTs(lines[j]!);
    // 데이터는 왔는데 시각을 못 읽은 것과, 데이터 자체가 없는 것은 전혀 다른 상황이다.
    delays.push(ts === null ? { kind: 'unparsed', bytes: buf.byteLength } : { kind: 'ok', delayMs: observedAt - ts, bytes: buf.byteLength });
  }
  return delays;
}

main().catch((err) => {
  console.error(`\n[Phase 0 실패] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
