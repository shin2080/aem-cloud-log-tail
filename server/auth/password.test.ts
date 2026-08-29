import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePassword,
  MIN_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  verifyPassword,
  generateTempPassword,
  verifyAgainstDummy,
} from './password.js';

describe('비밀번호 정책', () => {
  test('최소 길이는 8자다', () => {
    assert.equal(MIN_PASSWORD_LENGTH, 8);
  });

  test('8자 미만은 거부한다', () => {
    assert.ok(validatePassword('1234567'));
    // 글이 아니라 키를 준다. 길이 제한도 함께 넘기므로 화면이 숫자를 박지 않는다 —
    // /api/auth/me 의 minPasswordLength 와 같은 출처다.
    assert.deepEqual(validatePassword('short'), {
      key: 'password_too_short',
      params: { min: MIN_PASSWORD_LENGTH },
    });
  });

  test('정확히 8자는 통과한다', () => {
    assert.equal(validatePassword('12345678'), null);
  });

  test('긴 비밀번호도 통과한다', () => {
    assert.equal(validatePassword('a-much-longer-password'), null);
  });
});

describe('해싱', () => {
  test('argon2id 해시를 검증한다', async () => {
    const h = await hashPassword('correct-horse');
    assert.ok(h.startsWith('$argon2id$'), `argon2id 가 아니다: ${h.slice(0, 20)}`);
    assert.equal(await verifyPassword(h, 'correct-horse'), true);
    assert.equal(await verifyPassword(h, 'wrong'), false);
  });

  test('같은 비밀번호도 매번 다른 해시가 된다 (salt)', async () => {
    assert.notEqual(await hashPassword('same'), await hashPassword('same'));
  });

  test('깨진 해시에 대해 던지지 않고 false 를 준다', async () => {
    assert.equal(await verifyPassword('not-a-hash', 'x'), false);
  });
});

describe('임시 비밀번호', () => {
  test('최소 길이를 넘고 매번 다르다', () => {
    const a = generateTempPassword();
    assert.ok(a.length >= MIN_PASSWORD_LENGTH);
    assert.equal(validatePassword(a), null);
    assert.notEqual(a, generateTempPassword());
  });

  test('혼동되는 글자(0/O/1/l/I)를 쓰지 않는다', () => {
    for (let i = 0; i < 30; i++) {
      assert.doesNotMatch(generateTempPassword(), /[0O1lI]/);
    }
  });
});

describe('로그인 타이밍', () => {
  /**
   * 계정이 없을 때 argon2 를 건너뛰면 응답이 눈에 띄게 빨라져,
   * 메시지를 통일해놔도 응답 시간이 계정 존재 여부를 알려준다.
   */
  test('더미 검증이 실제 검증과 비슷한 비용을 치른다', async () => {
    const real = await hashPassword('some-real-password');

    const t1 = performance.now();
    await verifyPassword(real, 'wrong-guess');
    const realMs = performance.now() - t1;

    const t2 = performance.now();
    await verifyAgainstDummy('wrong-guess');
    const dummyMs = performance.now() - t2;

    // 정확히 같을 수는 없지만 자릿수가 달라지면 안 된다.
    const ratio = Math.max(realMs, dummyMs) / Math.max(1, Math.min(realMs, dummyMs));
    assert.ok(ratio < 5, `비용 차이가 ${ratio.toFixed(1)}배다 (실제 ${realMs.toFixed(1)}ms / 더미 ${dummyMs.toFixed(1)}ms)`);
  });

  test('더미 검증은 항상 false 다', async () => {
    assert.equal(await verifyAgainstDummy('아무거나'), false);
    assert.equal(await verifyAgainstDummy(''), false);
  });
});
