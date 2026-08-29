import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ImsTokenCache, ImsError } from './ims.js';
import type { OrgConfig } from '../config/env.js';

const org = (key: string): OrgConfig => ({
  key,
  label: key.toUpperCase(),
  imsOrgId: `${key.toUpperCase()}@AdobeOrg`,
  clientId: `${key}-client`,
  clientSecret: `${key}-secret`,
  scopes: 'openid',
});

/** 호출 횟수를 세면서 토큰을 내주는 가짜 IMS. */
function fakeIms(opts: { expiresIn?: number; fail?: Set<string> } = {}) {
  const calls: string[] = [];
  let n = 0;
  const impl: typeof fetch = async (_url, init) => {
    const body = new URLSearchParams(String((init as RequestInit).body));
    const clientId = body.get('client_id')!;
    calls.push(clientId);
    if (opts.fail?.has(clientId)) {
      return new Response('nope', { status: 401 });
    }
    return new Response(JSON.stringify({ access_token: `token-${++n}`, expires_in: opts.expiresIn ?? 100 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { impl, calls };
}

describe('ImsTokenCache', () => {
  test('캐시된 토큰을 재사용한다', async () => {
    const { impl, calls } = fakeIms();
    const cache = new ImsTokenCache(() => 0, impl);
    assert.equal(await cache.getToken(org('acme')), 'token-1');
    assert.equal(await cache.getToken(org('acme')), 'token-1');
    assert.equal(calls.length, 1);
  });

  test('expires_in 의 90% 지점에서 선제 갱신한다', async () => {
    let now = 0;
    const { impl, calls } = fakeIms({ expiresIn: 100 }); // 100초
    const cache = new ImsTokenCache(() => now, impl);

    assert.equal(await cache.getToken(org('acme')), 'token-1');

    now = 89_000; // 89% — 아직 유효
    assert.equal(await cache.getToken(org('acme')), 'token-1');
    assert.equal(calls.length, 1);

    now = 90_000; // 90% — 갱신한다. 실제 만료(100초) 전이라 끊기지 않는다
    assert.equal(await cache.getToken(org('acme')), 'token-2');
    assert.equal(calls.length, 2);
  });

  test('조직마다 따로 캐시한다', async () => {
    const { impl } = fakeIms();
    const cache = new ImsTokenCache(() => 0, impl);
    const a = await cache.getToken(org('acme'));
    const b = await cache.getToken(org('globex'));
    assert.notEqual(a, b);
    assert.equal(await cache.getToken(org('acme')), a);
  });

  test('한 조직의 실패가 다른 조직을 막지 않는다', async () => {
    const { impl } = fakeIms({ fail: new Set(['acme-client']) });
    const cache = new ImsTokenCache(() => 0, impl);

    await assert.rejects(() => cache.getToken(org('acme')), ImsError);
    // B사는 그대로 동작해야 한다
    assert.ok(await cache.getToken(org('globex')));
  });

  test('동시 요청이 몰려도 토큰 발급은 한 번만 나간다', async () => {
    const { impl, calls } = fakeIms();
    const cache = new ImsTokenCache(() => 0, impl);
    const tokens = await Promise.all([1, 2, 3, 4, 5].map(() => cache.getToken(org('acme'))));
    assert.equal(calls.length, 1);
    assert.deepEqual(new Set(tokens), new Set(['token-1']));
  });

  test('invalidate 하면 다시 받아온다', async () => {
    const { impl, calls } = fakeIms();
    const cache = new ImsTokenCache(() => 0, impl);
    await cache.getToken(org('acme'));
    cache.invalidate('acme');
    assert.equal(await cache.getToken(org('acme')), 'token-2');
    assert.equal(calls.length, 2);
  });

  test('실패 메시지에 client secret 이 들어가지 않는다', async () => {
    const impl: typeof fetch = async () => new Response('bad credentials: acme-secret leaked', { status: 400 });
    const cache = new ImsTokenCache(() => 0, impl);
    await assert.rejects(
      () => cache.getToken(org('acme')),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(!msg.includes('acme-secret'), `secret 이 새고 있다: ${msg}`);
        assert.ok(msg.includes('***'));
        return true;
      },
    );
  });
});
