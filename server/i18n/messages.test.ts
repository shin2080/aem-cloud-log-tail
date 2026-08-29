import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ko, en, msg, langFrom } from './messages.js';

describe('서버 메시지 i18n', () => {
  test('두 카탈로그의 키가 같다', () => {
    // 타입으로도 걸리지만, 남는 키는 타입이 못 잡는다.
    assert.deepEqual(Object.keys(en).sort(), Object.keys(ko).sort());
  });

  test('빈 문자열이 없다', () => {
    for (const [k, v] of Object.entries(en)) assert.ok(v.trim().length > 0, k);
    for (const [k, v] of Object.entries(ko)) assert.ok(v.trim().length > 0, k);
  });

  test('두 언어의 자리표시자가 같다', () => {
    const holders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(ko) as (keyof typeof ko)[]) {
      assert.deepEqual(holders(en[k]), holders(ko[k]), `${k} 의 자리표시자가 어긋난다`);
    }
  });

  test('자리표시자를 채운다', () => {
    assert.equal(msg('ko', 'too_many_attempts', { mins: 5 }), '로그인 시도가 너무 많다. 5분 후 다시 시도한다');
    assert.equal(msg('en', 'too_many_attempts', { mins: 5 }), 'Too many sign-in attempts. Try again in 5 minutes.');
  });

  test('모르는 자리표시자는 그대로 둔다 — 값이 빠졌음을 감춘 채로 내보내지 않는다', () => {
    assert.equal(msg('en', 'cloud_manager_failed', {}), 'The Cloud Manager call failed ({status})');
  });

  test('헤더가 없거나 모르는 값이면 한국어다', () => {
    assert.equal(langFrom(undefined), 'ko');
    assert.equal(langFrom('fr'), 'ko');
    assert.equal(langFrom('en'), 'en');
    assert.equal(langFrom(['en']), 'en');
  });
});
