import { lt, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { auditLog } from '../db/schema.js';

export type AuditAction =
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'password_changed'
  | 'tail_open'
  | 'tail_close'
  | 'search'
  | 'export'
  | 'env_refresh'
  // 규칙 등록은 "아무도 안 볼 때도 이 로그를 계속 읽겠다" 는 선언이라 남긴다.
  | 'alert_rule_created'
  | 'admin_user_create'
  | 'admin_user_update'
  | 'admin_user_delete'
  | 'admin_password_reset';

export interface AuditEntry {
  userId?: string | null;
  userEmail: string;
  action: AuditAction;
  orgKey?: string | null;
  environmentId?: string | null;
  environmentType?: string | null;
  detail?: unknown;
  ip?: string | null;
}

/**
 * 보존 기간이 지난 기록을 지운다. 부팅 시와 하루 주기로 호출한다.
 *
 * 사용자가 부를 수 있는 삭제 API 는 없다 — 누가 흔적을 지우지 못하게 하는 것이
 * 목적이므로, 나이만 보고 기계적으로 정리하는 이 경로만 둔다.
 * days 가 0이면 영구 보관한다.
 */
export function purgeOldAudit(db: Db, days: number, now = Date.now()): number {
  if (days <= 0) return 0;
  const cutoff = now - days * 86_400_000;
  return db.delete(auditLog).where(lt(auditLog.at, cutoff)).run().changes;
}

/** 지금 몇 건이나 쌓여 있는지 (운영 확인용) */
export function auditRowCount(db: Db): number {
  return db.select({ n: sql<number>`count(*)` }).from(auditLog).get()?.n ?? 0;
}

/** 감사 기록은 삭제 API 를 만들지 않는다. 조회만 가능하다. */
export function audit(db: Db, e: AuditEntry): void {
  db.insert(auditLog)
    .values({
      at: Date.now(),
      userId: e.userId ?? null,
      userEmail: e.userEmail,
      action: e.action,
      orgKey: e.orgKey ?? null,
      environmentId: e.environmentId ?? null,
      environmentType: e.environmentType ?? null,
      detail: e.detail === undefined ? null : JSON.stringify(e.detail),
      ip: e.ip ?? null,
    })
    .run();
}
