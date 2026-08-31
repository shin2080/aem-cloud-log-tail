import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { LogEntry } from '../../shared/types.js';
import { compileRule, PatternError, MAX_PATTERN_CHARS } from './matcher.js';

function entry(over: Partial<LogEntry> = {}): LogEntry {
  const raw = over.raw ?? '29.08.2026 12:00:01.234 *ERROR* [qtp-1] com.adobe.cq.Foo 처리에 실패했다';
  return {
    seq: 0,
    ts: 1_700_000_000_000,
    level: 'ERROR',
    pod: '',
    thread: 'qtp-1',
    logger: 'com.adobe.cq.Foo',
    message: '처리에 실패했다',
    continuation: [],
    raw,
    ...over,
  };
}

describe('알림 규칙 — 부분문자열 (기본)', () => {
  test('본문에 있으면 맞는다', () => {
    const r = compileRule({ pattern: '실패', isRegex: false, levels: null });
    assert.equal(r.test(entry()), true);
  });

  test('대소문자를 가리지 않는다', () => {
    const r = compileRule({ pattern: 'outofmemory', isRegex: false, levels: null });
    assert.equal(r.test(entry({ raw: 'java.lang.OutOfMemoryError: Java heap space' })), true);
  });

  test('없으면 안 맞는다', () => {
    const r = compileRule({ pattern: '없는말', isRegex: false, levels: null });
    assert.equal(r.test(entry()), false);
  });

  test('스택트레이스도 함께 훑는다', () => {
    const r = compileRule({ pattern: 'SlingRepositoryImpl', isRegex: false, levels: null });
    const e = entry({ continuation: ['\tat com.adobe.granite.repository.impl.SlingRepositoryImpl.login(...)'] });
    assert.equal(r.test(e), true);
  });
});

describe('알림 규칙 — 레벨', () => {
  test('고른 레벨만 본다', () => {
    const r = compileRule({ pattern: '실패', isRegex: false, levels: ['ERROR'] });
    assert.equal(r.test(entry({ level: 'ERROR' })), true);
    assert.equal(r.test(entry({ level: 'WARN' })), false);
  });

  test('빈 목록은 전체와 같다', () => {
    const r = compileRule({ pattern: '실패', isRegex: false, levels: [] });
    assert.equal(r.test(entry({ level: 'INFO' })), true);
  });
});

describe('알림 규칙 — 정규식', () => {
  test('맞으면 true', () => {
    const r = compileRule({ pattern: 'Out ?Of ?Memory', isRegex: true, levels: null });
    assert.equal(r.test(entry({ raw: 'java.lang.OutOfMemoryError' })), true);
  });

  /** g 플래그를 붙이면 lastIndex 가 남아 다음 줄의 판정이 달라진다 */
  test('같은 규칙을 연달아 써도 결과가 흔들리지 않는다', () => {
    const r = compileRule({ pattern: 'ERROR', isRegex: true, levels: null });
    const e = entry({ raw: 'ERROR ERROR ERROR' });
    for (let i = 0; i < 5; i++) assert.equal(r.test(e), true, `${i}번째`);
  });
});

/**
 * 이 describe 가 이 파일의 존재 이유다.
 * 지금까지 정규식은 화면에서만 돌아 사용자가 자기 탭을 멈추는 게 전부였다.
 * 서버에서는 못된 패턴 하나가 폴링 루프를 막아 모든 세션이 함께 선다.
 */
describe('알림 규칙 — 서버를 지키는 검사', () => {
  test('빈 패턴은 거부한다', () => {
    assert.throws(() => compileRule({ pattern: '   ', isRegex: false, levels: null }), PatternError);
  });

  test('너무 긴 패턴은 거부한다', () => {
    const long = 'x'.repeat(MAX_PATTERN_CHARS + 1);
    assert.throws(() => compileRule({ pattern: long, isRegex: false, levels: null }), PatternError);
  });

  test('올바르지 않은 정규식은 거부한다', () => {
    assert.throws(() => compileRule({ pattern: '([a-z', isRegex: true, levels: null }), PatternError);
  });

  test('중첩 수량자는 거부한다 — 파국적 역추적', () => {
    for (const p of ['(a+)+$', '(\\d+)*x', '(ab*)+c']) {
      assert.throws(() => compileRule({ pattern: p, isRegex: true, levels: null }), PatternError, p);
    }
  });

  test('겹치는 교대도 거부한다', () => {
    assert.throws(() => compileRule({ pattern: '(a|a)*b', isRegex: true, levels: null }), PatternError);
  });

  test('평범한 정규식은 통과시킨다 — 과하게 막으면 기능이 없는 것과 같다', () => {
    for (const p of ['OutOfMemory', 'timed? ?out', '^\\d{2}\\.\\d{2}', 'foo|bar|baz', '[Ee]rror \\d+']) {
      compileRule({ pattern: p, isRegex: true, levels: null }); // 안 던지면 통과
    }
  });

  /** 상한이 실제로 걸리는지. 안 걸리면 긴 줄에서 역추적이 폭주한다 */
  test('아주 긴 줄에서도 제때 끝난다', () => {
    const r = compileRule({ pattern: 'a+b+c', isRegex: true, levels: null });
    const e = entry({ raw: 'a'.repeat(200_000) });
    const t0 = Date.now();
    r.test(e);
    assert.ok(Date.now() - t0 < 1000, '한 줄 판정이 1초를 넘으면 폴링이 막힌다');
  });
});
