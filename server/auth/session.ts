import { randomBytes } from 'node:crypto';
import { eq, lt, and, gt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions, users, userOrgs, type UserRow } from '../db/schema.js';

export const SESSION_COOKIE = 'aclv_session';

export interface SessionUser {
  user: UserRow;
  sessionId: string;
  /** 세션 행의 시각. 슬라이딩 갱신이 절대 상한을 넘지 않게 하려면 둘 다 필요하다. */
  createdAt: number;
  expiresAt: number;
  orgs: { orgKey: string; allowProd: boolean }[];
}

/**
 * 남은 시간이 유효기간의 이 비율 아래로 내려가면 갱신한다.
 * 요청마다 DB 를 쓰지 않기 위한 문턱이다.
 */
const RENEW_BELOW = 0.5;

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

  return {
    user: row.user,
    sessionId,
    createdAt: row.session.createdAt,
    expiresAt: row.session.expiresAt,
    orgs,
  };
}

/**
 * 쓰는 동안에는 세션을 연장한다 (슬라이딩 만료).
 *
 * 이게 없으면 SESSION_TTL_HOURS 가 곧 '화면이 죽는 주기' 다 — 모니터에 걸어두면
 * 하루에 한 번 사람이 가서 다시 로그인해야 한다. 그렇다고 유효기간을 무한으로 두면
 * 상시 로그인된 브라우저가 그대로 상시 유효한 자격증명이 되므로,
 * 유휴 기준(ttlHours)은 짧게 두고 절대 상한(maxHours)으로 천장을 만든다.
 *
 * 갱신했으면 새 만료 시각을, 아직 넉넉하거나 천장에 닿았으면 null 을 준다.
 */
export function touchSession(db: Db, su: SessionUser, ttlHours: number, maxHours: number): number | null {
  const now = Date.now();
  const ttlMs = ttlHours * 3600_000;
  if (su.expiresAt - now > ttlMs * RENEW_BELOW) return null; // 아직 절반 넘게 남았다

  // 절대 상한을 넘겨서는 연장하지 않는다. 그 뒤로는 조용히 만료된다.
  const next = Math.min(now + ttlMs, su.createdAt + maxHours * 3600_000);
  if (next <= su.expiresAt) return null;

  db.update(sessions).set({ expiresAt: next }).where(eq(sessions.id, su.sessionId)).run();
  return next;
}
