import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { LogEntry } from '../../shared/types.js';
import { Masker } from '../parse/mask.js';
import '../parse/register.js'; // 파서 등록
import { TailSession, utcDate, type TailEvent } from './session.js';
import type { RangeRead, ResolvedTail, TailTransport } from './transport.js';

const POD = 'cm-p12345-e987654-aem-author-54c7ddc56c-vf8vb';

function line(date: string, time: string, level = 'INFO', msg = 'hello'): string {
  const [y, m, d] = date.split('-');
  return `${d}.${m}.${y} ${time} [${POD}] *${level}* [qtp-1] com.adobe.cq.Foo ${msg}`;
}

/**
 * 날짜별 파일을 흉내내는 가짜 스토리지.
 * append() 로 로그가 자라고, readFrom() 이 Range 요청처럼 동작한다.
 */
class FakeTransport implements TailTransport {
  readonly files = new Map<string, string>();
  readonly urlCalls: string[] = [];
  readonly reads: { url: string; offset: number }[] = [];
  /** 특정 날짜의 tail URL 발급을 실패시킨다 */
  failUrlFor: string | null = null;
  /**
   * 다음 읽기부터 이 상태와 본문을 돌려준다 (서명 URL 만료 등).
   * null 이면 정상 동작으로 돌아간다.
   */
  errorResponse: { status: number; body: string } | null = null;

  append(date: string, text: string): void {
    this.files.set(date, (this.files.get(date) ?? '') + text);
  }

  /** 실제 transport 처럼, 원하는 날짜가 없으면 가장 최근 날짜로 대체한다. */
  async resolveTail(preferredDateUtc: string): Promise<ResolvedTail> {
    this.urlCalls.push(preferredDateUtc);
    if (this.failUrlFor === preferredDateUtc) throw new Error(`no tail link for ${preferredDateUtc}`);

    const available = [...this.files.keys()].sort();
    if (available.length === 0) throw new Error('tail 링크가 하나도 없다');
    const date = available.includes(preferredDateUtc) ? preferredDateUtc : available[available.length - 1]!;
    return { date, url: `https://blob.test/logs/aemerror_${date}.log` };
  }

  private dateOf(url: string): string {
    return url.replace(/^.*aemerror_/, '').replace(/\.log$/, '');
  }

  async sizeOf(url: string): Promise<number> {
    return Buffer.byteLength(this.files.get(this.dateOf(url)) ?? '', 'utf8');
  }

  async readFrom(url: string, offset: number): Promise<RangeRead> {
    this.reads.push({ url, offset });
    if (this.errorResponse) {
      const body = Buffer.from(this.errorResponse.body, 'utf8');
      return { status: this.errorResponse.status, bytes: new Uint8Array(body), totalSize: -1 };
    }
    const buf = Buffer.from(this.files.get(this.dateOf(url)) ?? '', 'utf8');
    if (offset >= buf.byteLength) return { status: 416, bytes: new Uint8Array(0), totalSize: buf.byteLength };
    const slice = buf.subarray(offset);
    return { status: 206, bytes: new Uint8Array(slice), totalSize: buf.byteLength };
  }
}

interface Harness {
  session: TailSession;
  transport: FakeTransport;
  events: TailEvent[];
  entries: () => Map<number, LogEntry>;
  setNow: (ms: number) => void;
}

function harness(startMs: number, over: Partial<Parameters<typeof makeOpts>[1]> = {}): Harness {
  const transport = new FakeTransport();
  let now = startMs;
  const events: TailEvent[] = [];

  const session = new TailSession({
    ...makeOpts(transport, over),
    now: () => now,
  });
  session.subscribe((e) => events.push(e));

  return {
    session,
    transport,
    events,
    setNow: (ms) => {
      now = ms;
    },
    entries: () => {
      const m = new Map<number, LogEntry>();
      for (const e of events) if (e.type === 'entries') for (const x of e.entries) m.set(x.seq, x);
      return m;
    },
  };
}

