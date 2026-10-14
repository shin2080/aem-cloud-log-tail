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
    return '<unparseable>';
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
    console.error(`Organization '${orgKey}' is not in .env. Registered: ${[...cfg.orgs.keys()].join(', ')}`);
    process.exit(1);
  }

  const ims = new ImsTokenCache();
  const cm = new CloudManagerClient(ims);

  say('# Phase 0b — investigating the gzip tail strategy');
  say();
  say(`- Run at: ${new Date().toISOString()}`);
  say(`- Organization: \`${org.key}\``);

  const programId = arg('program') ?? (await cm.listPrograms(org))[0]!.id;
  const envs = await cm.listEnvironments(org, programId);
  const envId = arg('env') ?? (envs.find((e) => e.type === 'dev') ?? envs[0]!).id;
  const envType = envs.find((e) => e.id === envId)?.type ?? '?';
  say(`- Target: program=${programId} environment=${envId} (${envType})`);

  const options = await cm.listLogOptions(org, programId, envId, 1);
  const today = new Date().toISOString().slice(0, 10);
  const service = arg('service') ?? 'author';
  const name = arg('name') ?? 'aemerror';
  const target =
    options.find((o) => o.service === service && o.name === name && o.date === today) ??
    options.find((o) => o.service === service && o.name === name);

  if (!target) {
    say(`\n> No option found for service=${service} name=${name}.`);
    finish();
    return;
  }
  say(`- Selected: service=\`${target.service}\` name=\`${target.name}\` date=\`${target.date}\``);

  /* ── A. tail 링크 ─────────────────────────────────── */
  section('A. Investigating the `logs/tail` link ← if this works, neither (a) nor (b) is needed');

  if (!target.tailHref) {
    say('- This entry has no tail link. Moving on to B.');
  } else {
    say(`- tail href: \`${redactUrl(target.tailHref)}\``);
    say(`- Path: \`${(() => { try { return new URL(target.tailHref!).pathname; } catch { return target.tailHref!; } })()}\``);
    try {
      const signed = await cm.resolveSignedUrl(org, target.tailHref);
      say(`- Signed URL: \`${redactUrl(signed.url)}\``);
      say(`- Expires: ${signed.expiresAt ? new Date(signed.expiresAt).toISOString() : '(no parameter)'}`);

      const res = await fetch(signed.url, { headers: { Range: 'bytes=0-4095' } });
      const buf = new Uint8Array(await res.arrayBuffer());
      const cr = res.headers.get('content-range');
      const total = cr ? Number(cr.split('/')[1]) : buf.byteLength;
      const gz = isGzipStart(buf);

      say(`- HTTP ${res.status}, \`Content-Type\`: ${res.headers.get('content-type') ?? '-'}`);
      say(`- \`Content-Encoding\`: ${res.headers.get('content-encoding') ?? '(none)'}`);
      say(`- \`Content-Range\`: ${cr ?? '(none)'} → total ${total.toLocaleString()} bytes`);
      say(`- First 3 bytes: ${hex(buf.slice(0, 3))} ${gz ? '← gzip' : ''}`);

      const text = gz ? (gunzipPartial(buf) ?? '') : new TextDecoder().decode(buf);
      say();
      if (!gz && isLogText(text)) {
        say('### Conclusion: the tail link is **plaintext** ✅');
        say();
        say('Apply SPEC 6.3 Range polling to this URL as written. The gzip problem disappears.');
        say('The download link (.gz) is only for scanning a whole day in time-range search (Phase 4).');
      } else if (gz) {
        say('### The tail link is gzipped too. Whether B is multi-member decides it.');
      } else {
        say('### Inconclusive — neither plaintext nor log-shaped. Judge from the headers below.');
      }
      say('```');
      say(
        (text.split('\n').find((l) => l.trim().length > 0) ?? '(empty response)').slice(0, 160),
      );
      say('```');
      say('(first line only)');
    } catch (err) {
      say(`- Calling the tail link failed: ${err instanceof Error ? err.message : String(err)}`);
      say('- → Either insufficient permission or unsupported here. Decide from B.');
    }
  }

  /* ── B. 멀티멤버 gzip 여부 ────────────────────────── */
  section('B. Is the `.gz` multi-member ← if so, SPEC 6.3 survives nearly intact');

  const dl = target.downloadHref
    ? await cm.resolveSignedUrl(org, target.downloadHref)
    : await cm.getSignedLogUrl(org, programId, envId, target.service, target.name, target.date ?? today);

  const size = await sizeOf(dl.url);
  say(`- File size: ${size.toLocaleString()} bytes`);

  // 1) 파일 맨 앞이 gzip 인 건 Phase 0 에서 확인했다. 꼬리에도 멤버 경계가 있는지 본다.
  const tailWindow = Math.min(size, 512 * 1024);
  const tailRes = await fetch(dl.url, { headers: { Range: `bytes=${size - tailWindow}-` } });
  const tailBuf = new Uint8Array(await tailRes.arrayBuffer());
  say(`- Fetch the last ${tailWindow.toLocaleString()} bytes and look for member boundaries.`);

  const boundaries = findMemberBoundaries(tailBuf);
  say(`- Verified member start offsets: ${boundaries.length} ${boundaries.length > 0 ? `(relative positions in the window ${boundaries.slice(0, 8).join(', ')}${boundaries.length > 8 ? ' …' : ''})` : ''}`);

  say();
  if (boundaries.length > 0) {
    const last = boundaries[boundaries.length - 1]!;
    const decoded = gunzipPartial(tailBuf.subarray(last)) ?? '';
    const lines = decoded.split('\n').filter((l) => l.trim().length > 0);
    say('### Conclusion: **multi-member gzip** ✅');
    say();
    say(`Decompressed from the last member (file offset ${(size - tailWindow + last).toLocaleString()}) and read ${lines.length} lines.`);
    say(`Log-format check: ${isLogText(decoded) ? 'pass' : 'fail — needs a human'}`);
    say();
    say('If so, SPEC 6.3 needs only these adjustments:');
    say('```');
    say('  keep the offset in compressed bytes');
    say('  the delta from Range: bytes={offset}- is a run of complete members');
    say('  → pipe it straight to gunzip for plaintext lines (Node zlib handles concatenated members)');
    say('  → if the last member is truncated, leave those bytes for the next poll');
    say('```');
    say('Bandwidth matches the plaintext tail (less, in fact, by the compression ratio). Neither (a) nor (b) is needed.');
  } else {
    say('### Conclusion: **single-stream gzip** ⚠️');
    say();
    say('No member boundary found in the tail. A delta fetched by Range cannot be decompressed on its own.');
    say('Had the tail link in A not been plaintext, we would have to pick between (a) and (b) in SPEC section 11.');
  }

  /* ── C. 증가 속도 ─────────────────────────────────── */
  section('C. Growth rate — the cost if option (a), full re-download, were chosen');

  say(`Wait ${GROWTH_WAIT_MS / 1000}s and measure again.`);
  await new Promise((r) => setTimeout(r, GROWTH_WAIT_MS));
  const size2 = await sizeOf(dl.url);
  const grew = size2 - size;

  say('```');
  say(`  before: ${size.toLocaleString()} bytes`);
  say(`  after:  ${size2.toLocaleString()} bytes`);
  say(`  growth: ${grew.toLocaleString()} bytes / ${GROWTH_WAIT_MS / 1000}s`);
  say('```');

  if (grew > 0) {
    const perPoll = (grew / (GROWTH_WAIT_MS / 1000)) * (cfg.TAIL_POLL_INTERVAL_MS / 1000);
    say(`- With deltas, about **${Math.round(perPoll).toLocaleString()} bytes** per poll (${cfg.TAIL_POLL_INTERVAL_MS}ms)`);
    say(`- With full re-download (a), **${size2.toLocaleString()} bytes** per poll — ${Math.round(size2 / Math.max(perPoll, 1))}×`);
    say(`- Per day: (a) is about ${((size2 * (86400_000 / cfg.TAIL_POLL_INTERVAL_MS)) / 1024 ** 3).toFixed(1)} GB per session`);

    // 멀티멤버라면 실제로 델타가 독립 해제되는지 여기서 최종 확인한다.
    const deltaRes = await fetch(dl.url, { headers: { Range: `bytes=${size}-` } });
    const delta = new Uint8Array(await deltaRes.arrayBuffer());
    say();
    say(`- First 3 bytes of the growth: ${hex(delta.slice(0, 3))} ${isGzipStart(delta) ? '← starts a new member ✅' : '← not a member boundary'}`);
    if (isGzipStart(delta)) {
      const t = gunzipPartial(delta);
      say(`- Decompressing the growth alone: ${t !== null ? `ok, ${t.split('\n').filter((l) => l.trim()).length} lines` : 'failed'}`);
      if (t) say(`- Log-format check: ${isLogText(t) ? 'pass ✅' : 'fail'}`);
    }
  } else {
    say('- The file did not grow during the measurement. Rerun during a busier window or environment.');
    say(`- \`--wait 300000\` lengthens the wait.`);
  }

  finish();
}

function finish(): void {
  section('Decisions');
  say();
  say('- [ ] A is plaintext → go with the tail link. Cleanest option');
  say('- [ ] Not A but B is multi-member → SPEC 6.3 plus per-member decompression');
  say('- [ ] Neither → pick (a) or (b) from SPEC section 11, using the bandwidth numbers in C');

  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/findings-0b.md', out.join('\n') + '\n', 'utf8');
  console.log('\n→ Written to docs/findings-0b.md');
}

main().catch((err) => {
  console.error(`\n[Phase 0b failed] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
