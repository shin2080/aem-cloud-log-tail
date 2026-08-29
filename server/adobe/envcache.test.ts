import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type DbHandle } from '../db/index.js';
import { envCache } from '../db/schema.js';
import type { OrgConfig } from '../config/env.js';
import { isCacheStaleForCredentials, readEnvCache, readEnv, isStale } from './envcache.js';

let handle: DbHandle;

const org = (clientId: string): OrgConfig => ({
  key: 'acme',
  label: 'ACME',
  imsOrgId: 'A@AdobeOrg',
  clientId,
  clientSecret: 's',
  scopes: 'openid',
});

const put = (over: Partial<typeof envCache.$inferInsert> = {}): void => {
  handle.db
    .insert(envCache)
    .values({
      orgKey: 'acme',
      programId: '12345',
      programName: 'P',
      environmentId: '1',
      environmentName: 'dev',
      environmentType: 'dev',
      availableServices: null,
      refreshedAt: Date.now(),
      credentialId: 'client-a',
      ...over,
    })
    .run();
};

beforeEach(() => {
  handle = openDb(':memory:');
});

/**
 * 실제로 겪은 사고다. `.env` 에서 ORG_n_KEY 는 그대로 두고 자격증명만 갈아끼우면
 * 캐시는 옛 조직의 환경을 들고 있는데 호출은 새 자격증명으로 나간다.
 * 인가는 캐시를 믿으므로 통과하고 Adobe 가 403 을 준다.
 */
describe('자격증명 지문', () => {
  test('같은 자격증명으로 채운 캐시는 유효하다', () => {
    put();
    assert.equal(isCacheStaleForCredentials(handle.db, org('client-a')), false);
  });

  test('자격증명이 바뀌면 캐시를 못 믿는다', () => {
    put();
    assert.equal(isCacheStaleForCredentials(handle.db, org('client-b')), true);
  });

  test('지문이 없는 옛 캐시도 한 번은 다시 받는다', () => {
    put({ credentialId: null });
    assert.equal(isCacheStaleForCredentials(handle.db, org('client-a')), true);
  });

  test('한 행이라도 어긋나면 전체를 못 믿는다', () => {
    put({ environmentId: '1', credentialId: 'client-a' });
    put({ environmentId: '2', credentialId: 'client-b' });
    assert.equal(isCacheStaleForCredentials(handle.db, org('client-a')), true);
  });

  test('캐시가 비어 있으면 어긋난 것이 아니다 (그냥 처음이다)', () => {
    assert.equal(isCacheStaleForCredentials(handle.db, org('client-a')), false);
  });

  test('다른 조직의 캐시는 보지 않는다', () => {
    put({ orgKey: 'globex', credentialId: 'client-z' });
    assert.equal(isCacheStaleForCredentials(handle.db, org('client-a')), false);
  });
});

describe('캐시 읽기', () => {
  test('조직별로 갈라 읽는다', () => {
    put({ orgKey: 'acme', environmentId: '1' });
    put({ orgKey: 'globex', environmentId: '2' });
    assert.equal(readEnvCache(handle.db, 'acme').length, 1);
    assert.equal(readEnv(handle.db, 'acme', '2'), null, '남의 조직 환경은 안 보여야 한다');
    assert.ok(readEnv(handle.db, 'globex', '2'));
  });

  test('TTL 이 지나면 오래된 것으로 본다', () => {
    const now = Date.now();
    put({ refreshedAt: now - 31 * 60_000 });
    assert.equal(isStale(readEnvCache(handle.db, 'acme'), now), true);
  });

  test('비어 있으면 오래된 것으로 본다', () => {
    assert.equal(isStale([], Date.now()), true);
  });
});
