import type { FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import type { OrgConfig } from '../config/env.js';
import type { EnvironmentSummary } from '../../shared/types.js';
import { readEnv } from '../adobe/envcache.js';
import { fail } from './middleware.js';
import type { SessionUser } from './session.js';

export interface OrgGrant {
  org: OrgConfig;
  allowProd: boolean;
}

export interface EnvGrant extends OrgGrant {
  env: EnvironmentSummary;
}

/**
 * SPEC 8장의 인가 체크. 모든 데이터 라우트가 여기를 지난다.
 *
 * 거부는 전부 404 다. 403 을 쓰면 "그 조직/환경은 있는데 네가 못 볼 뿐"이라는
 * 정보가 새어 나간다. 존재 여부 자체를 흘리지 않는다.
 */

/** 2. 요청의 orgKey 가 user_orgs 에 있는가 */
export function authorizeOrg(ctx: AppContext, su: SessionUser, orgKey: string, reply: FastifyReply): OrgGrant | null {
  const access = su.orgs.find((o) => o.orgKey === orgKey);
  const org = ctx.cfg.orgs.get(orgKey);

  // .env 에서 조직이 빠졌는데 DB 에 권한만 남아 있는 경우도 여기서 걸린다.
  if (!access || !org) {
    fail(reply, 404, 'not_found', 'not_found');
    return null;
  }
  return { org, allowProd: access.allowProd };
}

/**
 * 3 + 4. prod 열람 권한과 (orgKey, envId) 쌍 일치를 함께 본다.
 *
 * 4번이 있어야 A사 계정이 B사의 환경 ID 를 직접 넘기는 시도를 막을 수 있다.
 * env_cache 에서 그 조직의 환경으로 확인되지 않으면 존재하지 않는 것으로 취급한다.
 */
export function authorizeEnv(
  ctx: AppContext,
  su: SessionUser,
  orgKey: string,
  environmentId: string,
  reply: FastifyReply,
): EnvGrant | null {
  const grant = authorizeOrg(ctx, su, orgKey, reply);
  if (!grant) return null;

  const env = readEnv(ctx.handle.db, orgKey, environmentId);
  if (!env) {
    // 캐시에 없다 = 이 조직의 환경이 아니거나 아직 새로고침하지 않았다.
    fail(reply, 404, 'not_found', 'not_found');
    return null;
  }

  // prod 로그에는 실사용자 데이터가 섞인다. 조직 접근 권한과 prod 열람 권한은 별개다.
  if (env.environmentType === 'prod' && !grant.allowProd) {
    fail(reply, 404, 'not_found', 'not_found');
    return null;
  }

  return { ...grant, env };
}
