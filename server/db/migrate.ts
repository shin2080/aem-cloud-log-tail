import type Database from 'better-sqlite3';

/**
 * 손으로 관리하는 마이그레이션. drizzle-kit 을 쓰지 않는 이유는 docs/dependencies.md 에 적었다.
 *
 * 규칙: 이미 적용된 항목은 절대 수정하지 않는다. 항상 뒤에 추가한다.
 */
interface Migration {
  id: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    id: '0001_init',
    sql: /* sql */ `
      CREATE TABLE users (
        id                   TEXT PRIMARY KEY,
        email                TEXT NOT NULL UNIQUE,
        password_hash        TEXT NOT NULL,
        display_name         TEXT NOT NULL,
        role                 TEXT NOT NULL CHECK (role IN ('admin','member')),
        must_change_password INTEGER NOT NULL DEFAULT 0,
        is_active            INTEGER NOT NULL DEFAULT 1,
        created_at           INTEGER NOT NULL,
        last_login_at        INTEGER
      );

      CREATE TABLE user_orgs (
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        org_key    TEXT NOT NULL,
        allow_prod INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, org_key)
      );

      CREATE TABLE sessions (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        user_agent TEXT
      );
      CREATE INDEX idx_sessions_expires ON sessions(expires_at);

      CREATE TABLE env_cache (
        org_key            TEXT NOT NULL,
        program_id         TEXT NOT NULL,
        program_name       TEXT NOT NULL,
        environment_id     TEXT NOT NULL,
        environment_name   TEXT NOT NULL,
        environment_type   TEXT NOT NULL CHECK (environment_type IN ('dev','stage','prod','rde')),
        available_services TEXT,
        refreshed_at       INTEGER NOT NULL,
        PRIMARY KEY (org_key, environment_id)
      );

      CREATE TABLE audit_log (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        at               INTEGER NOT NULL,
        user_id          TEXT,
        user_email       TEXT NOT NULL,
        action           TEXT NOT NULL,
        org_key          TEXT,
        environment_id   TEXT,
        environment_type TEXT,
        detail           TEXT,
        ip               TEXT
      );
      CREATE INDEX idx_audit_at     ON audit_log(at);
      CREATE INDEX idx_audit_user   ON audit_log(user_id);
      CREATE INDEX idx_audit_action ON audit_log(action);

      CREATE TABLE saved_filters (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    id: '0002_missing_indexes',
    sql: /* sql */ `
      -- saved_filters 는 항상 user_id 로만 조회한다
      CREATE INDEX idx_saved_filters_user ON saved_filters(user_id);
      -- 감사 로그를 조직으로 거르는 화면이 있다
      CREATE INDEX idx_audit_org ON audit_log(org_key);
    `,
  },
  {
    id: '0003_env_cache_credential_fingerprint',
    sql: /* sql */ `
      -- 어떤 자격증명으로 채운 캐시인지 남긴다.
      -- .env 에서 ORG_n_KEY 는 그대로 두고 자격증명만 갈아끼우면
      -- 캐시는 옛 조직의 환경을 들고 있는데 호출은 새 자격증명으로 나가 403 이 된다.
      ALTER TABLE env_cache ADD COLUMN credential_id TEXT;
    `,
  },
];

export function runMigrations(db: Database.Database): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);

  const applied = new Set(db.prepare(`SELECT id FROM _migrations`).all().map((r) => (r as { id: string }).id));
  const ran: string[] = [];

  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare(`INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`).run(m.id, Date.now());
    })();
    ran.push(m.id);
  }
  return ran;
}