function makeOpts(
  transport: FakeTransport,
  over: { initialBytes?: number; maxLines?: number; maxBytes?: number; masking?: boolean } = {},
) {
  return {
    key: { orgKey: 'acme', environmentId: '987654', service: 'author', logName: 'aemerror' },
    transport,
    masker: new Masker(over.masking ?? false),
    pollIntervalMs: 1_000_000, // 실제 타이머는 테스트에서 돌지 않는다. pollOnce() 를 직접 부른다
    initialBytes: over.initialBytes ?? 256 * 1024,
    maxLines: over.maxLines ?? 50_000,
    maxBytes: over.maxBytes ?? 128 * 1024 * 1024,
  };
}

const T = (d: string, t: string) => Date.parse(`${d}T${t}Z`);

describe('utcDate', () => {
  test('UTC 기준으로 자른다 — KST 가 아니다', () => {
    // KST 2026-08-29 08:59 = UTC 2026-08-28 23:59 → 아직 어제 파일이다
    assert.equal(utcDate(T('2026-08-28', '23:59:59.999')), '2026-08-28');
    assert.equal(utcDate(T('2026-08-29', '00:00:00.000')), '2026-08-29');
  });
});

describe('TailSession — 최초 진입', () => {
  test('파일 전체를 받지 않는다. 끝에서 initialBytes 만 읽는다', async () => {
    const h = harness(T('2026-08-28', '12:00:00'), { initialBytes: 200 });
    // 넉넉히 큰 파일을 만든다
    for (let i = 0; i < 100; i++) h.transport.append('2026-08-28', line('2026-08-28', '10:00:00.000', 'INFO', `m${i}`) + '\n');
    const size = await h.transport.sizeOf('https://blob.test/logs/aemerror_2026-08-28.log');
    assert.ok(size > 10_000, '테스트 전제: 파일이 충분히 커야 한다');

    await h.session.start();

    const firstRead = h.transport.reads[0]!;
    assert.equal(firstRead.offset, size - 200, '파일 끝에서 initialBytes 만큼만 거슬러 읽어야 한다');
    assert.notEqual(firstRead.offset, 0, '0 부터 읽으면 180MB 를 통째로 받게 된다');
  });

  test('파일이 initialBytes 보다 작으면 처음부터 읽는다', async () => {
    const h = harness(T('2026-08-28', '12:00:00'), { initialBytes: 1_000_000 });
    h.transport.append('2026-08-28', line('2026-08-28', '10:00:00.000') + '\n');

    await h.session.start();
    assert.equal(h.transport.reads[0]!.offset, 0);
    assert.equal(h.entries().size, 1);
  });

  test('빈 파일에서도 터지지 않는다', async () => {
    const h = harness(T('2026-08-28', '12:00:00'));
    h.transport.append('2026-08-28', '');
    await h.session.start();
    assert.equal(h.session.bufferState.count, 0);
  });
});

