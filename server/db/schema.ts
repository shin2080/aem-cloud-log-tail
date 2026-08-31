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

/**
 * 알림 규칙. 사용자가 "이 패턴이 뜨면 알려줘" 라고 등록한 것.
 *
 * 규칙이 하나라도 살아 있는 대상은 아무도 안 보고 있어도 폴링이 돈다 —
 * 그게 이 기능의 전부이자 비용이다. 상한은 ALERT_MAX_TARGETS 가 정한다.
 */
export const alertRules = sqliteTable(
  'alert_rules',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    orgKey: text('org_key').notNull(),
    environmentId: text('environment_id').notNull(),
    service: text('service').notNull(),
    logName: text('log_name').notNull(),
    /** 찾을 것. isRegex 가 0이면 그냥 부분문자열이다 */
    pattern: text('pattern').notNull(),
    isRegex: integer('is_regex').notNull().default(0),
    /** 쉼표로 이은 레벨. 비어 있으면 전체 */
    levels: text('levels'),
    /** 같은 사건을 다시 알리기까지 기다리는 시간 */
    cooldownSec: integer('cooldown_sec').notNull().default(300),
    enabled: integer('enabled').notNull().default(1),
    /**
     * 규칙이 스스로 꺼진 이유. 권한이 회수됐거나 정규식이 너무 느려서다.
     * 조용히 꺼지면 알림이 안 오는 걸 알 방법이 없으므로 이유를 남긴다.
     */
    disabledReason: text('disabled_reason'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_alert_rules_user').on(t.userId),
    index('idx_alert_rules_target').on(t.orgKey, t.environmentId, t.service, t.logName),
    index('idx_alert_rules_enabled').on(t.enabled),
  ],
);

/**
 * 규칙이 맞은 기록.
 *
 * **로그 본문은 넣지 않는다.** '본문은 메모리에만' 이 이 도구의 전제인데
 * 알림함이 그 구멍이 되면 안 된다. seq 만 들고 있다가 누르면 그 자리로 데려간다.
 * 밀려났으면 시간대 조회로 넘긴다.
 */
export const alertHits = sqliteTable(
  'alert_hits',
  {
    id: text('id').primaryKey(),
    ruleId: text('rule_id')
      .notNull()
      .references(() => alertRules.id, { onDelete: 'cascade' }),
    /** 같은 사건인지 가르는 지문. 쿨다운은 이 단위로 건다 */
    signature: text('signature').notNull(),
    firstTs: integer('first_ts').notNull(),
    lastTs: integer('last_ts').notNull(),
    count: integer('count').notNull().default(1),
    firstSeq: integer('first_seq').notNull(),
    lastSeq: integer('last_seq').notNull(),
    /** 어느 레벨이었는지. 목록에서 색을 고르는 데만 쓴다 */
    level: text('level').notNull(),
    readAt: integer('read_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_alert_hits_rule').on(t.ruleId),
    index('idx_alert_hits_created').on(t.createdAt),
    index('idx_alert_hits_unread').on(t.readAt),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type AlertRuleRow = typeof alertRules.$inferSelect;
export type AlertHitRow = typeof alertHits.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type EnvCacheRow = typeof envCache.$inferSelect;
