import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LoginRateLimiter } from './ratelimit.js';

describe('LoginRateLimiter', () => {
  test('5회까지는 통과, 6번째 시도에서 잠긴다', () => {
    let now = 1_000_000;
    const rl = new LoginRateLimiter(() => now);

    for (let i = 0; i < 5; i++) {
      assert.equal(rl.retryAfterMs('a@example.com'), null, `${i + 1}번째는 아직 안 잠겨야 한다`);
      rl.recordFailure('a@example.com');
    }
    const left = rl.retryAfterMs('a@example.com');
    assert.ok(left !== null && left > 0, '5회 실패 후에는 잠겨야 한다');
  });

  test('5분이 지나면 창이 초기화된다', () => {
    let now = 1_000_000;
    const rl = new LoginRateLimiter(() => now);
    for (let i = 0; i < 5; i++) rl.recordFailure('a@example.com');
    assert.notEqual(rl.retryAfterMs('a@example.com'), null);

    now += 5 * 60_000;
    assert.equal(rl.retryAfterMs('a@example.com'), null);
  });

  test('이메일 단위로 격리된다', () => {
    let now = 1_000_000;
    const rl = new LoginRateLimiter(() => now);
    for (let i = 0; i < 5; i++) rl.recordFailure('a@example.com');
    assert.notEqual(rl.retryAfterMs('a@example.com'), null);
    assert.equal(rl.retryAfterMs('b@example.com'), null);
  });

  test('대소문자를 같은 계정으로 본다', () => {
    let now = 1_000_000;
    const rl = new LoginRateLimiter(() => now);
    for (let i = 0; i < 5; i++) rl.recordFailure('A@Example.com');
    assert.notEqual(rl.retryAfterMs('a@example.com'), null);
  });

  test('로그인 성공이 카운터를 비운다', () => {
    let now = 1_000_000;
    const rl = new LoginRateLimiter(() => now);
    for (let i = 0; i < 4; i++) rl.recordFailure('a@example.com');
    rl.clear('a@example.com');
    for (let i = 0; i < 4; i++) {
      assert.equal(rl.retryAfterMs('a@example.com'), null);
      rl.recordFailure('a@example.com');
    }
  });
});

describe('IP 단위 제한', () => {
  /** 이메일만 세면 주소를 바꿔가며 뿌리는 것을 못 막는다. */
  test('IP 는 이메일보다 넉넉하지만 무제한은 아니다', () => {
    let now = 1_000_000;
    const rl = new LoginRateLimiter(() => now);

    // 서로 다른 이메일 20개로 시도해도 IP 카운터는 쌓인다
    for (let i = 0; i < 20; i++) {
      assert.equal(rl.retryAfterMs('ip:1.2.3.4'), null, `${i + 1}번째는 아직 안 잠겨야 한다`);
      rl.recordFailure(`user${i}@example.com`);
      rl.recordFailure('ip:1.2.3.4');
    }
    assert.notEqual(rl.retryAfterMs('ip:1.2.3.4'), null, '20회를 넘으면 IP 가 잠겨야 한다');
  });

  test('이메일은 5회에서 잠긴다 (IP 한도와 별개다)', () => {
    let now = 1_000_000;
    const rl = new LoginRateLimiter(() => now);
    for (let i = 0; i < 5; i++) rl.recordFailure('a@example.com');
    assert.notEqual(rl.retryAfterMs('a@example.com'), null);
    assert.equal(rl.retryAfterMs('ip:1.2.3.4'), null, 'IP 는 아직 여유가 있다');
  });

  test('다른 IP 는 서로 영향을 주지 않는다', () => {
    let now = 1_000_000;
    const rl = new LoginRateLimiter(() => now);
    for (let i = 0; i < 20; i++) rl.recordFailure('ip:1.2.3.4');
    assert.notEqual(rl.retryAfterMs('ip:1.2.3.4'), null);
    assert.equal(rl.retryAfterMs('ip:5.6.7.8'), null);
  });

  test('창이 지나면 IP 도 풀린다', () => {
    let now = 1_000_000;
    const rl = new LoginRateLimiter(() => now);
    for (let i = 0; i < 20; i++) rl.recordFailure('ip:1.2.3.4');
    assert.notEqual(rl.retryAfterMs('ip:1.2.3.4'), null);
    now += 5 * 60_000;
    assert.equal(rl.retryAfterMs('ip:1.2.3.4'), null);
  });
});
