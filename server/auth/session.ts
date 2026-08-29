import { randomBytes } from 'node:crypto';
import { eq, lt, and, gt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions, users, userOrgs, type UserRow } from '../db/schema.js';

export const SESSION_COOKIE = 'aclv_session';

export interface SessionUser {
  user: UserRow;
  sessionId: string;
  orgs: { orgKey: string; allowProd: boolean }[];
}

function newSessionId(): string {
  return randomBytes(32).toString('base64url'); // 256bit
}

export function createSession(db: Db, userId: string, ttlHours: number, userAgent: string | undefined): { id: string; expiresAt: number } {
  const id = newSessionId();
  const now = Date.now();
  const expiresAt = now + ttlHours * 3600_000;
  db.insert(sessions).values({ id, userId, createdAt: now, expiresAt, userAgent: userAgent ?? null }).run();
  return { id, expiresAt };
}

export function destroySession(db: Db, id: string): void {
  db.delete(sessions).where(eq(sessions.id, id)).run();
}

export function destroyUserSessions(db: Db, userId: string): void {
  db.delete(sessions).where(eq(sessions.userId, userId)).run();
}

/** 만료 세션 정리. 부팅 시와 1시간 주기로 호출한다. */
export function purgeExpiredSessions(db: Db): number {
  const res = db.delete(sessions).where(lt(sessions.expiresAt, Date.now())).run();
  return res.changes;
}

export function resolveSession(db: Db, sessionId: string): SessionUser | null {
  const row = db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, Date.now())))
    .get();

  if (!row || row.user.isActive !== 1) return null;

  const orgs = db
    .select({ orgKey: userOrgs.orgKey, allowProd: userOrgs.allowProd })
    .from(userOrgs)
    .where(eq(userOrgs.userId, row.user.id))
    .all()
    .map((o) => ({ orgKey: o.orgKey, allowProd: o.allowProd === 1 }));

  return { user: row.user, sessionId, orgs };
}
