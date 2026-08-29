import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { openDb, type DbHandle } from '../db/index.js';
import { users, auditLog } from '../db/schema.js';
import { audit, purgeOldAudit, auditRowCount } from './audit.js';
import { createSession, resolveSession } from './session.js';
import { verifyPassword, validatePassword } from './password.js';
import {
  AdminOpError,
  createUser,
  deleteUser,
  listUsers,
  queryAudit,
  resetPassword,
  revokeSessions,
  updateUser,
  distinctAuditActions,
} from './adminops.js';

let handle: DbHandle;
const KEYS = new Set(['acme', 'globex']);

beforeEach(() => {
  handle = openDb(':memory:');
});

/** 관리자 하나를 만들어 둔다 (시딩된 최초 관리자에 해당) */
async function seedAdmin(email = 'admin@example.com'): Promise<string> {
  const { user } = await createUser(
    handle.db,
    { email, displayName: '관리자', role: 'admin', orgs: [{ key: 'acme', allowProd: true }] },
    KEYS,
  );
  return user.id;
}

const expectFail = async (fn: () => unknown | Promise<unknown>, code: string): Promise<void> => {
  await assert.rejects(
    async () => await fn(),
    (e: unknown) => e instanceof AdminOpError && e.code === code,
  );
};

const expectFailSync = (fn: () => unknown, code: string): void => {
  assert.throws(fn, (e: unknown) => e instanceof AdminOpError && e.code === code);
};

describe('계정 발급', () => {
  test('임시 비밀번호를 한 번 돌려주고 저장하지 않는다', async () => {
    const { user, tempPassword } = await createUser(
      handle.db,
      { email: 'a@example.com', displayName: '에이', role: 'member', orgs: [{ key: 'acme', allowProd: false }] },
      KEYS,
    );

    assert.equal(validatePassword(tempPassword), null, '임시 비밀번호가 정책을 만족해야 한다');
    assert.equal(user.mustChangePassword, true, '첫 로그인에 변경을 강제해야 한다');

    const row = handle.db.select().from(users).where(eq(users.id, user.id)).get()!;
    assert.notEqual(row.passwordHash, tempPassword, '평문이 저장되면 안 된다');
    assert.ok(row.passwordHash.startsWith('$argon2id$'));
    assert.equal(await verifyPassword(row.passwordHash, tempPassword), true);
  });

  test('이메일을 소문자로 정규화한다', async () => {
    const { user } = await createUser(
      handle.db,
      { email: '  MiXeD@Example.COM ', displayName: '', role: 'member', orgs: [] },
      KEYS,
    );
    assert.equal(user.email, 'mixed@example.com');
  });

  test('이름이 비면 이메일을 쓴다', async () => {
    const { user } = await createUser(handle.db, { email: 'b@example.com', displayName: '  ', role: 'member', orgs: [] }, KEYS);
    assert.equal(user.displayName, 'b@example.com');
  });

  test('중복 이메일을 막는다', async () => {
    await seedAdmin('dup@example.com');
    await expectFail(
      () => createUser(handle.db, { email: 'DUP@example.com', displayName: 'x', role: 'member', orgs: [] }, KEYS),
      'email_taken',
    );
  });

  /** .env 에 없는 키를 주면 그 계정은 영영 아무것도 못 본다 */
  test('.env 에 없는 조직 키를 거부한다', async () => {
    await expectFail(
      () => createUser(handle.db, { email: 'c@example.com', displayName: 'c', role: 'member', orgs: [{ key: 'nope', allowProd: false }] }, KEYS),
      'unknown_org',
    );
  });

  test('조직별 prod 권한을 따로 저장한다', async () => {
    const { user } = await createUser(
      handle.db,
      {
        email: 'd@example.com',
        displayName: 'd',
        role: 'member',
        orgs: [
          { key: 'acme', allowProd: true },
          { key: 'globex', allowProd: false },
        ],
      },
      KEYS,
    );
    assert.deepEqual(
      [...user.orgs].sort((a, b) => a.key.localeCompare(b.key)),
      [
        { key: 'acme', allowProd: true },
        { key: 'globex', allowProd: false },
      ],
    );
  });
});

/**
 * 여기가 이 모듈의 핵심이다.
 * 관리자가 자기를 잠그거나 마지막 관리자를 없애면 되돌릴 방법이 없다.
 */