describe('TailSession — Range 폴링', () => {
  test('새 데이터만 받아 offset 을 전진시킨다', async () => {
    const h = harness(T('2026-08-28', '12:00:00'), { initialBytes: 1_000_000 });
    h.transport.append('2026-08-28', line('2026-08-28', '12:00:00.000', 'INFO', 'first') + '\n');
    await h.session.start();
    const afterStart = h.session.byteOffset;

    const added = line('2026-08-28', '12:00:05.000', 'ERROR', 'second') + '\n';
    h.transport.append('2026-08-28', added);
    await h.session.pollOnce();

    assert.equal(h.session.byteOffset, afterStart + Buffer.byteLength(added, 'utf8'));
    const all = h.entries();
    assert.equal(all.size, 2);
    assert.equal(all.get(1)!.message, 'second');
    assert.equal(all.get(1)!.level, 'ERROR');
  });

  test('새 데이터가 없으면(416) 아무 일도 없다', async () => {
    const h = harness(T('2026-08-28', '12:00:00'), { initialBytes: 1_000_000 });
    h.transport.append('2026-08-28', line('2026-08-28', '12:00:00.000') + '\n');
    await h.session.start();

    const before = h.session.byteOffset;
    h.events.length = 0;
    await h.session.pollOnce();

    assert.equal(h.session.byteOffset, before);
    assert.deepEqual(h.events, []);
  });

  test('폴링 사이에 잘린 라인이 걸쳐도 복원한다', async () => {
    const h = harness(T('2026-08-28', '12:00:00'), { initialBytes: 1_000_000 });
    h.transport.append('2026-08-28', line('2026-08-28', '12:00:00.000') + '\n');
    await h.session.start();

    const full = line('2026-08-28', '12:00:05.000', 'ERROR', '잘린 메시지') + '\n';
    const cut = 30;
    h.transport.append('2026-08-28', full.slice(0, cut));
    await h.session.pollOnce();
    assert.equal(h.entries().size, 1, '아직 완성되지 않았다');

    h.transport.append('2026-08-28', full.slice(cut));
    await h.session.pollOnce();

    const all = h.entries();
    assert.equal(all.size, 2);
    assert.equal(all.get(1)!.message, '잘린 메시지');
  });

  test('스택트레이스가 폴링에 걸쳐 와도 한 엔트리로 묶인다', async () => {
    const h = harness(T('2026-08-28', '12:00:00'), { initialBytes: 1_000_000 });
    h.transport.append('2026-08-28', line('2026-08-28', '12:00:00.000', 'ERROR', '터짐') + '\n');
    await h.session.start();

    h.transport.append('2026-08-28', 'java.lang.NullPointerException\n');
    await h.session.pollOnce();
    h.transport.append('2026-08-28', '\tat com.adobe.cq.Foo.bar(Foo.java:42)\n');
    await h.session.pollOnce();

    const all = h.entries();
    assert.equal(all.size, 1, '엔트리는 하나여야 한다');
    assert.deepEqual(all.get(0)!.continuation, ['java.lang.NullPointerException', '\tat com.adobe.cq.Foo.bar(Foo.java:42)']);
  });
});

/**
 * SPEC 6.3: "UTC 자정 롤오버는 이 도구에서 가장 버그가 잘 나는 지점이다.
 *            한국 시간 오전 9시에 발생한다. 전용 테스트를 반드시 작성한다."
 */
