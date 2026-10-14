import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerJsonBodyParser } from './jsonbody.js';

/**
 * 화면의 fetch 래퍼는 한동안 본문이 없어도 `Content-Type: application/json` 을
 * 붙였다. Fastify 기본 파서가 그걸 400 으로 끊었고, 그게 인증보다 앞이라
 * 로그아웃·삭제 계열이 전부 라우트에 닿지도 못했다.
 * 래퍼를 되돌리더라도 여기서 다시 막히지 않게 한다.
 */
async function appWith(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  registerJsonBodyParser(app);
  app.post('/echo', async (req) => ({ got: req.body ?? null }));
  app.delete('/gone', async (req) => ({ got: req.body ?? null }));
  await app.ready();
  return app;
}

describe('빈 JSON 본문', () => {
  test('본문 없이 application/json 으로 POST 해도 라우트까지 간다', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 200, '400 이면 로그아웃이 다시 막힌 것이다');
    assert.deepEqual(res.json(), { got: null });
    await app.close();
  });

  test('DELETE 도 마찬가지다', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'DELETE',
      url: '/gone',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 200);
    await app.close();
  });

  test('공백만 있는 본문도 빈 것으로 본다', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '   \n  ',
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { got: null });
    await app.close();
  });

  test('제대로 된 JSON 은 그대로 파싱된다', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ a: 1 }),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { got: { a: 1 } });
    await app.close();
  });

  test('깨진 JSON 은 400 으로 끊는다 — 비었을 때와 구분한다', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });
});