describe('잠금 방지', () => {
  test('자기 계정을 비활성화할 수 없다', async () => {
    const me = await seedAdmin();
    expectFailSync(() => updateUser(handle.db, me, { isActive: false }, me, KEYS), 'self_deactivate');
  });

  test('자기 관리자 권한을 뺄 수 없다', async () => {
    const me = await seedAdmin();
    expectFailSync(() => updateUser(handle.db, me, { role: 'member' }, me, KEYS), 'self_demote');
  });

  test('자기 계정을 지울 수 없다', async () => {
    const me = await seedAdmin();
    expectFailSync(() => deleteUser(handle.db, me, me), 'self_delete');
  });

  test('마지막 관리자를 member 로 내릴 수 없다', async () => {
    const me = await seedAdmin();
    const other = (await createUser(handle.db, { email: 'o@example.com', displayName: 'o', role: 'admin', orgs: [] }, KEYS)).user.id;
    // other 가 me 를 내리는 것은 되지만 (관리자가 둘이므로)
    updateUser(handle.db, me, { role: 'member' }, other, KEYS);
    // 이제 other 가 마지막 관리자다. 제3자가 내리려 해도 막혀야 한다.
    expectFailSync(() => updateUser(handle.db, other, { role: 'member' }, me, KEYS), 'last_admin');
  });

  test('마지막 관리자를 비활성화할 수 없다', async () => {
    const me = await seedAdmin();
    const other = (await createUser(handle.db, { email: 'o@example.com', displayName: 'o', role: 'admin', orgs: [] }, KEYS)).user.id;
    updateUser(handle.db, me, { role: 'member' }, other, KEYS);
    expectFailSync(() => updateUser(handle.db, other, { isActive: false }, me, KEYS), 'last_admin');
  });

  test('마지막 관리자를 지울 수 없다', async () => {
    const me = await seedAdmin();
    const other = (await createUser(handle.db, { email: 'o@example.com', displayName: 'o', role: 'member', orgs: [] }, KEYS)).user.id;
    expectFailSync(() => deleteUser(handle.db, me, other), 'last_admin');
  });

  test('관리자가 둘이면 하나는 내릴 수 있다', async () => {
    const me = await seedAdmin();
    const other = (await createUser(handle.db, { email: 'o@example.com', displayName: 'o', role: 'admin', orgs: [] }, KEYS)).user.id;
    const updated = updateUser(handle.db, other, { role: 'member' }, me, KEYS);
    assert.equal(updated.role, 'member');
  });

  test('비활성 관리자는 관리자 수에 들지 않는다', async () => {
    const me = await seedAdmin();
    const ghost = (await createUser(handle.db, { email: 'g@example.com', displayName: 'g', role: 'admin', orgs: [] }, KEYS)).user.id;
    updateUser(handle.db, ghost, { isActive: false }, me, KEYS);
    // 살아 있는 관리자는 me 하나뿐이다
    const third = (await createUser(handle.db, { email: 't@example.com', displayName: 't', role: 'member', orgs: [] }, KEYS)).user.id;
    expectFailSync(() => deleteUser(handle.db, me, third), 'last_admin');
  });
});

describe('권한 변경과 세션', () => {
  test('권한이 바뀌면 그 사용자의 세션을 끊는다', async () => {
    const me = await seedAdmin();
    const other = (await createUser(handle.db, { email: 'o@example.com', displayName: 'o', role: 'member', orgs: [{ key: 'acme', allowProd: true }] }, KEYS)).user.id;

    const { id: sid } = createSession(handle.db, other, 12, undefined);
    assert.ok(resolveSession(handle.db, sid), '전제: 세션이 살아 있다');

    updateUser(handle.db, other, { orgs: [{ key: 'acme', allowProd: false }] }, me, KEYS);
    assert.equal(resolveSession(handle.db, sid), null, '권한이 줄었는데 옛 세션이 살아 있으면 안 된다');
  });

  test('이름만 바꾸면 세션을 끊지 않는다', async () => {
    const me = await seedAdmin();
    const other = (await createUser(handle.db, { email: 'o@example.com', displayName: 'o', role: 'member', orgs: [] }, KEYS)).user.id;
    const { id: sid } = createSession(handle.db, other, 12, undefined);

    updateUser(handle.db, other, { displayName: '새 이름' }, me, KEYS);
    assert.ok(resolveSession(handle.db, sid), '이름 변경으로 로그아웃시킬 이유가 없다');
  });

  test('자기 자신을 고칠 때는 자기 세션을 끊지 않는다', async () => {
    const me = await seedAdmin();
    const { id: sid } = createSession(handle.db, me, 12, undefined);
    updateUser(handle.db, me, { orgs: [{ key: 'globex', allowProd: false }] }, me, KEYS);
    assert.ok(resolveSession(handle.db, sid), '고치는 중에 스스로 튕겨나가면 안 된다');
  });
});