describe('TailSession — UTC 자정 롤오버', () => {
  const D1 = '2026-08-28';
  const D2 = '2026-08-29';

  async function atMidnight(): Promise<Harness> {
    const h = harness(T(D1, '23:59:50'), { initialBytes: 1_000_000 });
    h.transport.append(D1, line(D1, '23:59:50.000', 'INFO', '자정 전') + '\n');
    await h.session.start();
    return h;
  }

  test('날짜가 바뀌면 새 파일로 전환하고 offset 을 0 으로 되돌린다', async () => {
    const h = await atMidnight();

    h.transport.append(D2, line(D2, '00:00:01.000', 'INFO', '자정 후') + '\n');
    h.setNow(T(D2, '00:00:05'));
    await h.session.pollOnce();

    assert.equal(h.session.date, D2);
    assert.ok(h.transport.urlCalls.includes(D2), '새 날짜의 tail URL 을 받아야 한다');

    const all = h.entries();
    assert.equal(all.size, 2);
    assert.equal(all.get(1)!.message, '자정 후');
  });

  test('자정 직전에 쓰인 로그를 흘리지 않는다 ← 여기가 핵심', async () => {
    const h = await atMidnight();

    // 마지막 폴링 이후 ~ 자정 사이에 쓰인 줄. 롤오버가 이걸 한 번 더 긁어가야 한다.
    h.transport.append(D1, line(D1, '23:59:59.900', 'ERROR', '자정 직전 마지막 줄') + '\n');
    h.transport.append(D2, line(D2, '00:00:01.000', 'INFO', '새 날 첫 줄') + '\n');

    h.setNow(T(D2, '00:00:05'));
    await h.session.pollOnce();

    const messages = [...h.entries().values()].map((e) => e.message);
    assert.ok(messages.includes('자정 직전 마지막 줄'), `이전 파일의 꼬리가 유실됐다: ${JSON.stringify(messages)}`);
    assert.ok(messages.includes('새 날 첫 줄'));
  });

  test('개행 없이 끝난 마지막 라인도 flush 되어 살아남는다', async () => {
    const h = await atMidnight();

    // 개행이 없다 -- 파서 안에 잔여로 남아 있는 상태
    h.transport.append(D1, line(D1, '23:59:59.950', 'ERROR', '개행 없는 마지막 줄'));
    h.transport.append(D2, line(D2, '00:00:01.000', 'INFO', '새 날 첫 줄') + '\n');
    h.setNow(T(D2, '00:00:05'));
    await h.session.pollOnce();

    const messages = [...h.entries().values()].map((e) => e.message);
    assert.ok(messages.includes('개행 없는 마지막 줄'), `flush 되지 않았다: ${JSON.stringify(messages)}`);
  });

  test('rollover 이벤트를 알린다', async () => {
    const h = await atMidnight();
    h.transport.append(D2, line(D2, '00:00:01.000', 'INFO', '새 날 첫 줄') + '\n');
    h.setNow(T(D2, '00:00:05'));
    await h.session.pollOnce();

    const ev = h.events.find((e) => e.type === 'rollover');
    assert.ok(ev, 'rollover 이벤트가 없다');
    assert.equal(ev.type === 'rollover' && ev.newDate, D2);
  });

  test('seq 는 날짜를 건너도 이어진다 — 범위 선택이 끊기면 안 된다', async () => {
    const h = await atMidnight();
    h.transport.append(D1, line(D1, '23:59:59.900', 'INFO', 'a') + '\n');
    h.transport.append(D2, [line(D2, '00:00:01.000', 'INFO', 'b'), line(D2, '00:00:02.000', 'INFO', 'c'), ''].join('\n'));

    h.setNow(T(D2, '00:00:05'));
    await h.session.pollOnce();

    const seqs = [...h.entries().keys()].sort((x, y) => x - y);
    assert.deepEqual(seqs, [0, 1, 2, 3], `seq 가 이어지지 않는다: ${seqs}`);
  });

  test('이전 파일의 스택트레이스가 새 날 첫 엔트리에 새지 않는다', async () => {
    const h = await atMidnight();
    h.transport.append(D1, 'java.lang.IllegalStateException\n');
    h.transport.append(D2, line(D2, '00:00:01.000', 'INFO', '새 날 첫 줄') + '\n');

    h.setNow(T(D2, '00:00:05'));
    await h.session.pollOnce();

    const all = [...h.entries().values()];
    const newDay = all.find((e) => e.message === '새 날 첫 줄')!;
    assert.deepEqual(newDay.continuation, [], '이전 파일의 스택이 새 엔트리에 붙었다');
    const prev = all.find((e) => e.message === '자정 전')!;
    assert.deepEqual(prev.continuation, ['java.lang.IllegalStateException']);
  });

  test('KST 오전 9시 = UTC 자정이라는 전제를 확인한다', async () => {
    // KST 2026-08-29 08:59:59 는 아직 UTC 2026-08-28 -> 롤오버가 일어나면 안 된다
    const h = await atMidnight();
    h.transport.append(D2, line(D2, '00:00:01.000', 'INFO', '새 날 첫 줄') + '\n');
    h.setNow(Date.parse('2026-08-29T08:59:59+09:00'));
    await h.session.pollOnce();
    assert.equal(h.session.date, D1, 'KST 오전 9시 전에는 롤오버하면 안 된다');

    // KST 09:00:01 = UTC 00:00:01 -> 롤오버한다
    h.setNow(Date.parse('2026-08-29T09:00:01+09:00'));
    await h.session.pollOnce();
    assert.equal(h.session.date, D2, 'KST 오전 9시에 롤오버해야 한다');
  });

  /**
   * 실제로 겪은 상황이다. UTC 자정(=KST 오전 9시)을 넘겼는데 Adobe 가 새 날짜 파일을
   * 아직 목록에 안 올렸다. "오늘 파일은 당연히 있다" 고 가정하면 tail 이 아예 안 열린다.
   */
  test('새 날짜 파일이 아직 없으면 이전 파일을 계속 따라간다', async () => {
    const h = await atMidnight(); // D1 만 존재한다
    h.transport.append(D1, line(D1, '23:59:59.900', 'INFO', '자정 직전') + '\n');

    h.setNow(T(D2, '00:00:05'));
    await h.session.pollOnce();

    assert.equal(h.session.date, D1, '없는 날짜로 넘어가버리면 안 된다');
    assert.equal(h.events.filter((e) => e.type === 'rollover').length, 0, '전환하지 않았으니 알리지도 않는다');
    assert.ok([...h.entries().values()].some((e) => e.message === '자정 직전'), '이전 파일은 계속 읽어야 한다');
  });

  /** currentDate 를 먼저 바꿔버리면 재시도를 안 해 옛 파일에 갇힌다 — 실제로 그랬다. */
  test('새 파일이 나중에 올라오면 그때 전환한다', async () => {
    const h = await atMidnight();
    h.setNow(T(D2, '00:00:05'));
    await h.session.pollOnce();
    assert.equal(h.session.date, D1, '전제: 아직 D2 가 없다');

    // Adobe 가 뒤늦게 새 날짜 파일을 올렸다
    h.transport.append(D2, line(D2, '00:05:00.000', 'ERROR', '새 날 첫 줄') + '\n');
    h.setNow(T(D2, '00:05:10')); // 재시도 간격(60초)을 넘긴다
    await h.session.pollOnce();

    assert.equal(h.session.date, D2, '파일이 생겼는데도 안 넘어가면 새 날 로그를 영영 못 본다');
    assert.ok([...h.entries().values()].some((e) => e.message === '새 날 첫 줄'));
  });

  test('새 파일을 기다리는 동안 목록을 매 폴링마다 부르지 않는다', async () => {
    const h = await atMidnight();
    h.setNow(T(D2, '00:00:05'));
    h.transport.urlCalls.length = 0;

    // 10초 간격으로 여러 번 폴링해도 재시도 간격(60초) 안이면 한 번만 물어본다
    for (let i = 0; i < 5; i++) {
      h.setNow(T(D2, '00:00:05') + i * 10_000);
      await h.session.pollOnce();
    }
    assert.equal(h.transport.urlCalls.length, 1, `Cloud Manager 를 ${h.transport.urlCalls.length}번 불렀다 — 레이트 리밋을 태운다`);
  });

  test('여러 날을 건너뛰어도 최신 날짜로 간다', async () => {
    const h = await atMidnight();
    h.transport.append('2026-08-31', line('2026-08-31', '00:00:01.000', 'INFO', '사흘 뒤') + '\n');
    h.setNow(T('2026-08-31', '00:00:05'));
    await h.session.pollOnce();

    assert.equal(h.session.date, '2026-08-31');
    assert.ok([...h.entries().values()].some((e) => e.message === '사흘 뒤'));
  });

  test('이전 파일 읽기가 실패해도 새 날짜로는 넘어간다', async () => {
    const h = await atMidnight();
    // 이전 파일 URL 을 죽인다
    const orig = h.transport.readFrom.bind(h.transport);
    let first = true;
    h.transport.readFrom = async (url, offset) => {
      if (first && url.includes(D1)) {
        first = false;
        throw new Error('signed url expired');
      }
      return orig(url, offset);
    };
    h.transport.append(D2, line(D2, '00:00:01.000', 'INFO', '새 날 첫 줄') + '\n');

    h.setNow(T(D2, '00:00:05'));
    await h.session.pollOnce();

    assert.equal(h.session.date, D2, '이전 파일 실패로 롤오버가 멈추면 안 된다');
    assert.ok([...h.entries().values()].some((e) => e.message === '새 날 첫 줄'));
  });
});

