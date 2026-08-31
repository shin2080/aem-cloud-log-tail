import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { LogEntry } from '../../../shared/types.js';
import { EMPTY, sizeOf, upsertAll } from './logbuffer.js';

function entry(seq: number, over: Partial<LogEntry> = {}): LogEntry {
  return {
    seq,
    ts: 1_700_000_000_000 + seq,
    level: 'INFO',
    pod: '',
    thread: '',
    logger: 'test',
    message: `줄 ${seq}`,
    continuation: [],
    raw: `줄 ${seq}`,
    ...over,
  };
}

describe('화면 로그 버퍼 — upsert', () => {
  test('새 seq 는 뒤에 붙는다', () => {
    const b = upsertAll(EMPTY, [entry(0), entry(1)]);
    assert.deepEqual(
      b.entries.map((e) => e.seq),
      [0, 1],
    );
  });

  test('빈 배치는 같은 객체를 그대로 돌려준다', () => {
    const b = upsertAll(EMPTY, [entry(0)]);
    assert.equal(upsertAll(b, []), b);
  });

  /** 스택트레이스가 뒤늦게 오면 서버가 같은 seq 를 다시 보낸다 */
  test('마지막 엔트리의 개정은 갈아끼운다', () => {
    const b1 = upsertAll(EMPTY, [entry(0), entry(1)]);
    const b2 = upsertAll(b1, [entry(1, { continuation: ['at Foo.bar()'] })]);
    assert.equal(b2.entries.length, 2);
    assert.deepEqual(b2.entries[1]!.continuation, ['at Foo.bar()']);
  });

  test('중간 엔트리의 개정도 찾아서 갈아끼운다', () => {
    const b1 = upsertAll(EMPTY, [entry(0), entry(1), entry(2)]);
    const b2 = upsertAll(b1, [entry(1, { message: '고쳐짐' })]);
    assert.equal(b2.entries[1]!.message, '고쳐짐');
    assert.equal(b2.entries.length, 3);
  });

  test('이미 밀려난 seq 는 되살리지 않는다', () => {
    const b1 = upsertAll(EMPTY, [entry(5), entry(6)]);
    const b2 = upsertAll(b1, [entry(1)]);
    assert.deepEqual(
      b2.entries.map((e) => e.seq),
      [5, 6],
    );
  });
});

describe('화면 로그 버퍼 — 상한', () => {
  test('줄 수 상한을 넘으면 오래된 것부터 버린다', () => {
    const b = upsertAll(EMPTY, [0, 1, 2, 3, 4].map((n) => entry(n)), 3);
    assert.deepEqual(
      b.entries.map((e) => e.seq),
      [2, 3, 4],
    );
  });

  /**
   * 이게 이 파일의 존재 이유다. 줄 수만 보면 스택트레이스가 긴 로그에서
   * 창 하나가 수백 MB 를 먹는다 — 모니터에 며칠 걸어두면 탭이 죽는다.
   */
  test('줄 수가 남아 있어도 크기 상한을 넘으면 버린다', () => {
    const fat = (seq: number) => entry(seq, { raw: 'x'.repeat(1000), continuation: ['y'.repeat(1000)] });
    const b = upsertAll(EMPTY, [0, 1, 2, 3, 4, 5].map(fat), 1000, 4000);

    assert.ok(b.entries.length < 6, '크기 때문에 잘려야 한다');
    assert.ok(b.chars <= 4000, `상한 안에 들어와야 한다: ${b.chars}`);
    assert.equal(b.entries[b.entries.length - 1]!.seq, 5, '최신은 남아야 한다');
  });

  test('한 줄이 상한보다 커도 그 줄은 남긴다 — 화면이 비어버리면 안 된다', () => {
    const huge = entry(0, { raw: 'x'.repeat(10_000) });
    const b = upsertAll(EMPTY, [huge], 1000, 100);
    assert.equal(b.entries.length, 1);
  });

  test('chars 는 개정·트리밍을 거쳐도 실제 합과 맞는다', () => {
    let b = upsertAll(EMPTY, [entry(0), entry(1), entry(2)]);
    b = upsertAll(b, [entry(2, { continuation: ['a', 'b', 'c'] })]);
    b = upsertAll(b, [entry(3), entry(4)], 3);

    const actual = b.entries.reduce((n, e) => n + sizeOf(e), 0);
    assert.equal(b.chars, actual);
  });
});
