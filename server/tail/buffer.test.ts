import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { LogEntry } from '../../shared/types.js';
import { RingBuffer, filterByLevel } from './buffer.js';

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

describe('RingBuffer — upsert', () => {
  test('새 seq 는 뒤에 붙는다', () => {
    const b = new RingBuffer(100, 1_000_000);
    b.upsert(entry(0));
    b.upsert(entry(1));
    assert.equal(b.size, 2);
    assert.equal(b.oldestSeq, 0);
    assert.equal(b.newestSeq, 1);
  });

  test('마지막 엔트리의 개정은 갈아끼우고 크기도 다시 센다', () => {
    const b = new RingBuffer(100, 1_000_000);
    b.upsert(entry(0));
    const before = b.byteSize;
    b.upsert(entry(0, { continuation: ['at Foo.bar()'] }));
    assert.equal(b.size, 1);
    assert.ok(b.byteSize > before, '스택이 붙었으면 커져야 한다');
  });

  test('이미 밀려난 seq 는 되살리지 않는다', () => {
    const b = new RingBuffer(2, 1_000_000);
    for (const n of [0, 1, 2]) b.upsert(entry(n));
    b.upsert(entry(0));
    assert.equal(b.size, 2);
    assert.equal(b.oldestSeq, 1);
  });
});

describe('RingBuffer — 축출', () => {
  test('줄 수 상한을 정확히 지킨다 (여유가 0인 작은 설정)', () => {
    const b = new RingBuffer(3, 1_000_000);
    for (let i = 0; i < 5; i++) b.upsert(entry(i));
    assert.equal(b.size, 3);
    assert.equal(b.oldestSeq, 2);
    assert.equal(b.droppedCount, 2);
  });

  test('크기 상한을 넘으면 줄 수가 남아 있어도 버린다', () => {
    const fat = (seq: number) => entry(seq, { raw: 'x'.repeat(1000) });
    const b = new RingBuffer(1000, 4000);
    for (let i = 0; i < 10; i++) b.upsert(fat(i));
    assert.ok(b.size < 10);
    assert.ok(b.byteSize <= 4000, `상한 안에 들어와야 한다: ${b.byteSize}`);
    assert.equal(b.newestSeq, 9, '최신은 남아야 한다');
  });

  test('한 줄이 상한보다 커도 그 줄은 남긴다 — 버퍼가 비어버리면 안 된다', () => {
    const b = new RingBuffer(100, 10);
    b.upsert(entry(0, { raw: 'x'.repeat(10_000) }));
    assert.equal(b.size, 1);
  });

  /**
   * 이게 이 파일의 존재 이유다.
   * 24시간 켜두면 '버퍼가 꽉 찬 상태' 가 정상이라, 상한에 딱 맞춰 자르면
   * 새 줄마다 배열 전체가 한 칸씩 밀린다. 여유를 두고 한 번에 잘라야 한다.
   */
  test('큰 설정에서는 여유를 두고 한 번에 잘라낸다', () => {
    const b = new RingBuffer(1000, 100_000_000);
    for (let i = 0; i < 1001; i++) b.upsert(entry(i));

    // 여유는 1000의 2% = 20. 상한이 아니라 그만큼 아래까지 잘랐어야 한다.
    assert.equal(b.size, 980);
    assert.equal(b.droppedCount, 21);

    // 그 뒤 20줄이 들어오는 동안에는 한 번도 자르지 않는다.
    for (let i = 1001; i < 1021; i++) b.upsert(entry(i));
    assert.equal(b.droppedCount, 21, '여유를 다 쓸 때까지는 축출이 없어야 한다');
    assert.equal(b.size, 1000);
  });

  test('밀려난 건수는 누적된다 — 사용자에게 알려야 하는 값이다', () => {
    const b = new RingBuffer(3, 1_000_000);
    for (let i = 0; i < 10; i++) b.upsert(entry(i));
    assert.equal(b.droppedCount, 7);
  });
});

describe('RingBuffer — 잘라내기', () => {
  test('seq 구간은 경계를 포함한다', () => {
    const b = new RingBuffer(100, 1_000_000);
    for (let i = 0; i < 5; i++) b.upsert(entry(i));
    assert.deepEqual(
      b.slice(1, 3).map((e) => e.seq),
      [1, 2, 3],
    );
  });

  test('clear 는 크기와 밀려난 건수까지 되돌린다', () => {
    const b = new RingBuffer(2, 1_000_000);
    for (let i = 0; i < 5; i++) b.upsert(entry(i));
    b.clear();
    assert.equal(b.size, 0);
    assert.equal(b.byteSize, 0);
    assert.equal(b.droppedCount, 0);
    assert.equal(b.oldestSeq, -1);
  });
});

describe('filterByLevel', () => {
  test('빈 목록이면 그대로 통과시킨다', () => {
    const all = [entry(0), entry(1, { level: 'ERROR' })];
    assert.equal(filterByLevel(all, null).length, 2);
    assert.equal(filterByLevel(all, []).length, 2);
  });

  test('고른 레벨만 남긴다', () => {
    const all = [entry(0), entry(1, { level: 'ERROR' }), entry(2, { level: 'WARN' })];
    assert.deepEqual(
      filterByLevel(all, ['ERROR', 'WARN']).map((e) => e.seq),
      [1, 2],
    );
  });
});
