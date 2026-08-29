import { eq, and } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { envCache } from '../db/schema.js';
import type { AvailableService, EnvironmentSummary } from '../../shared/types.js';
import type { OrgConfig } from '../config/env.js';
import { CloudManagerClient } from './cloudmanager.js';

/** 캐시가 이보다 오래되면 자동으로 다시 받아온다. */
export const ENV_CACHE_TTL_MS = 30 * 60_000;

function toSummary(row: typeof envCache.$inferSelect): EnvironmentSummary {
  let availableServices: AvailableService[] = [];
  if (row.availableServices) {
    try {
      availableServices = JSON.parse(row.availableServices) as AvailableService[];
    } catch {
      availableServices = [];
    }
  }
  return {
    orgKey: row.orgKey,
    programId: row.programId,
    programName: row.programName,
    environmentId: row.environmentId,
    environmentName: row.environmentName,
    environmentType: row.environmentType,
    availableServices,
    refreshedAt: row.refreshedAt,
  };
}

export function readEnvCache(db: Db, orgKey: string): EnvironmentSummary[] {
  return db.select().from(envCache).where(eq(envCache.orgKey, orgKey)).all().map(toSummary);
}

/**
 * 이 캐시가 지금의 자격증명으로 채워진 것인가.
 *
 * `.env` 에서 `ORG_n_KEY` 는 그대로 두고 자격증명만 갈아끼우면, 캐시는 옛 조직의
 * 환경 목록을 들고 있는데 호출은 새 자격증명으로 나간다. 인가는 캐시를 믿으므로
 * 통과하고, Adobe 가 403 을 준다 — 원인을 짐작하기 어려운 형태로 실패한다.
 * 실제로 겪었다.
 */
export function isCacheStaleForCredentials(db: Db, org: OrgConfig): boolean {
  const rows = db.select().from(envCache).where(eq(envCache.orgKey, org.key)).all();
  if (rows.length === 0) return false;
  // 지문이 없는 건 이 컬럼이 생기기 전에 채운 것이다. 한 번은 다시 받게 한다.
  return rows.some((r) => r.credentialId !== org.clientId);
}

export function readEnv(db: Db, orgKey: string, environmentId: string): EnvironmentSummary | null {
  const row = db
    .select()
    .from(envCache)
    .where(and(eq(envCache.orgKey, orgKey), eq(envCache.environmentId, environmentId)))
    .get();
  return row ? toSummary(row) : null;
}

export function isStale(rows: EnvironmentSummary[], now = Date.now()): boolean {
  if (rows.length === 0) return true;
  return rows.some((r) => now - r.refreshedAt > ENV_CACHE_TTL_MS);
}

/**
 * Cloud Manager 에서 프로그램·환경을 다시 받아 env_cache 를 채운다.
 *
 * 프로그램·환경 목록을 .env 에 넣지 않는 이유가 이것이다 —
 * 고객사 환경이 늘어나도 .env 를 건드리지 않는다.
 */
export async function refreshEnvCache(
  db: Db,
  cm: CloudManagerClient,
  org: OrgConfig,
): Promise<EnvironmentSummary[]> {
  const programs = await cm.listPrograms(org);
  const now = Date.now();
  const rows: (typeof envCache.$inferInsert)[] = [];

  for (const program of programs) {
    const environments = await cm.listEnvironments(org, program.id);
    for (const env of environments) {
      rows.push({
        orgKey: org.key,
        programId: program.id,
        programName: program.name,
        environmentId: env.id,
        environmentName: env.name,
        environmentType: env.type,
        // 로그 옵션은 환경을 실제로 열 때 채운다. 환경마다 API 를 한 번씩 더 부르면
        // 조직 하나 새로고침에 수십 콜이 나가고 레이트 리밋을 태운다.
        availableServices: null,
        refreshedAt: now,
        credentialId: org.clientId,
      });
    }
  }

  db.transaction((tx) => {
    tx.delete(envCache).where(eq(envCache.orgKey, org.key)).run();
    if (rows.length > 0) tx.insert(envCache).values(rows).run();
  });

  return readEnvCache(db, org.key);
}

/**
 * 한 환경의 가용 로그 옵션(서비스 × 로그이름)을 받아 캐시에 적어 넣는다.
 * days=1 이어도 오늘·어제 두 날짜가 오므로 중복을 접어야 한다 (Phase 0 관측).
 */
export async function refreshLogOptions(
  db: Db,
  cm: CloudManagerClient,
  org: OrgConfig,
  programId: string,
  environmentId: string,
): Promise<AvailableService[]> {
  const options = await cm.listLogOptions(org, programId, environmentId, 1);

  const byService = new Map<string, Set<string>>();
  for (const o of options) {
    if (!o.service || !o.name) continue;
    let set = byService.get(o.service);
    if (!set) {
      set = new Set();
      byService.set(o.service, set);
    }
    set.add(o.name);
  }

  const services: AvailableService[] = [...byService.entries()]
    .map(([service, names]) => ({ service, logNames: [...names].sort() }))
    .sort((a, b) => a.service.localeCompare(b.service));

  db.update(envCache)
    .set({ availableServices: JSON.stringify(services) })
    .where(and(eq(envCache.orgKey, org.key), eq(envCache.environmentId, environmentId)))
    .run();

  return services;
}
