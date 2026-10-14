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
    return '<unparseable>';
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
  if (Array.isArray(v)) return v.length === 0 ? [] : [shape(v[0], depth + 1), `…(${v.length} entries)`];
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
    console.error(`Organization '${orgKey}' is not in .env. Registered: ${[...cfg.orgs.keys()].join(', ')}`);
    process.exit(1);
  }

  const ims = new ImsTokenCache();
  const cm = new CloudManagerClient(ims);

  say(`# Phase 0 verification results`);
  say();
  say(`- Run at: ${iso(Date.now())}`);
  say(`- Organization: \`${org.key}\` (${org.label})`);
  say(`- Samples: ${SAMPLES}, polling interval: ${SAMPLE_INTERVAL_MS}ms`);

  /* 0. IMS 토큰 */
  section('0. IMS token');
  const t0 = Date.now();
  await ims.getToken(org);
  say(`- OK. Issued in ${Date.now() - t0}ms (the token value is never recorded)`);

  /* 대상 환경 고르기 */
  const programId = arg('program') ?? (await pickProgram(cm, org));
  const { environmentId, environmentType } = await pickEnvironment(cm, org, programId, arg('env'));
  say(`- Target: program=${programId} environment=${environmentId} (${environmentType})`);

  /* 5. logs?days=N 응답 스키마 */
  section('5. Real response schema of `logs?days=1`');
  const rawLogs = await rawJson(cm, org, `/api/program/${programId}/environment/${environmentId}/logs?days=1`);
  say('```json');
  say(JSON.stringify(shape(rawLogs), null, 2));
  say('```');

  const options = await cm.listLogOptions(org, programId, environmentId, 1);
  say();
  say('Parsed options:');
  say('```');
  for (const o of options) say(`  service=${o.service} name=${o.name} date=${o.date ?? '-'}`);
  if (options.length === 0) say('  (none)');
  say('```');

  const wantService = arg('service');
  const wantName = arg('name') ?? 'aemerror';
  const target = pickLogOption(options, wantService, arg('name'));
  if (!target) {
    say();
    say(`> **Could not pick a target.** Looked for service=\`${wantService ?? '(unspecified)'}\` name=\`${wantName}\`.`);
    say(`> Combinations available here: ${[...new Set(options.map((o) => `${o.service}/${o.name}`))].join(', ') || '(none)'}`);
    say('>');
    say('> Rerun with `--service` / `--name` set to one of the values above.');
    finish();
    return;
  }
  const date = target.date ?? new Date().toISOString().slice(0, 10);
  say();
  say(`Selected: service=\`${target.service}\` name=\`${target.name}\` date=\`${date}\``);

  /* 1. 302 Location 만료 */
  section('1. Expiry of the 302 Location signed URL');
  const issuedAt = Date.now();
  const signed = await cm.getSignedLogUrl(org, programId, environmentId, target.service, target.name, date);

  // Phase 0b 에서 확인: tail 링크는 평문 파일을 가리키는, 이미 서명된 스토리지 URL 이다.
  // 실시간 tail 과 반영 지연 측정은 전부 이 URL 로 한다.
  let tailUrl: string | null = null;
  if (target.tailHref) {
    try {
      tailUrl = (await cm.resolveSignedUrl(org, target.tailHref)).url;
    } catch (err) {
      say(`- Failed to resolve the tail link: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  say(`- URL shape: \`${redactUrl(signed.url)}\``);
  if (signed.expiresAt !== undefined) {
    const ttlSec = Math.round((signed.expiresAt - issuedAt) / 1000);
    say(`- Expires: ${iso(signed.expiresAt)} → **about ${ttlSec}s (${(ttlSec / 60).toFixed(1)} min)** from issue`);
    say(`- → Use 80% of that as the refresh threshold.`);
  } else {
    say('- No expiry parameter found in the query string (neither `se` nor `X-Amz-Expires`).');
    say('- → Expiry cannot be predicted, so refetch on a 403/401 instead.');
  }

  /* 2. gzip 여부 — 가장 중요 */
  section('2. Is the current day file gzipped or plaintext ← the key question');
  say('The `logs?days=N` response has two links pointing at different files. Check both.');
  say();
  say(`- download: \`${redactUrl(signed.url)}\``);
  say(`- tail:     ${tailUrl ? `\`${redactUrl(tailUrl)}\`` : '(none)'}`);
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
  say(`- \`Content-Type\`: ${ct ?? '(none)'}`);
  say(`- \`Content-Encoding\`: ${ce ?? '(none)'}`);
  say(`- \`Content-Range\`: ${cr ?? '(none)'}  → total size ${totalBytes.toLocaleString()} bytes`);
  say(`- First 2 bytes: ${hex(first.slice(0, 2))} ${isGzipMagic ? '← gzip magic (1f 8b)' : ''}`);
  say();
  if (isGzipMagic) {
    say('### The download link is **gzipped**');
    say();
    say('Range requests cannot partially decode this file, so it is not used for live tail.');
    say('It is only for Phase 4 time-range search, which streams a whole day.');
    say('Live tail uses the plaintext file in 2b below.');
  } else if (looksText) {
    say('### Conclusion: **plaintext**');
    say();
    say('The Range-polling tail algorithm in SPEC 6.3 applies as written.');
    say('```');
    say(new TextDecoder().decode(first.slice(0, 200)).split('\n')[0] ?? '');
    say('```');
    say('(One line only. Log bodies are never written to findings.md)');
  } else {
    say('### Conclusion: **inconclusive** — neither text nor gzip magic. Judge from the headers above.');
  }

  /* 2b. tail 링크 (평문) */
  section('2b. The tail link — the file live tail actually uses');

  let tailSize = 0;
  let tailIsText = false;
  if (!tailUrl) {
    say('- No tail link. This environment/log does not support live tail.');
  } else {
    const th = await fetch(tailUrl, { headers: { Range: 'bytes=0-2047' } });
    const tb = new Uint8Array(await th.arrayBuffer());
    const tcr = th.headers.get('content-range');
    tailSize = tcr ? Number(tcr.split('/')[1]) : Number(th.headers.get('content-length') ?? 0);
    const tGzip = tb.length >= 2 && tb[0] === 0x1f && tb[1] === 0x8b;
    tailIsText = !tGzip && isMostlyPrintable(tb);

    say(`- HTTP ${th.status}, \`Accept-Ranges\`: ${th.headers.get('accept-ranges') ?? '(none)'}`);
    say(`- First 3 bytes: ${hex(tb.slice(0, 3))} ${tGzip ? '← gzip' : ''}`);
    say(`- Total size: **${tailSize.toLocaleString()} bytes** (${totalBytes > 0 ? (tailSize / totalBytes).toFixed(1) : '?'}× the ${totalBytes.toLocaleString()}-byte compressed copy)`);
    say();
    say(tailIsText ? '### It is plaintext ✅ SPEC 6.3 applies as written' : '### Not plaintext ⚠️ the tail strategy needs rethinking');
  }

  /* 3. Range → 206 */
  section('3. Range support on the signed URL');
  say(`- \`Range: bytes=0-1023\` → HTTP **${head.status}** ${head.status === 206 ? '(206 Partial Content — supported)' : '(not 206)'}`);
  say(`- \`Accept-Ranges\`: ${head.headers.get('accept-ranges') ?? '(none)'}`);

  if (totalBytes > 0) {
    const from = Math.max(0, totalBytes - 4096);
    const tailRes = await fetch(signed.url, { headers: { Range: `bytes=${from}-` } });
    say(`- Tail \`Range: bytes=${from}-\` → HTTP **${tailRes.status}**, ${(await tailRes.arrayBuffer()).byteLength} bytes received`);

    const past = await fetch(signed.url, { headers: { Range: `bytes=${totalBytes}-` } });
    say(`- Past end of file \`Range: bytes=${totalBytes}-\` → HTTP **${past.status}** ${past.status === 416 ? '(416 — usable as the no-new-data signal)' : '(not 416. The no-new-data check needs rethinking)'}`);
    await past.body?.cancel();
  }

  /* 4. 반영 지연 */
  section('4. Delay before new logs appear');
  say(`Read the end of the plaintext tail file ${SAMPLES} times at ${SAMPLE_INTERVAL_MS}ms intervals and measure the gap between the newest line's timestamp and the observation time.`);
  say();
  if (!tailUrl || !tailIsText) {
    say('> No plaintext tail URL, so this cannot be measured. Check section 2b first.');
  } else {
    const delays = await measureIngestDelay(tailUrl, tailSize);
    say('```');
    for (const [i, d] of delays.entries()) {
      const label =
        d.kind === 'no-data'
          ? 'no growth (waiting for a flush)'
          : d.kind === 'unparsed'
            ? `received ${d.bytes.toLocaleString()} bytes but could not read a timestamp ← check the parser`
            : `${(d.delayMs / 1000).toFixed(1)}s delay (${d.bytes.toLocaleString()} bytes)`;
      say(`  sample ${i + 1}: ${label}`);
    }
    say('```');
    const ok = delays.filter((d): d is Extract<Sample, { kind: 'ok' }> => d.kind === 'ok').map((d) => d.delayMs);
    const grew = delays.filter((d) => d.kind !== 'no-data').length;
    say();
    say(`- Polls that returned data: ${grew}/${delays.length}. The rest fell between flushes.`);
    if (ok.length > 0) {
      say(`- **Median propagation delay ${(median(ok) / 1000).toFixed(1)}s** (${ok.length} samples)`);
      say(`- This is Adobe-side pipeline delay. Polling more often does not reduce it.`);
    } else {
      say('- **No new logs during the measurement.** This reflects no traffic, not a delay.');
      say('- Send requests to the target environment while this script runs.');
      say(`- aemerror is an error log, so ordinary requests may leave it silent. Mix in requests that cause errors, or`);
      say('  widen the window with `--interval 15000 --samples 10`.');
    }
  }

  finish();
}

function finish(): void {
  section('Decisions needed');
  say();
  say('- [x] Tail strategy: Range polling against the plaintext file from `logs/tail` (settled in Phase 0b)');
  say('- [ ] Tune `TAIL_POLL_INTERVAL_MS` to the median delay from section 4');

  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/findings.md', out.join('\n') + '\n', 'utf8');
  console.log('\n→ Written to docs/findings.md');
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
  say(`- ${programs.length} program(s): ${programs.map((p) => `${p.id}(${p.name})`).join(', ')}`);
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
  say(`- ${envs.length} environment(s): ${envs.map((e) => `${e.id}(${e.name}/${e.type})`).join(', ')}`);
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
  console.error(`\n[Phase 0 failed] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
