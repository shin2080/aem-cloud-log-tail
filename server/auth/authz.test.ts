import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDb, type DbHandle } from '../db/index.js';
import { envCache, users, userOrgs } from '../db/schema.js';
import { loadConfig, type AppConfig } from '../config/env.js';
import { createContext, type AppContext } from '../context.js';
import { createSession, resolveSession, type SessionUser } from './session.js';
import { authorizeOrg, authorizeEnv } from './authz.js';
import type { EnvironmentType } from '../../shared/types.js';

const ENV: NodeJS.ProcessEnv = {
  SESSION_SECRET: 'x'.repeat(64),
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_INITIAL_PASSWORD: 'a-long-enough-password',
  ORG_1_KEY: 'acme',
  ORG_1_LABEL: 'ACME',
  ORG_1_IMS_ORG_ID: 'AAA@AdobeOrg',
  ORG_1_CLIENT_ID: 'c1',
  ORG_1_CLIENT_SECRET: 's1',
  ORG_1_SCOPES: 'openid',
  ORG_2_KEY: 'globex',
  ORG_2_LABEL: 'Globex',
  ORG_2_IMS_ORG_ID: 'BBB@AdobeOrg',
  ORG_2_CLIENT_ID: 'c2',
  ORG_2_CLIENT_SECRET: 's2',
  ORG_2_SCOPES: 'openid',
};

/** fail() 이 부르는 것만 흉내낸 최소 reply */
function fakeReply() {
  const calls: { status: number; body: unknown }[] = [];
  const reply = {
    // fail() 이 여기서 언어를 읽는다. 헤더가 없으면 한국어다.
    request: { headers: {} as Record<string, string> },
    status(s: number) {
      calls.push({ status: s, body: null });
      return reply;
    },
    send(b: unknown) {
      if (calls.length > 0) calls[calls.length - 1]!.body = b;
      return reply;
    },
  };
  return { reply, calls };
}

let handle: DbHandle;
let ctx: AppContext;
let cfg: AppConfig;

function makeUser(orgs: { orgKey: string; allowProd: boolean }[]): SessionUser {
  const id = randomUUID();
  handle.db
    .insert(users)
    .values({
      id,
      email: `${id}@example.com`,
      passwordHash: 'x',
      displayName: 'T',
      role: 'member',
      createdAt: Date.now(),
    })
    .run();
  if (orgs.length > 0) {
    handle.db
      .insert(userOrgs)
      .values(orgs.map((o) => ({ userId: id, orgKey: o.orgKey, allowProd: o.allowProd ? 1 : 0 })))
      .run();
  }
  const { id: sid } = createSession(handle.db, id, 12, undefined);
  return resolveSession(handle.db, sid)!;
}

function seedEnv(orgKey: string, environmentId: string, type: EnvironmentType): void {
  handle.db
    .insert(envCache)
    .values({
      orgKey,
      programId: '12345',
      programName: 'P',
      environmentId,
      environmentName: `env-${environmentId}`,
      environmentType: type,
      availableServices: null,
      refreshedAt: Date.now(),
    })
    .run();
}

beforeEach(() => {
  handle = openDb(':memory:');
  cfg = loadConfig(ENV);
  ctx = createContext(cfg, handle);
});

describe('authorizeOrg', () => {
  test('권한이 있는 조직은 통과한다', () => {
    const su = makeUser([{ orgKey: 'acme', allowProd: false }]);
    const { reply, calls } = fakeReply();
    const grant = authorizeOrg(ctx, su, 'acme', reply as never);
    assert.equal(grant?.org.key, 'acme');
    assert.deepEqual(calls, []);
  });

  /** 수용 기준: 조직 A만 가진 계정이 조직 B를 호출하면 404 */
  test('권한 없는 조직은 403 이 아니라 404 다 — 존재 여부를 흘리지 않는다', () => {
    const su = makeUser([{ orgKey: 'acme', allowProd: true }]);
    const { reply, calls } = fakeReply();
    assert.equal(authorizeOrg(ctx, su, 'globex', reply as never), null);
    assert.equal(calls[0]?.status, 404);
  });

  test('.env 에 없는 조직 키는 404', () => {
    const su = makeUser([{ orgKey: 'acme', allowProd: true }]);
    const { reply, calls } = fakeReply();
    assert.equal(authorizeOrg(ctx, su, 'nonexistent', reply as never), null);
    assert.equal(calls[0]?.status, 404);
  });

  test('DB 에 권한만 남고 .env 에서 조직이 빠지면 404', () => {
    const su = makeUser([{ orgKey: 'removed-org', allowProd: true }]);
    const { reply, calls } = fakeReply();
    assert.equal(authorizeOrg(ctx, su, 'removed-org', reply as never), null);
    assert.equal(calls[0]?.status, 404);
  });
});

