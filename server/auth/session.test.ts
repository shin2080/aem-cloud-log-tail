import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { openDb, type DbHandle } from '../db/index.js';
import { users, userOrgs } from '../db/schema.js';
import { createSession, destroySession, destroyUserSessions, purgeExpiredSessions, resolveSession } from './session.js';

let handle: DbHandle;

function makeUser(over: Partial<typeof users.$inferInsert> = {}): string {
  const id = randomUUID();
  handle.db
    .insert(users)
    .values({
      id,
      email: `${id}@example.com`,
      passwordHash: 'x',
      displayName: '테스트',
      role: 'member',
      createdAt: Date.now(),
      ...over,
    })
    .run();
  return id;
}

beforeEach(() => {
  handle = openDb(':memory:');
});

describe('세션', () => {
  test('발급한 세션을 되찾을 수 있다', () => {
    const uid = makeUser();
    const { id } = createSession(handle.db, uid, 12, 'test-agent');
    const su = resolveSession(handle.db, id);
    assert.equal(su?.user.id, uid);
    assert.equal(su?.sessionId, id);
  });

  test('세션 id 는 추측 불가능한 길이여야 한다', () => {
    const uid = makeUser();
    const { id } = createSession(handle.db, uid, 12, undefined);
    assert.ok(id.length >= 43, `256bit base64url 이면 43자 이상이어야 한다: ${id.length}`);
    const { id: id2 } = createSession(handle.db, uid, 12, undefined);
    assert.notEqual(id, id2);
  });

  test('없는 세션은 null', () => {
    assert.equal(resolveSession(handle.db, 'nope'), null);
  });

  test('만료된 세션은 null', () => {
    const uid = makeUser();
    const { id } = createSession(handle.db, uid, -1, undefined); // 이미 지난 만료
    assert.equal(resolveSession(handle.db, id), null);
  });

  test('비활성 계정의 세션은 살아 있어도 거부한다', () => {
    const uid = makeUser();
    const { id } = createSession(handle.db, uid, 12, undefined);
    assert.ok(resolveSession(handle.db, id));

    handle.db.update(users).set({ isActive: 0 }).where(eq(users.id, uid)).run();
    assert.equal(resolveSession(handle.db, id), null, '계정을 끄면 기존 세션도 즉시 죽어야 한다');
  });

  test('조직 접근 권한을 함께 실어 온다', () => {
    const uid = makeUser();
    handle.db.insert(userOrgs).values([
      { userId: uid, orgKey: 'acme', allowProd: 1 },
      { userId: uid, orgKey: 'globex', allowProd: 0 },
    ]).run();

    const su = resolveSession(handle.db, createSession(handle.db, uid, 12, undefined).id);
    assert.deepEqual(
      [...(su?.orgs ?? [])].sort((a, b) => a.orgKey.localeCompare(b.orgKey)),
      [
        { orgKey: 'acme', allowProd: true },
        { orgKey: 'globex', allowProd: false },
      ],
    );
  });

  test('destroySession 은 해당 세션만 지운다', () => {
    const uid = makeUser();
    const a = createSession(handle.db, uid, 12, undefined);
    const b = createSession(handle.db, uid, 12, undefined);
    destroySession(handle.db, a.id);
    assert.equal(resolveSession(handle.db, a.id), null);
    assert.ok(resolveSession(handle.db, b.id));
  });

  test('destroyUserSessions 는 그 사용자의 세션을 전부 지운다', () => {
    const uid = makeUser();
    const other = makeUser();
    const a = createSession(handle.db, uid, 12, undefined);
    const b = createSession(handle.db, uid, 12, undefined);
    const c = createSession(handle.db, other, 12, undefined);

    destroyUserSessions(handle.db, uid);
    assert.equal(resolveSession(handle.db, a.id), null);
    assert.equal(resolveSession(handle.db, b.id), null);
    assert.ok(resolveSession(handle.db, c.id), '다른 사용자 세션은 남아야 한다');
  });

  test('purgeExpiredSessions 는 만료된 것만 지운다', () => {
    const uid = makeUser();
    createSession(handle.db, uid, -1, undefined);
    createSession(handle.db, uid, -1, undefined);
    const live = createSession(handle.db, uid, 12, undefined);

    assert.equal(purgeExpiredSessions(handle.db), 2);
    assert.ok(resolveSession(handle.db, live.id));
  });

  test('계정을 지우면 세션도 함께 지워진다 (ON DELETE CASCADE)', () => {
    const uid = makeUser();
    const { id } = createSession(handle.db, uid, 12, undefined);
    handle.db.delete(users).where(eq(users.id, uid)).run();
    assert.equal(resolveSession(handle.db, id), null);
  });
});
