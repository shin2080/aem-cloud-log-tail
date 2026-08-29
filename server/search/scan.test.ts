import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import type { LogEntry } from '../../shared/types.js';
import { Masker } from '../parse/mask.js';
import '../parse/register.js';
import { CloudManagerClient } from '../adobe/cloudmanager.js';
import { ImsTokenCache } from '../adobe/ims.js';
import type { OrgConfig } from '../config/env.js';
import { runScan, buildMatcher, ScanError } from './scan.js';

const POD = 'cm-p1-e2-aem-author-abc';

function line(iso: string, level: string, msg: string): string {
  const d = new Date(`${iso}Z`);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(
    d.getUTCMinutes(),
  )}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)} [${POD}] *${level}* [qtp-1] com.adobe.cq.Foo ${msg}`;
}

const org: OrgConfig = {
  key: 'acme',
  label: 'ACME',
  imsOrgId: 'A@AdobeOrg',
  clientId: 'c',
  clientSecret: 's',
  scopes: 'openid',
};

/** 날짜별 gzip 파일을 내려주는 가짜 Cloud Manager + 스토리지 */
function fakeCm(files: Record<string, string>) {
  const gz = new Map<string, Buffer>();
  for (const [date, text] of Object.entries(files)) gz.set(date, gzipSync(Buffer.from(text, 'utf8')));

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);

    if (url.includes('ims')) {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.startsWith('https://cloudmanager.adobe.io')) {
      const date = new URL(url, 'https://x').searchParams.get('date')!;
      return new Response(null, { status: 302, headers: { location: `https://blob.test/${date}.gz` } });
    }

    const date = url.replace('https://blob.test/', '').replace('.gz', '');
    const buf = gz.get(date);
    if (!buf) return new Response('missing', { status: 404 });

    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    if (range === 'bytes=0-0') {
      return new Response(buf.subarray(0, 1), {
        status: 206,
        headers: { 'Content-Range': `bytes 0-0/${buf.length}` },
      });
    }
    return new Response(new Uint8Array(buf), { status: 200 });
  };

  const ims = new ImsTokenCache(() => Date.now(), fetchImpl);
  return { cm: new CloudManagerClient(ims, fetchImpl), fetchImpl };
}

interface RunOut {
  entries: LogEntry[];
  progress: { scanned: number; total: number; matched: number }[];
  matched: number;
  truncated: boolean;
  skippedDates: string[];
  missingDates: string[];
}

async function run(
  files: Record<string, string>,
  over: Partial<Parameters<typeof runScan>[1]> = {},
  maxLines = 100_000,
): Promise<RunOut> {
  const { cm, fetchImpl } = fakeCm(files);
  const entries: LogEntry[] = [];
  const progress: RunOut['progress'] = [];

  const res = await runScan(
    { cm, masker: new Masker(false), maxResultLines: maxLines, fetchImpl },
    {
      org,
      programId: '1',
      environmentId: '2',
      service: 'author',
      logName: 'aemerror',
      from: Date.parse('2026-08-28T00:00:00Z'),
      to: Date.parse('2026-08-28T23:59:59Z'),
      levels: [],
      ...over,
    },
    {
      onEntries: (e) => entries.push(...e),
      onProgress: (scanned, total, matched) => progress.push({ scanned, total, matched }),
    },
    new AbortController().signal,
  );

  return { entries, progress, ...res };
}

