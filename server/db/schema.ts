import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

/**
 * 로그 본문 테이블은 없다. 있으면 안 된다.
 * 여기에 들어가는 것은 설정·계정·감사 기록뿐이다.
 */

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(), // argon2id
  displayName: text('display_name').notNull(),
  role: text('role', { enum: ['admin', 'member'] }).notNull(),
  mustChangePassword: integer('must_change_password').notNull().default(0),
  isActive: integer('is_active').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  lastLoginAt: integer('last_login_at'),
});

export const userOrgs = sqliteTable(
  'user_orgs',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgKey: text('org_key').notNull(), // .env 의 ORG_n_KEY
    allowProd: integer('allow_prod').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.orgKey] })],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(), // 랜덤 256bit
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    userAgent: text('user_agent'),
  },
  (t) => [index('idx_sessions_expires').on(t.expiresAt)],
);

export const envCache = sqliteTable(
  'env_cache',
  {
    orgKey: text('org_key').notNull(),
    programId: text('program_id').notNull(),
    programName: text('program_name').notNull(),
    environmentId: text('environment_id').notNull(),
    environmentName: text('environment_name').notNull(),
    environmentType: text('environment_type', { enum: ['dev', 'stage', 'prod', 'rde'] }).notNull(),
    /** JSON: [{ service, logNames[] }] */
    availableServices: text('available_services'),
    refreshedAt: integer('refreshed_at').notNull(),
    /**
     * 이 캐시를 채운 자격증명의 식별자(CLIENT_ID).
     * .env 에서 키는 그대로 두고 자격증명만 바꾸면 캐시가 남의 환경을 들고 있게 된다.
     */
    credentialId: text('credential_id'),
  },
  (t) => [primaryKey({ columns: [t.orgKey, t.environmentId] })],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: integer('at').notNull(),
    userId: text('user_id'),
    /** 계정이 삭제돼도 기록이 남도록 비정규화 */
    userEmail: text('user_email').notNull(),
    action: text('action').notNull(),
    orgKey: text('org_key'),
    environmentId: text('environment_id'),
    environmentType: text('environment_type'),
    /** JSON: 범위, 필터, 라인 수, 바이트 수 */
    detail: text('detail'),
    ip: text('ip'),
  },
  (t) => [
    index('idx_audit_at').on(t.at),
    index('idx_audit_user').on(t.userId),
    index('idx_audit_action').on(t.action),
    index('idx_audit_org').on(t.orgKey),
  ],
);

export const savedFilters = sqliteTable(
  'saved_filters',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    payload: text('payload').notNull(), // JSON
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_saved_filters_user').on(t.userId)],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type EnvCacheRow = typeof envCache.$inferSelect;