describe('authorizeEnv', () => {
  test('내 조직의 dev 환경은 통과한다', () => {
    const su = makeUser([{ orgKey: 'acme', allowProd: false }]);
    seedEnv('acme', '987654', 'dev');
    const { reply } = fakeReply();
    const grant = authorizeEnv(ctx, su, 'acme', '987654', reply as never);
    assert.equal(grant?.env.environmentId, '987654');
    assert.equal(grant?.env.programId, '12345');
  });

  /** 수용 기준: allow_prod 가 없는 계정은 prod tail 이 거부된다 */
  test('allow_prod 가 없으면 prod 환경은 404', () => {
    const su = makeUser([{ orgKey: 'acme', allowProd: false }]);
    seedEnv('acme', '987657', 'prod');
    const { reply, calls } = fakeReply();
    assert.equal(authorizeEnv(ctx, su, 'acme', '987657', reply as never), null);
    assert.equal(calls[0]?.status, 404);
  });

  test('allow_prod 가 있으면 prod 환경을 연다', () => {
    const su = makeUser([{ orgKey: 'acme', allowProd: true }]);
    seedEnv('acme', '987657', 'prod');
    const { reply } = fakeReply();
    assert.equal(authorizeEnv(ctx, su, 'acme', '987657', reply as never)?.env.environmentType, 'prod');
  });

  test('stage 는 allow_prod 와 무관하게 열린다', () => {
    const su = makeUser([{ orgKey: 'acme', allowProd: false }]);
    seedEnv('acme', '987656', 'stage');
    const { reply } = fakeReply();
    assert.ok(authorizeEnv(ctx, su, 'acme', '987656', reply as never));
  });

  /**
   * 수용 기준의 핵심. 프론트가 보내는 환경 ID 를 믿지 않는다.
   * 내 조직 권한 + 남의 조직 환경 ID 조합을 막는다.
   */
  test('다른 조직의 환경 ID 를 자기 조직 키로 넘기면 404', () => {
    const su = makeUser([{ orgKey: 'acme', allowProd: true }]);
    seedEnv('globex', '7777777', 'dev'); // globex 의 환경이다

    const { reply, calls } = fakeReply();
    assert.equal(authorizeEnv(ctx, su, 'acme', '7777777', reply as never), null, 'org/env 쌍이 어긋나면 막아야 한다');
    assert.equal(calls[0]?.status, 404);
  });

  test('두 조직에 같은 환경 ID 가 있어도 자기 것만 본다', () => {
    const su = makeUser([{ orgKey: 'acme', allowProd: true }]);
    seedEnv('acme', '1000', 'dev');
    seedEnv('globex', '1000', 'prod');

    const { reply } = fakeReply();
    const grant = authorizeEnv(ctx, su, 'acme', '1000', reply as never);
    assert.equal(grant?.env.orgKey, 'acme');
    assert.equal(grant?.env.environmentType, 'dev', 'globex 쪽 행을 집으면 안 된다');
  });

  test('캐시에 없는 환경 ID 는 404', () => {
    const su = makeUser([{ orgKey: 'acme', allowProd: true }]);
    const { reply, calls } = fakeReply();
    assert.equal(authorizeEnv(ctx, su, 'acme', '9999999', reply as never), null);
    assert.equal(calls[0]?.status, 404);
  });

  test('조직 권한이 없으면 환경 검사까지 가지 않는다', () => {
    const su = makeUser([]);
    seedEnv('acme', '987654', 'dev');
    const { reply, calls } = fakeReply();
    assert.equal(authorizeEnv(ctx, su, 'acme', '987654', reply as never), null);
    assert.equal(calls[0]?.status, 404);
  });
});
