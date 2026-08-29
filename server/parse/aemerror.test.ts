import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AemErrorParser } from './aemerror.js';
import { createParser, hasParser } from './parser.js';
import type { LogEntry } from '../../shared/types.js';

const POD = 'cm-p33452-e121351-aem-author-54c7ddc56c-vf8vb';
const L1 = `25.09.2023 15:34:56.428 [${POD}] *INFO* [sling-oak-observation-5] com.adobe.cq.Foo 첫 번째 메시지`;
const L2 = `25.09.2023 15:34:57.100 [${POD}] *ERROR* [qtp-123] com.adobe.cq.Bar 터졌다`;

/** push 결과를 seq 순으로 정리한다 (개정된 엔트리는 뒤에 다시 나올 수 있다) */
function collect(entries: LogEntry[][]): Map<number, LogEntry> {
  const m = new Map<number, LogEntry>();
  for (const batch of entries) for (const e of batch) m.set(e.seq, e);
  return m;
}

describe('aemerror 파서 — 기본', () => {
  test('한 줄을 필드로 쪼갠다', () => {
    const p = new AemErrorParser();
    const [e] = p.push(L1 + '\n');
    assert.ok(e);
    assert.equal(e.seq, 0);
    assert.equal(e.level, 'INFO');
    assert.equal(e.pod, POD);
    assert.equal(e.thread, 'sling-oak-observation-5');
    assert.equal(e.logger, 'com.adobe.cq.Foo');
    assert.equal(e.message, '첫 번째 메시지');
    assert.equal(e.raw, L1);
    assert.deepEqual(e.continuation, []);
  });

  test('타임스탬프를 UTC 로 읽는다', () => {
    const p = new AemErrorParser();
    const [e] = p.push(L1 + '\n');
    assert.equal(e!.ts, Date.UTC(2023, 8, 25, 15, 34, 56, 428));
    assert.equal(new Date(e!.ts).toISOString(), '2023-09-25T15:34:56.428Z');
  });

  test('레벨을 정규화한다', () => {
    const p = new AemErrorParser();
    const mk = (lvl: string) => `25.09.2023 15:34:56.428 [${POD}] *${lvl}* [t] com.x.Y m`;
    const got = p.push([mk('ERROR'), mk('WARN'), mk('INFO'), mk('DEBUG'), mk('TRACE'), mk('FATAL'), ''].join('\n'));
    assert.deepEqual(
      got.map((e) => e.level),
      ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE', 'UNKNOWN'],
    );
  });

  test('seq 는 단조 증가한다', () => {
    const p = new AemErrorParser();
    const got = p.push([L1, L2, L1, ''].join('\n'));
    assert.deepEqual(got.map((e) => e.seq), [0, 1, 2]);
    assert.equal(p.nextSeq, 3);
  });

  test('startSeq 를 이어받는다 (롤오버 시 필요하다)', () => {
    const p = new AemErrorParser(500);
    const [e] = p.push(L1 + '\n');
    assert.equal(e!.seq, 500);
  });

  test('메시지가 없는 라인도 견딘다', () => {
    const p = new AemErrorParser();
    const [e] = p.push(`25.09.2023 15:34:56.428 [${POD}] *INFO* [t] com.x.Y\n`);
    assert.equal(e!.logger, 'com.x.Y');
    assert.equal(e!.message, '');
  });

  test('thread 가 비어 있어도 견딘다', () => {
    const p = new AemErrorParser();
    const [e] = p.push(`25.09.2023 15:34:56.428 [${POD}] *INFO* [] com.x.Y m\n`);
    assert.equal(e!.thread, '');
  });
});

