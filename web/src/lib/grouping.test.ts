import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { LogEntry } from '../../../shared/types.js';
import { groupEntries, signatureOf, collapsedCount } from './grouping.js';

let seq = 0;
const e = (over: Partial<LogEntry> = {}): LogEntry => ({
  seq: seq++,
  ts: Date.parse('2026-08-29T00:00:00Z'),
  level: 'ERROR',
  pod: 'pod-a',
  thread: 'qtp-1',
  logger: 'com.adobe.cq.Foo',
  message: '터졌다',
  continuation: [],
  raw: 'raw',
  ...over,
});

describe('signatureOf', () => {
  test('숫자가 달라도 같은 사건으로 본다', () => {
    assert.equal(
      signatureOf(e({ message: '느린 쿼리 205ms' })),
      signatureOf(e({ message: '느린 쿼리 4210ms' })),
    );
  });

  test('UUID 가 달라도 같은 사건으로 본다', () => {
    assert.equal(
      signatureOf(e({ message: 'job 4d2a7f3b-23e6-48d2-8b8c-dd2dc665f457 실패' })),
      signatureOf(e({ message: 'job 99999999-1111-2222-3333-444444444444 실패' })),
    );
  });

  test('로거가 다르면 다른 사건이다', () => {
    assert.notEqual(signatureOf(e({ logger: 'com.a.X' })), signatureOf(e({ logger: 'com.b.Y' })));
  });

  test('레벨이 다르면 다른 사건이다', () => {
    assert.notEqual(signatureOf(e({ level: 'ERROR' })), signatureOf(e({ level: 'WARN' })));
  });

  /** 같은 메시지라도 다른 곳에서 터진 예외는 다른 문제다. */
  test('스택트레이스가 다르면 다른 사건이다', () => {
    assert.notEqual(
      signatureOf(e({ continuation: ['java.lang.NPE', '\tat com.a.X.f(X.java:1)'] })),
      signatureOf(e({ continuation: ['java.lang.NPE', '\tat com.b.Y.g(Y.java:9)'] })),
    );
  });

  test('스택의 줄 번호만 다르면 같은 사건이다', () => {
    assert.equal(
      signatureOf(e({ continuation: ['java.lang.NPE', '\tat com.a.X.f(X.java:11)'] })),
      signatureOf(e({ continuation: ['java.lang.NPE', '\tat com.a.X.f(X.java:12)'] })),
    );
  });

  test('메시지가 다르면 다른 사건이다', () => {
    assert.notEqual(signatureOf(e({ message: '터졌다' })), signatureOf(e({ message: '괜찮다' })));
  });
});

describe('groupEntries', () => {
  const T = (s: string) => Date.parse(`2026-08-29T${s}Z`);

  test('같은 사건을 하나로 묶고 개수를 센다', () => {
    const out = groupEntries([
      e({ ts: T('00:00:01'), message: '느린 쿼리 100ms' }),
      e({ ts: T('00:00:02'), message: '느린 쿼리 200ms' }),
      e({ ts: T('00:00:03'), message: '느린 쿼리 300ms' }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.count, 3);
  });

  /** 실제 로그에서는 같은 예외가 다른 줄과 섞여 반복된다. 연속만 묶으면 놓친다. */
  test('연속이 아니어도 묶는다', () => {
    const out = groupEntries([
      e({ ts: T('00:00:01'), message: 'NPE' }),
      e({ ts: T('00:00:02'), message: '정상 처리' }),
      e({ ts: T('00:00:03'), message: 'NPE' }),
      e({ ts: T('00:00:04'), message: '정상 처리' }),
      e({ ts: T('00:00:05'), message: 'NPE' }),
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((g) => g.count).sort(), [2, 3]);
  });

  test('대표는 가장 최근 것이다 — 지금 무슨 일이 나는지가 궁금하다', () => {
    const out = groupEntries([
      e({ ts: T('00:00:01'), message: '느린 쿼리 100ms' }),
      e({ ts: T('00:00:09'), message: '느린 쿼리 900ms' }),
    ]);
    assert.equal(out[0]!.entry.message, '느린 쿼리 900ms');
    assert.equal(out[0]!.firstTs, T('00:00:01'));
  });

  test('시간순을 유지한다 — 뷰어가 흐르는 화면이라 감각이 어긋나면 안 된다', () => {
    const out = groupEntries([
      e({ ts: T('00:00:05'), logger: 'c.B', message: 'b' }),
      e({ ts: T('00:00:01'), logger: 'c.A', message: 'a' }),
      e({ ts: T('00:00:09'), logger: 'c.C', message: 'c' }),
    ]);
    assert.deepEqual(out.map((g) => g.entry.message), ['a', 'b', 'c']);
  });

  test('묶인 것들의 seq 를 전부 들고 있다 — 내보낼 때 필요하다', () => {
    const a = e({ ts: T('00:00:01'), message: 'x 1' });
    const b = e({ ts: T('00:00:02'), message: 'x 2' });
    const out = groupEntries([a, b]);
    assert.deepEqual(out[0]!.seqs.sort((x, y) => x - y), [a.seq, b.seq].sort((x, y) => x - y));
  });

  test('묶을 게 없으면 그대로 둔다', () => {
    const input = [e({ message: 'a' }), e({ message: 'b' }), e({ message: 'c' })];
    const out = groupEntries(input);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((g) => g.count), [1, 1, 1]);
    assert.equal(collapsedCount(input, out), 0);
  });

  test('빈 입력에 던지지 않는다', () => {
    assert.deepEqual(groupEntries([]), []);
  });

  test('몇 줄이 줄었는지 센다', () => {
    const input = [
      e({ ts: T('00:00:01'), message: 'x 1' }),
      e({ ts: T('00:00:02'), message: 'x 2' }),
      e({ ts: T('00:00:03'), message: 'x 3' }),
      e({ ts: T('00:00:04'), message: '다른 것' }),
    ];
    const out = groupEntries(input);
    assert.equal(collapsedCount(input, out), 2);
  });
});