describe('TailSession — 링버퍼 넘침', () => {
  test('오래된 게 밀려나면 조용히 사라지지 않고 truncated 로 알린다', async () => {
    const h = harness(T('2026-08-28', '12:00:00'), { initialBytes: 1_000_000, maxLines: 3 });
    h.transport.append('2026-08-28', line('2026-08-28', '12:00:00.000', 'INFO', 'a') + '\n');
    await h.session.start();

    for (const m of ['b', 'c', 'd', 'e']) {
      h.transport.append('2026-08-28', line('2026-08-28', '12:00:01.000', 'INFO', m) + '\n');
      await h.session.pollOnce();
    }

    const trunc = h.events.filter((e) => e.type === 'truncated');
    assert.ok(trunc.length > 0, 'truncated 이벤트가 없다');
    assert.equal(h.session.bufferState.count, 3);
    assert.equal(h.session.bufferState.oldestSeq, 2, '오래된 것부터 밀려나야 한다');
  });
});

describe('TailSession — 마스킹', () => {
  test('마스킹은 버퍼에 들어가기 전에 끝난다 (내보내기에 원문이 나가면 안 된다)', async () => {
    const h = harness(T('2026-08-28', '12:00:00'), { initialBytes: 1_000_000, masking: true });
    h.transport.append(
      '2026-08-28',
      line('2026-08-28', '12:00:00.000', 'ERROR', 'auth failed for shin@example.com token=supersecret') + '\n',
    );
    await h.session.start();

    const stored = h.session.snapshot();
    assert.equal(stored.length, 1);
    const e = stored[0]!;

    assert.equal(e.masked, true, 'masked 배지가 서야 한다');
    assert.ok(!e.message.includes('supersecret'), '버퍼에 원문 토큰이 남아 있다');
    assert.ok(!e.raw.includes('supersecret'), 'raw 에 원문 토큰이 남아 있다');
    assert.ok(!e.raw.includes('shin@example.com'));
    assert.ok(e.message.includes('@example.com'), '도메인은 남아야 한다');
  });

  test('스택트레이스 안의 자격증명도 가린다', async () => {
    const h = harness(T('2026-08-28', '12:00:00'), { initialBytes: 1_000_000, masking: true });
    h.transport.append('2026-08-28', line('2026-08-28', '12:00:00.000', 'ERROR', '터짐') + '\n');
    await h.session.start();
    h.transport.append('2026-08-28', '\tat Foo.auth(Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdefgh)\n');
    await h.session.pollOnce();

    const e = h.session.snapshot()[0]!;
    assert.equal(e.masked, true);
    assert.ok(!e.continuation.join('\n').includes('eyJhbGciOiJIUzI1NiJ9abcdefgh'));
  });
});