describe('비밀번호 초기화', () => {
  test('새 임시 비밀번호를 주고 변경을 강제하며 세션을 끊는다', async () => {
    const me = await seedAdmin();
    const other = (await createUser(handle.db, { email: 'o@example.com', displayName: 'o', role: 'member', orgs: [] }, KEYS)).user.id;
    const { id: sid } = createSession(handle.db, other, 12, undefined);

    const temp = await resetPassword(handle.db, other);
    assert.equal(validatePassword(temp), null);

    const row = handle.db.select().from(users).where(eq(users.id, other)).get()!;
    assert.equal(await verifyPassword(row.passwordHash, temp), true);
    assert.equal(row.mustChangePassword, 1);
    assert.equal(resolveSession(handle.db, sid), null, '초기화 후 옛 세션이 살아 있으면 안 된다');
    void me;
  });

  test('없는 계정은 404', async () => {
    await expectFail(() => resetPassword(handle.db, 'nope'), 'not_found');
  });
});

describe('계정 삭제', () => {
  test('지우면 세션도 함께 사라진다', async () => {
    const me = await seedAdmin();
    const other = (await createUser(handle.db, { email: 'o@example.com', displayName: 'o', role: 'member', orgs: [] }, KEYS)).user.id;
    const { id: sid } = createSession(handle.db, other, 12, undefined);

    deleteUser(handle.db, other, me);
    assert.equal(resolveSession(handle.db, sid), null);
    assert.equal(listUsers(handle.db).find((u) => u.id === other), undefined);
  });

  /** 계정이 사라져도 누가 무엇을 했는지는 남아야 한다 */
  test('계정을 지워도 감사 기록은 남는다', async () => {
    const me = await seedAdmin();
    const other = (await createUser(handle.db, { email: 'gone@example.com', displayName: 'o', role: 'member', orgs: [] }, KEYS)).user.id;

    audit(handle.db, { userId: other, userEmail: 'gone@example.com', action: 'login' });
    deleteUser(handle.db, other, me);

    const rows = handle.db.select().from(auditLog).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.userEmail, 'gone@example.com', '이메일이 비정규화돼 있어야 기록이 살아남는다');
  });
});

describe('감사 로그 조회', () => {
  const t = (h: number) => Date.parse(`2026-08-28T${String(h).padStart(2, '0')}:00:00Z`);

  beforeEach(() => {
    const rows = [
      { at: t(1), email: 'a@example.com', action: 'login', org: 'acme' },
      { at: t(2), email: 'a@example.com', action: 'tail_open', org: 'acme' },
      { at: t(3), email: 'b@example.com', action: 'login', org: null },
      { at: t(4), email: 'b@example.com', action: 'export', org: 'globex' },
      { at: t(5), email: 'a@example.com', action: 'search', org: 'acme' },
    ];
    for (const r of rows) {
      handle.db
        .insert(auditLog)
        .values({ at: r.at, userId: null, userEmail: r.email, action: r.action, orgKey: r.org, detail: null })
        .run();
    }
  });

  test('최신순으로 준다', () => {
    const { rows, total } = queryAudit(handle.db, { limit: 10, offset: 0 });
    assert.equal(total, 5);
    assert.deepEqual(rows.map((r) => r.action), ['search', 'export', 'login', 'tail_open', 'login']);
  });

  test('시간 구간으로 거른다', () => {
    const { rows, total } = queryAudit(handle.db, { from: t(2), to: t(4), limit: 10, offset: 0 });
    assert.equal(total, 3);
    assert.deepEqual(rows.map((r) => r.action), ['export', 'login', 'tail_open']);
  });

  test('action 으로 거른다', () => {
    const { total } = queryAudit(handle.db, { action: 'login', limit: 10, offset: 0 });
    assert.equal(total, 2);
  });

  test('조직으로 거른다', () => {
    const { total } = queryAudit(handle.db, { orgKey: 'acme', limit: 10, offset: 0 });
    assert.equal(total, 3);
  });

  test('이메일 부분검색', () => {
    const { total } = queryAudit(handle.db, { q: 'b@', limit: 10, offset: 0 });
    assert.equal(total, 2);
  });

  test('페이지를 넘긴다 — total 은 전체 건수다', () => {
    const p1 = queryAudit(handle.db, { limit: 2, offset: 0 });
    const p2 = queryAudit(handle.db, { limit: 2, offset: 2 });
    assert.equal(p1.total, 5);
    assert.equal(p2.total, 5);
    assert.equal(p1.rows.length, 2);
    assert.notDeepEqual(p1.rows.map((r) => r.id), p2.rows.map((r) => r.id));
  });

  test('detail 을 JSON 으로 풀어준다', () => {
    handle.db
      .insert(auditLog)
      .values({ at: t(6), userId: null, userEmail: 'c@example.com', action: 'export', detail: '{"lines":10}' })
      .run();
    const { rows } = queryAudit(handle.db, { limit: 1, offset: 0 });
    assert.deepEqual(rows[0]!.detail, { lines: 10 });
  });

  test('깨진 detail 에도 던지지 않는다', () => {
    handle.db
      .insert(auditLog)
      .values({ at: t(7), userId: null, userEmail: 'c@example.com', action: 'export', detail: 'not json' })
      .run();
    const { rows } = queryAudit(handle.db, { limit: 1, offset: 0 });
    assert.equal(rows[0]!.detail, 'not json');
  });

  test('기록된 action 목록을 준다', () => {
    const actions = distinctAuditActions(handle.db);
    assert.deepEqual([...actions].sort(), ['export', 'login', 'search', 'tail_open']);
  });
});

