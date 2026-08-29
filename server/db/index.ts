import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { runMigrations } from './migrate.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  raw: Database.Database;
  close(): void;
}

export function openDb(path: string): DbHandle {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const raw = new Database(path);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');

  const ran = runMigrations(raw);
  if (ran.length > 0) console.log(`[db] 마이그레이션 적용: ${ran.join(', ')}`);

  return { db: drizzle(raw, { schema }), raw, close: () => raw.close() };
}