/** 보존 기간 검사를 통과하도록 '오늘' 근처 날짜를 쓴다 */
const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const dayMs = (d: string, h: number, m = 0): number => Date.parse(`${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);

describe('runScan — 기본', () => {
  test('gzip 파일을 풀어 파싱한다', async () => {
    const text = [
      line(`${TODAY}T10:00:00.000`, 'INFO', 'a'),
      line(`${TODAY}T10:00:01.000`, 'ERROR', 'b'),
      '',
    ].join('\n');

    const out = await run({ [TODAY]: text }, { from: dayMs(TODAY, 0), to: dayMs(TODAY, 23) });
    assert.equal(out.matched, 2);
    assert.deepEqual(out.entries.map((e) => e.message), ['a', 'b']);
  });

  test('레벨로 거른다 — 기본 용도가 ERROR 조회다', async () => {
    const text = [
      line(`${TODAY}T10:00:00.000`, 'INFO', 'a'),
      line(`${TODAY}T10:00:01.000`, 'ERROR', 'b'),
      line(`${TODAY}T10:00:02.000`, 'WARN', 'c'),
      '',
    ].join('\n');

    const out = await run({ [TODAY]: text }, { from: dayMs(TODAY, 0), to: dayMs(TODAY, 23), levels: ['ERROR'] });
    assert.equal(out.matched, 1);
    assert.equal(out.entries[0]!.message, 'b');
  });

  /** 파일은 하루치인데 요청 구간은 그 일부다. 밖은 잘라야 한다. */
  test('구간 밖의 줄을 잘라낸다', async () => {
    const text = [
      line(`${TODAY}T08:00:00.000`, 'ERROR', '너무 이르다'),
      line(`${TODAY}T12:00:00.000`, 'ERROR', '구간 안'),
      line(`${TODAY}T20:00:00.000`, 'ERROR', '너무 늦다'),
      '',
    ].join('\n');

    const out = await run({ [TODAY]: text }, { from: dayMs(TODAY, 10), to: dayMs(TODAY, 14), levels: ['ERROR'] });
    assert.equal(out.matched, 1);
    assert.equal(out.entries[0]!.message, '구간 안');
  });

  test('스택트레이스를 한 엔트리로 묶는다', async () => {
    const text = [
      line(`${TODAY}T12:00:00.000`, 'ERROR', '터짐'),
      'java.lang.NullPointerException',
      '\tat com.adobe.cq.Foo.bar(Foo.java:42)',
      '',
    ].join('\n');

    const out = await run({ [TODAY]: text }, { from: dayMs(TODAY, 0), to: dayMs(TODAY, 23), levels: ['ERROR'] });
    assert.equal(out.matched, 1);
    assert.deepEqual(out.entries[0]!.continuation, ['java.lang.NullPointerException', '\tat com.adobe.cq.Foo.bar(Foo.java:42)']);
  });

  test('여러 날짜 파일을 순서대로 훑고 seq 를 이어붙인다', async () => {
    const out = await run(
      {
        [YESTERDAY]: line(`${YESTERDAY}T23:00:00.000`, 'ERROR', '어제') + '\n',
        [TODAY]: line(`${TODAY}T01:00:00.000`, 'ERROR', '오늘') + '\n',
      },
      { from: dayMs(YESTERDAY, 22), to: dayMs(TODAY, 2), levels: ['ERROR'] },
    );
    assert.deepEqual(out.entries.map((e) => e.message), ['어제', '오늘']);
    assert.deepEqual(out.entries.map((e) => e.seq), [0, 1], 'seq 가 날짜를 건너 이어져야 범위 선택이 된다');
  });
});

describe('runScan — 검색어', () => {
  const text = [
    line(`${TODAY}T12:00:00.000`, 'ERROR', 'NullPointerException 발생'),
    line(`${TODAY}T12:00:01.000`, 'ERROR', '정상 처리'),
    '',
  ].join('\n');

  test('부분 문자열로 거른다 (대소문자 무시)', async () => {
    const out = await run({ [TODAY]: text }, { from: dayMs(TODAY, 0), to: dayMs(TODAY, 23), query: 'nullpointer' });
    assert.equal(out.matched, 1);
  });

  test('정규식으로 거른다', async () => {
    const out = await run(
      { [TODAY]: text },
      { from: dayMs(TODAY, 0), to: dayMs(TODAY, 23), query: 'Null.*Exception', regex: true },
    );
    assert.equal(out.matched, 1);
  });

  test('스택트레이스 안의 문자열도 찾는다', async () => {
    const withStack = [
      line(`${TODAY}T12:00:00.000`, 'ERROR', '터짐'),
      '\tat com.adobe.cq.Payment.charge(Payment.java:9)',
      '',
    ].join('\n');
    const out = await run({ [TODAY]: withStack }, { from: dayMs(TODAY, 0), to: dayMs(TODAY, 23), query: 'Payment.java' });
    assert.equal(out.matched, 1);
  });

  test('잘못된 정규식은 명확히 거부한다', () => {
    assert.throws(() => buildMatcher('([', true), (e: unknown) => e instanceof ScanError && e.code === 'invalid_regex');
  });
});

describe('runScan — 상한과 진행률', () => {
  test('SEARCH_MAX_RESULT_LINES 에 닿으면 멈추고 truncated 를 알린다', async () => {
    let text = '';
    for (let i = 0; i < 50; i++) text += line(`${TODAY}T12:00:00.000`, 'ERROR', `m${i}`) + '\n';

    const out = await run({ [TODAY]: text }, { from: dayMs(TODAY, 0), to: dayMs(TODAY, 23), levels: ['ERROR'] }, 10);
    assert.equal(out.truncated, true);
    assert.equal(out.matched, 10);
    assert.equal(out.entries.length, 10);
  });

  test('상한에 안 닿으면 truncated 가 서지 않는다', async () => {
    const out = await run({ [TODAY]: line(`${TODAY}T12:00:00.000`, 'ERROR', 'x') + '\n' }, { from: dayMs(TODAY, 0), to: dayMs(TODAY, 23) }, 10);
    assert.equal(out.truncated, false);
  });

  test('진행률에 전체 크기가 실린다', async () => {
    const out = await run({ [TODAY]: line(`${TODAY}T12:00:00.000`, 'INFO', 'x') + '\n' }, { from: dayMs(TODAY, 0), to: dayMs(TODAY, 23) });
    assert.ok(out.progress.length > 0);
    assert.ok(out.progress[0]!.total > 0, '분모가 있어야 진행률 바를 그린다');
    assert.ok(out.progress[out.progress.length - 1]!.scanned > 0);
  });
});

describe('runScan — 경계 상황', () => {
  test('보존 기간이 지난 구간은 요청하지 않고 거부한다', async () => {
    await assert.rejects(
      () => run({}, { from: Date.parse('2020-01-01T00:00:00Z'), to: Date.parse('2020-01-02T00:00:00Z') }),
      (e: unknown) => e instanceof ScanError && e.code === 'out_of_retention',
    );
  });

  test('구간 일부만 보존 밖이면 남은 날짜만 훑고 건너뛴 날짜를 알린다', async () => {
    const out = await run(
      { [TODAY]: line(`${TODAY}T12:00:00.000`, 'ERROR', 'x') + '\n' },
      { from: Date.parse('2020-01-01T00:00:00Z'), to: dayMs(TODAY, 23), levels: ['ERROR'] },
    );
    assert.equal(out.matched, 1);
    assert.ok(out.skippedDates.length > 0, '건너뛴 날짜를 조용히 감추면 안 된다');
  });

  test('to 가 from 보다 앞이면 거부한다', async () => {
    await assert.rejects(
      () => run({}, { from: dayMs(TODAY, 15), to: dayMs(TODAY, 10) }),
      (e: unknown) => e instanceof ScanError && e.code === 'invalid_range',
    );
  });

  /** 하루가 비었다고 조회 전체를 실패시키면 나머지 날짜의 결과까지 잃는다. */
  test('그날 파일이 없어도 나머지 날짜는 계속 훑고, 빈 날짜를 알려준다', async () => {
    const out = await run(
      { [TODAY]: line(`${TODAY}T01:00:00.000`, 'ERROR', '오늘만 있다') + '\n' },
      { from: dayMs(YESTERDAY, 22), to: dayMs(TODAY, 2), levels: ['ERROR'] },
    );
    assert.equal(out.matched, 1, '어제 파일이 없다고 오늘 결과까지 잃으면 안 된다');
    assert.deepEqual(out.missingDates, [YESTERDAY]);
  });

  test('구간의 모든 날짜에 파일이 없으면 그때는 명확히 실패한다', async () => {
    await assert.rejects(
      () => run({}, { from: dayMs(TODAY, 0), to: dayMs(TODAY, 23) }),
      (e: unknown) => e instanceof ScanError && e.code === 'no_logs',
    );
  });

  test('취소하면 즉시 멈춘다', async () => {
    let text = '';
    for (let i = 0; i < 5000; i++) text += line(`${TODAY}T12:00:00.000`, 'ERROR', `m${i}`) + '\n';

    const { cm, fetchImpl } = fakeCm({ [TODAY]: text });
    const ac = new AbortController();
    const entries: LogEntry[] = [];

    const p = runScan(
      { cm, masker: new Masker(false), maxResultLines: 100_000, fetchImpl },
      {
        org,
        programId: '1',
        environmentId: '2',
        service: 'author',
        logName: 'aemerror',
        from: dayMs(TODAY, 0),
        to: dayMs(TODAY, 23),
        levels: ['ERROR'],
      },
      { onEntries: (e) => entries.push(...e), onProgress: () => ac.abort() },
      ac.signal,
    );

    const res = await p;
    assert.ok(res.matched < 5000, `취소했는데 끝까지 갔다: ${res.matched}`);
  });
});

describe('runScan — 마스킹', () => {
  test('결과가 만들어지는 시점에 가려진다 (내보내기에 원문이 나가면 안 된다)', async () => {
    const text = line(`${TODAY}T12:00:00.000`, 'ERROR', 'user shin@example.com token=supersecret') + '\n';
    const { cm, fetchImpl } = fakeCm({ [TODAY]: text });
    const entries: LogEntry[] = [];

    await runScan(
      { cm, masker: new Masker(true), maxResultLines: 100_000, fetchImpl },
      {
        org,
        programId: '1',
        environmentId: '2',
        service: 'author',
        logName: 'aemerror',
        from: dayMs(TODAY, 0),
        to: dayMs(TODAY, 23),
        levels: ['ERROR'],
      },
      { onEntries: (e) => entries.push(...e), onProgress: () => {} },
      new AbortController().signal,
    );

    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.masked, true);
    assert.ok(!entries[0]!.raw.includes('supersecret'));
    assert.ok(!entries[0]!.raw.includes('shin@example.com'));
  });
});