describe('세션 강제 종료', () => {
  test('계정은 살려두고 세션만 끊는다 — 기기를 잃어버렸을 때 쓴다', async () => {
    const me = await seedAdmin();
    const other = (await createUser(handle.db, { email: 'o@example.com', displayName: 'o', role: 'member', orgs: [] }, KEYS)).user.id;
    const a = createSession(handle.db, other, 12, undefined);
    const b = createSession(handle.db, other, 12, undefined);
    const mine = createSession(handle.db, me, 12, undefined);

    const revoked = revokeSessions(handle.db, other);
    assert.equal(revoked, 2);
    assert.equal(resolveSession(handle.db, a.id), null);
    assert.equal(resolveSession(handle.db, b.id), null);
    assert.ok(resolveSession(handle.db, mine.id), '다른 사람 세션은 건드리지 않는다');

    const still = listUsers(handle.db).find((u) => u.id === other);
    assert.ok(still, '계정 자체는 남아야 한다');
    assert.equal(still.isActive, true);
    assert.equal(still.activeSessions, 0);
  });

  /** resetPassword 와 달리 비밀번호는 건드리지 않는다. 다시 로그인만 하면 된다. */
  test('비밀번호 상태를 바꾸지 않는다', async () => {
    const me = await seedAdmin();
    const other = (await createUser(handle.db, { email: 'o@example.com', displayName: 'o', role: 'member', orgs: [] }, KEYS)).user.id;
    // 비밀번호를 이미 바꾼 계정처럼 만든다
    handle.db.update(users).set({ mustChangePassword: 0 }).where(eq(users.id, other)).run();
    createSession(handle.db, other, 12, undefined);

    revokeSessions(handle.db, other);

    const after = listUsers(handle.db).find((u) => u.id === other)!;
    assert.equal(after.mustChangePassword, false, '세션만 끊는 것이지 비밀번호를 초기화하는 게 아니다');
    void me;
  });

  test('세션이 없으면 0을 준다', async () => {
    const me = await seedAdmin();
    assert.equal(revokeSessions(handle.db, me), 0);
  });

  test('없는 계정은 404', async () => {
    await seedAdmin();
    assert.throws(() => revokeSessions(handle.db, 'nope'), (e: unknown) => e instanceof AdminOpError && e.code === 'not_found');
  });
});

describe('감사 기록 보존', () => {
  const day = 86_400_000;
  const now = Date.parse('2026-08-29T00:00:00Z');

  const put = (daysAgo: number): void => {
    handle.db
      .insert(auditLog)
      .values({ at: now - daysAgo * day, userId: null, userEmail: 'a@example.com', action: 'login', detail: null })
      .run();
  };

  test('보존 기간이 지난 것만 지운다', () => {
    put(1);
    put(100);
    put(400);
    put(1000);
    assert.equal(auditRowCount(handle.db), 4);

    const purged = purgeOldAudit(handle.db, 365, now);
    assert.equal(purged, 2, '400일·1000일 전 두 건이 지워져야 한다');
    assert.equal(auditRowCount(handle.db), 2);
  });

  test('경계는 남긴다', () => {
    put(365);
    assert.equal(purgeOldAudit(handle.db, 365, now), 0, '정확히 365일 전은 아직 기간 안이다');
  });

  /** 0은 '영구 보관' 이다. 실수로 전부 지우면 안 된다. */
  test('0이면 아무것도 지우지 않는다', () => {
    put(10_000);
    assert.equal(purgeOldAudit(handle.db, 0, now), 0);
    assert.equal(auditRowCount(handle.db), 1);
  });

  test('음수도 안전하게 무시한다', () => {
    put(10_000);
    assert.equal(purgeOldAudit(handle.db, -1, now), 0);
    assert.equal(auditRowCount(handle.db), 1);
  });

  test('빈 테이블에 던지지 않는다', () => {
    assert.equal(purgeOldAudit(handle.db, 365, now), 0);
    assert.equal(auditRowCount(handle.db), 0);
  });
});
