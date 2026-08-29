import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { LogEntry, LogLevel } from '../../shared/types.js';
import { selectForExport } from './select.js';

const e = (seq: number, level: LogLevel = 'INFO', message = 'msg', continuation: string[] = []): LogEntry => ({
  seq,
  ts: 1000 + seq,
  level,
  pod: 'pod',
  thread: 't',
  logger: 'com.x.Y',
  message,
  continuation,
  raw: `raw-${seq} ${level} ${message}`,
});

const all = [e(0, 'INFO', 'alpha'), e(1, 'ERROR', 'bravo'), e(2, 'WARN', 'charlie'), e(5, 'ERROR', 'delta'), e(9, 'INFO', 'echo')];

describe('selectForExport — seq 목록', () => {
  /**
   * 이게 이 모듈이 있는 이유다.
   * 묶어보기·북마크만보기에서는 화면에 보이는 줄이 seq 구간과 다르다.
   * 구간만 보고 뽑으면 대화상자가 말한 줄 수와 실제 파일이 어긋난다.
   */
  test('연속되지 않은 seq 를 정확히 그것만 뽑는다', () => {
    const out = selectForExport(all, { seqs: [0, 5, 9] });
    assert.deepEqual(out.map((x) => x.seq), [0, 5, 9]);
  });

  test('없는 seq 는 조용히 무시한다', () => {
    const out = selectForExport(all, { seqs: [1, 999] });
    assert.deepEqual(out.map((x) => x.seq), [1]);
  });

  test('원래 순서를 유지한다', () => {
    const out = selectForExport(all, { seqs: [9, 0, 5] });
    assert.deepEqual(out.map((x) => x.seq), [0, 5, 9], '요청 순서가 아니라 로그 순서다');
  });

  test('seqs 가 있으면 seqFrom/To 는 무시한다', () => {
    const out = selectForExport(all, { seqs: [9], seqFrom: 0, seqTo: 2 });
    assert.deepEqual(out.map((x) => x.seq), [9]);
  });

  test('빈 seqs 는 구간 방식으로 떨어진다', () => {
    const out = selectForExport(all, { seqs: [], seqFrom: 0, seqTo: 1 });
    assert.deepEqual(out.map((x) => x.seq), [0, 1]);
  });
});

describe('selectForExport — seq 구간', () => {
  test('경계를 포함한다', () => {
    assert.deepEqual(selectForExport(all, { seqFrom: 1, seqTo: 5 }).map((x) => x.seq), [1, 2, 5]);
  });

  test('한쪽만 줘도 동작한다', () => {
    assert.deepEqual(selectForExport(all, { seqFrom: 5 }).map((x) => x.seq), [5, 9]);
    assert.deepEqual(selectForExport(all, { seqTo: 1 }).map((x) => x.seq), [0, 1]);
  });

  test('아무것도 안 주면 전체다', () => {
    assert.equal(selectForExport(all, {}).length, all.length);
  });
});

describe('selectForExport — 추가 필터', () => {
  test('레벨로 거른다', () => {
    assert.deepEqual(selectForExport(all, { levels: ['ERROR'] }).map((x) => x.seq), [1, 5]);
  });

  test('검색어로 거른다 (대소문자 무시)', () => {
    assert.deepEqual(selectForExport(all, { query: 'BRAVO' }).map((x) => x.seq), [1]);
  });

  test('스택트레이스 안도 찾는다', () => {
    const withStack = [e(0, 'ERROR', 'boom', ['at com.adobe.Payment.charge(Payment.java:9)'])];
    assert.equal(selectForExport(withStack, { query: 'Payment.java' }).length, 1);
  });

  test('seq 선택과 필터가 함께 걸린다', () => {
    const out = selectForExport(all, { seqs: [0, 1, 2, 5], levels: ['ERROR'] });
    assert.deepEqual(out.map((x) => x.seq), [1, 5]);
  });

  test('빈 레벨 배열은 필터가 아니다', () => {
    assert.equal(selectForExport(all, { levels: [] }).length, all.length);
  });

  test('공백뿐인 검색어는 필터가 아니다', () => {
    assert.equal(selectForExport(all, { query: '   ' }).length, all.length);
  });
});
