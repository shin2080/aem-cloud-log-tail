import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, gte, lte, like, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { users, userOrgs, sessions, auditLog } from '../db/schema.js';
import { generateTempPassword, hashPassword } from './password.js';
import { destroyUserSessions } from './session.js';
import type { MsgKey, MsgParams } from '../i18n/messages.js';

/** ScanError 와 같은 이유로 키를 든다. i18n/messages.ts 를 볼 것. */
export class AdminOpError extends Error {
  constructor(
    readonly code: string,
    readonly key: MsgKey,
    readonly status = 400,
    readonly params?: MsgParams,
  ) {
    super(key);
    this.name = 'AdminOpError';
  }
}

export interface AdminUserView {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'member';
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  orgs: { key: string; allowProd: boolean }[];
  activeSessions: number;
}

export interface OrgGrantInput {
  key: string;
  allowProd: boolean;
}

function readOrgs(db: Db, userId: string): { key: string; allowProd: boolean }[] {
  return db
    .select()
    .from(userOrgs)
    .where(eq(userOrgs.userId, userId))
    .all()
    .map((o) => ({ key: o.orgKey, allowProd: o.allowProd === 1 }));
}

export function listUsers(db: Db): AdminUserView[] {
  const now = Date.now();
  return db
    .select()
    .from(users)
    .all()
    .map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      isActive: u.isActive === 1,
      mustChangePassword: u.mustChangePassword === 1,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      orgs: readOrgs(db, u.id),
      activeSessions:
        db
          .select({ n: count() })
          .from(sessions)
          .where(and(eq(sessions.userId, u.id), gte(sessions.expiresAt, now)))
          .get()?.n ?? 0,
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

function countActiveAdmins(db: Db, excludingId?: string): number {
  const rows = db.select().from(users).where(and(eq(users.role, 'admin'), eq(users.isActive, 1))).all();
  return rows.filter((r) => r.id !== excludingId).length;
}

/** .env 에 없는 조직 키를 부여하면 그 계정은 영영 아무것도 못 본다. 미리 막는다. */
function validateOrgs(orgs: OrgGrantInput[], knownKeys: Set<string>): void {
  const unknown = orgs.filter((o) => !knownKeys.has(o.key)).map((o) => o.key);
  if (unknown.length > 0) {
    throw new AdminOpError('unknown_org', 'unknown_org', 400, { orgs: unknown.join(', ') });
  }
}

function writeOrgs(db: Db, userId: string, orgs: OrgGrantInput[]): void {
  db.delete(userOrgs).where(eq(userOrgs.userId, userId)).run();
  if (orgs.length === 0) return;
  db.insert(userOrgs)
    .values(orgs.map((o) => ({ userId, orgKey: o.key, allowProd: o.allowProd ? 1 : 0 })))
    .run();
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  role: 'admin' | 'member';
  orgs: OrgGrantInput[];
}

/**
 * 계정 발급. 임시 비밀번호는 여기서 한 번만 돌려주고 어디에도 저장하지 않는다.
 * 회원가입 엔드포인트는 존재하지 않는다 — 계정은 관리자만 만든다.
 */
export async function createUser(
  db: Db,
  input: CreateUserInput,
  knownKeys: Set<string>,
): Promise<{ user: AdminUserView; tempPassword: string }> {
  const email = input.email.trim().toLowerCase();
  if (db.select().from(users).where(eq(users.email, email)).get()) {
    throw new AdminOpError('email_taken', 'email_taken');
  }
  validateOrgs(input.orgs, knownKeys);

  const tempPassword = generateTempPassword();
  const id = randomUUID();

  db.insert(users)
    .values({
      id,
      email,
      passwordHash: await hashPassword(tempPassword),
      displayName: input.displayName.trim() || email,
      role: input.role,
      mustChangePassword: 1,
      isActive: 1,
      createdAt: Date.now(),
    })
    .run();
  writeOrgs(db, id, input.orgs);

  const user = listUsers(db).find((u) => u.id === id)!;
  return { user, tempPassword };
}

export interface UpdateUserInput {
  displayName?: string;
  role?: 'admin' | 'member';
  isActive?: boolean;
  orgs?: OrgGrantInput[];
}

export function updateUser(
  db: Db,
  targetId: string,
  patch: UpdateUserInput,
  actorId: string,
  knownKeys: Set<string>,
): AdminUserView {
  const target = db.select().from(users).where(eq(users.id, targetId)).get();
  if (!target) throw new AdminOpError('not_found', 'not_found', 404);

  // 자기 자신을 잠그면 되돌릴 방법이 없다.
  if (targetId === actorId) {
    if (patch.isActive === false) throw new AdminOpError('self_deactivate', 'self_deactivate');
    if (patch.role === 'member') throw new AdminOpError('self_demote', 'self_demote');
  }

  // 마지막 관리자를 잃으면 아무도 계정을 만들 수 없다.
  const losingAdmin = target.role === 'admin' && (patch.role === 'member' || patch.isActive === false);
  if (losingAdmin && countActiveAdmins(db, targetId) === 0) {
    throw new AdminOpError('last_admin', 'last_admin');
  }

  if (patch.orgs) validateOrgs(patch.orgs, knownKeys);

  const set: Partial<typeof users.$inferInsert> = {};
  if (patch.displayName !== undefined) set.displayName = patch.displayName.trim() || target.email;
  if (patch.role !== undefined) set.role = patch.role;
  if (patch.isActive !== undefined) set.isActive = patch.isActive ? 1 : 0;
  if (Object.keys(set).length > 0) db.update(users).set(set).where(eq(users.id, targetId)).run();

  if (patch.orgs) writeOrgs(db, targetId, patch.orgs);

  // 권한이 줄었을 수 있다. 살아 있는 세션이 옛 권한으로 계속 도는 것을 막는다.
  const privilegeChanged = patch.role !== undefined || patch.isActive !== undefined || patch.orgs !== undefined;
  if (privilegeChanged && targetId !== actorId) destroyUserSessions(db, targetId);

  return listUsers(db).find((u) => u.id === targetId)!;
}

export async function resetPassword(db: Db, targetId: string): Promise<string> {
  const target = db.select().from(users).where(eq(users.id, targetId)).get();
  if (!target) throw new AdminOpError('not_found', 'not_found', 404);

  const tempPassword = generateTempPassword();
  db.update(users)
    .set({ passwordHash: await hashPassword(tempPassword), mustChangePassword: 1 })
    .where(eq(users.id, targetId))
    .run();

  // 비밀번호를 바꿨으면 기존 세션은 모두 끊는다.
  destroyUserSessions(db, targetId);
  return tempPassword;
}

/** 노트북을 잃어버렸을 때처럼, 계정은 살려두고 세션만 끊어야 하는 경우가 있다. */
export function revokeSessions(db: Db, targetId: string): number {
  const target = db.select().from(users).where(eq(users.id, targetId)).get();
  if (!target) throw new AdminOpError('not_found', 'not_found', 404);

  const before =
    db
      .select({ n: count() })
      .from(sessions)
      .where(and(eq(sessions.userId, targetId), gte(sessions.expiresAt, Date.now())))
      .get()?.n ?? 0;

  destroyUserSessions(db, targetId);
  return before;
}

export function deleteUser(db: Db, targetId: string, actorId: string): { email: string } {
  const target = db.select().from(users).where(eq(users.id, targetId)).get();
  if (!target) throw new AdminOpError('not_found', 'not_found', 404);
  if (targetId === actorId) throw new AdminOpError('self_delete', 'self_delete');
  if (target.role === 'admin' && countActiveAdmins(db, targetId) === 0) {
    throw new AdminOpError('last_admin', 'last_admin');
  }

  // user_orgs · sessions · saved_filters 는 ON DELETE CASCADE 로 함께 지워진다.
  // audit_log 는 user_email 을 비정규화해 뒀으므로 기록이 남는다.
  db.delete(users).where(eq(users.id, targetId)).run();
  return { email: target.email };
}

/* ── 감사 로그 조회 ───────────────────────────────────── */

export interface AuditQuery {
  from?: number;
  to?: number;
  userId?: string;
  action?: string;
  orgKey?: string;
  q?: string;
  limit: number;
  offset: number;
}

export interface AuditRow {
  id: number;
  at: number;
  userId: string | null;
  userEmail: string;
  action: string;
  orgKey: string | null;
  environmentId: string | null;
  environmentType: string | null;
  detail: unknown;
  ip: string | null;
}

/** 감사 기록은 조회만 된다. 삭제 API 는 만들지 않는다. */
export function queryAudit(db: Db, q: AuditQuery): { rows: AuditRow[]; total: number } {
  const conds = [];
  if (q.from !== undefined) conds.push(gte(auditLog.at, q.from));
  if (q.to !== undefined) conds.push(lte(auditLog.at, q.to));
  if (q.userId) conds.push(eq(auditLog.userId, q.userId));
  if (q.action) conds.push(eq(auditLog.action, q.action));
  if (q.orgKey) conds.push(eq(auditLog.orgKey, q.orgKey));
  if (q.q) conds.push(like(auditLog.userEmail, `%${q.q}%`));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const total = db.select({ n: count() }).from(auditLog).where(where).get()?.n ?? 0;

  const rows = db
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(q.limit)
    .offset(q.offset)
    .all()
    .map((r) => ({
      id: r.id,
      at: r.at,
      userId: r.userId,
      userEmail: r.userEmail,
      action: r.action,
      orgKey: r.orgKey,
      environmentId: r.environmentId,
      environmentType: r.environmentType,
      detail: r.detail ? safeParse(r.detail) : null,
      ip: r.ip,
    }));

  return { rows, total };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** 필터 드롭다운을 채우기 위한 실제로 기록된 action 목록 */
export function distinctAuditActions(db: Db): string[] {
  return db
    .select({ action: auditLog.action })
    .from(auditLog)
    .groupBy(auditLog.action)
    .orderBy(sql`count(*) desc`)
    .all()
    .map((r) => r.action);
}