describe('TailSession — 구독', () => {
  test('구독 해지 후에는 이벤트를 받지 않는다', async () => {
    const h = harness(T('2026-08-28', '12:00:00'), { initialBytes: 1_000_000 });
    h.transport.append('2026-08-28', line('2026-08-28', '12:00:00.000') + '\n');
    await h.session.start();

    const seen: TailEvent[] = [];
    const off = h.session.subscribe((e) => seen.push(e));
    assert.equal(h.session.subscriberCount, 2);

    off();
    assert.equal(h.session.subscriberCount, 1);
    h.transport.append('2026-08-28', line('2026-08-28', '12:00:01.000') + '\n');
    await h.session.pollOnce();
    assert.deepEqual(seen, []);
  });

  test('구독자 하나가 터져도 나머지는 계속 받는다', async () => {
    const h = harness(T('2026-08-28', '12:00:00'), { initialBytes: 1_000_000 });
    h.transport.append('2026-08-28', line('2026-08-28', '12:00:00.000') + '\n');
    await h.session.start();

    h.session.subscribe(() => {
      throw new Error('구독자 폭발');
    });
    const seen: TailEvent[] = [];
    h.session.subscribe((e) => seen.push(e));

    h.transport.append('2026-08-28', line('2026-08-28', '12:00:01.000') + '\n');
    await h.session.pollOnce();
    assert.ok(seen.length > 0);
  });
});