describe('aemerror 파서 — 멀티라인 스택트레이스', () => {
  const STACK = [
    'java.lang.NullPointerException: Cannot invoke "String.length()"',
    '\tat com.adobe.cq.Foo.bar(Foo.java:42)',
    '\tat com.adobe.cq.Baz.qux(Baz.java:17)',
    'Caused by: java.lang.IllegalStateException',
    '\t... 23 more',
  ];

  test('정규식에 안 맞는 라인을 직전 엔트리에 붙인다', () => {
    const p = new AemErrorParser();
    const all = collect([p.push([L2, ...STACK, L1, ''].join('\n'))]);

    const err = all.get(0)!;
    assert.equal(err.level, 'ERROR');
    assert.deepEqual(err.continuation, STACK);

    const next = all.get(1)!;
    assert.equal(next.level, 'INFO');
    assert.deepEqual(next.continuation, [], '다음 엔트리에 새면 안 된다');
  });

  test('스택이 청크에 걸쳐 나뉘어 와도 한 엔트리로 묶인다', () => {
    const p = new AemErrorParser();
    const batches = [
      p.push(L2 + '\n' + STACK[0] + '\n'),
      p.push(STACK[1] + '\n' + STACK[2] + '\n'),
      p.push([STACK[3], STACK[4], ''].join('\n')),
    ];
    const all = collect(batches);
    assert.equal(all.size, 1, '엔트리는 하나여야 한다');
    assert.deepEqual(all.get(0)!.continuation, STACK);
  });

  test('나중에 붙은 continuation 때문에 엔트리가 다시 나온다 (upsert 대상)', () => {
    const p = new AemErrorParser();
    const first = p.push(L2 + '\n');
    assert.equal(first[0]!.seq, 0);

    const second = p.push(STACK[0] + '\n');
    assert.equal(second.length, 1);
    assert.equal(second[0]!.seq, 0, '같은 seq 로 다시 나와야 한다');
    assert.deepEqual(second[0]!.continuation, [STACK[0]]);
  });

  test('직전 엔트리가 없으면 UNKNOWN 단독 엔트리를 만든다', () => {
    const p = new AemErrorParser();
    const got = p.push('\tat com.adobe.cq.Foo.bar(Foo.java:42)\n');
    assert.equal(got.length, 1);
    assert.equal(got[0]!.level, 'UNKNOWN');
    assert.equal(got[0]!.message, '\tat com.adobe.cq.Foo.bar(Foo.java:42)');
  });

  test('엔트리 사이의 빈 줄은 버리고, 스택 안의 빈 줄은 살린다', () => {
    const p = new AemErrorParser();
    const a = collect([p.push([L1, '', L2, ''].join('\n'))]);
    assert.deepEqual(a.get(0)!.continuation, [], '엔트리 직후 빈 줄은 버린다');

    const q = new AemErrorParser();
    const b = collect([q.push([L2, 'java.lang.Foo', '', '\tat x.y(Z.java:1)', ''].join('\n'))]);
    assert.deepEqual(b.get(0)!.continuation, ['java.lang.Foo', '', '\tat x.y(Z.java:1)']);
  });
});

describe('aemerror 파서 — 청크 경계', () => {
  test('라인 한가운데서 잘려도 복원한다', () => {
    const p = new AemErrorParser();
    const cut = 40;
    const a = p.push((L1 + '\n').slice(0, cut));
    assert.deepEqual(a, [], '아직 완성된 라인이 없다');

    const b = p.push((L1 + '\n').slice(cut));
    assert.equal(b.length, 1);
    assert.equal(b[0]!.raw, L1);
    assert.equal(b[0]!.message, '첫 번째 메시지');
  });

  test('한 바이트씩 밀어 넣어도 결과가 같다', () => {
    const text = [L1, L2, '\tat com.x.Y(Z.java:1)', ''].join('\n');

    const whole = collect([new AemErrorParser().push(text)]);

    const p = new AemErrorParser();
    const batches: ReturnType<AemErrorParser['push']>[] = [];
    for (const ch of text) batches.push(p.push(ch));
    const drip = collect(batches);

    assert.equal(drip.size, whole.size);
    for (const [seq, e] of whole) {
      assert.deepEqual(drip.get(seq), e, `seq ${seq} 가 달라졌다`);
    }
  });

  test('개행으로 끝나지 않은 마지막 라인은 flush 로 나온다', () => {
    const p = new AemErrorParser();
    assert.deepEqual(p.push(L1), [], '개행이 없으면 아직 내보내지 않는다');
    const flushed = p.flush();
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0]!.raw, L1);
    assert.deepEqual(p.flush(), [], '두 번 부르면 비어 있다');
  });

  test('빈 청크는 아무 일도 하지 않는다', () => {
    const p = new AemErrorParser();
    assert.deepEqual(p.push(''), []);
  });

  test('CRLF 를 견딘다', () => {
    const p = new AemErrorParser();
    const [e] = p.push(L1 + '\r\n');
    assert.equal(e!.raw, L1, '\\r 이 남으면 안 된다');
    assert.equal(e!.message, '첫 번째 메시지');
  });
});

describe('파서 레지스트리', () => {
  test('aemerror 가 등록돼 있다', () => {
    assert.equal(hasParser('aemerror'), true);
    assert.ok(createParser('aemerror') instanceof AemErrorParser);
  });

  test('v1 은 aemerror 만 지원한다 — 나머지는 명확히 거부한다', () => {
    assert.equal(hasParser('aemaccess'), false);
    assert.throws(() => createParser('aemaccess'), /파서가 없다/);
  });
});