/**
 * 서명 URL 은 TTL 이 24시간이고, 예전에는 UTC 자정 롤오버에서만 다시 받았다.
 * 롤오버 간격이 최대 24시간이라 만료까지 여유가 사실상 0 이었다 —
 * 며칠씩 켜두는 쓰임에서는 언젠가 반드시 걸린다.
 */
describe('TailSession — 서명 URL 만료', () => {
  const AZURE_403 =
    '<?xml version="1.0" encoding="utf-8"?><Error><Code>AuthenticationFailed</Code>' +
    '<Message>Signature not valid in the specified time frame.</Message></Error>';

  test('403 본문을 로그로 먹지 않는다 ← 여기가 핵심', async () => {
    const h = harness(T('2026-08-28', '12:00:00'));
    h.transport.append('2026-08-28', line('2026-08-28', '12:00:00.000', 'INFO', '진짜 로그') + '\n');
    await h.session.start();

    const offsetBefore = h.session.byteOffset;
    h.transport.errorResponse = { status: 403, body: AZURE_403 };

    await assert.rejects(() => h.session.pollOnce(), '오류 응답은 던져야 한다');

    const texts = [...h.entries().values()].map((e) => e.raw).join('\n');
    assert.ok(!texts.includes('AuthenticationFailed'), '오류 XML 이 로그 줄로 들어왔다');
    assert.equal(h.session.byteOffset, offsetBefore, '오프셋이 오류 본문만큼 앞질렀다 — 그 뒤 로그를 영영 놓친다');
  });

  test('오류를 만나면 다음 폴링에서 URL 부터 다시 받는다', async () => {
    const h = harness(T('2026-08-28', '12:00:00'));
    h.transport.append('2026-08-28', line('2026-08-28', '12:00:00.000') + '\n');
    await h.session.start();

    const urlCallsBefore = h.transport.urlCalls.length;
    h.transport.errorResponse = { status: 403, body: AZURE_403 };
    await assert.rejects(() => h.session.pollOnce());

    // 스토리지가 정상으로 돌아왔다
    h.transport.errorResponse = null;
    h.transport.append('2026-08-28', line('2026-08-28', '12:00:30.000', 'INFO', '회복') + '\n');
    await h.session.pollOnce();

    assert.ok(h.transport.urlCalls.length > urlCallsBefore, 'URL 을 다시 받지 않았다');
    const texts = [...h.entries().values()].map((e) => e.message);
    assert.ok(texts.some((t) => t.includes('회복')), '회복 후 로그가 들어와야 한다');
  });

  test('오래된 URL 은 만료 전에 미리 다시 받는다', async () => {
    const h = harness(T('2026-08-28', '00:30:00'));
    h.transport.append('2026-08-28', line('2026-08-28', '00:30:00.000') + '\n');
    await h.session.start();

    const before = h.transport.urlCalls.length;
    await h.session.pollOnce();
    assert.equal(h.transport.urlCalls.length, before, '얼마 안 됐으면 다시 부르지 않는다');

    // 같은 UTC 날짜 안에서 두 시간이 지났다 (롤오버는 아직 멀었다)
    h.setNow(T('2026-08-28', '02:30:00'));
    await h.session.pollOnce();
    assert.ok(h.transport.urlCalls.length > before, '한 시간이 지나면 미리 받아둬야 한다');
    assert.equal(h.session.date, '2026-08-28', '날짜가 바뀌면 안 된다');
  });

  test('URL 을 다시 받아도 읽던 자리는 그대로다', async () => {
    const h = harness(T('2026-08-28', '00:30:00'));
    h.transport.append('2026-08-28', line('2026-08-28', '00:30:00.000') + '\n');
    await h.session.start();
    const offset = h.session.byteOffset;

    h.setNow(T('2026-08-28', '02:30:00'));
    await h.session.pollOnce();
    assert.equal(h.session.byteOffset, offset, '같은 파일의 같은 자리를 계속 읽어야 한다');
  });
});
