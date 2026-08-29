import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireUser, fail, clientIp } from '../auth/middleware.js';
import { authorizeOrg, authorizeEnv } from '../auth/authz.js';
import { audit } from '../auth/audit.js';
import {
  readEnvCache,
  refreshEnvCache,
  refreshLogOptions,
  isStale,
  isCacheStaleForCredentials,
} from '../adobe/envcache.js';
import { CloudManagerError } from '../adobe/cloudmanager.js';
import { ImsError } from '../adobe/ims.js';
import { supportedLogNames } from '../parse/parser.js';
import type { MsgKey, MsgParams } from '../i18n/messages.js';

const params = z.object({ orgKey: z.string().min(1).max(64) });
const envParams = params.extend({ envId: z.string().min(1).max(64) });

/** 조직 하나가 죽어도 나머지는 계속 동작해야 한다. 오류를 사람이 읽을 수 있게 바꾼다. */
function describeUpstream(err: unknown): {
  code: string;
  key: MsgKey;
  params?: MsgParams;
  status: number;
} {
  if (err instanceof ImsError) {
    return { code: 'org_credentials_failed', key: 'org_credentials_failed', status: 502 };
  }
  if (err instanceof CloudManagerError) {
    if (err.status === 429) return { code: 'rate_limited', key: 'rate_limited', status: 429 };
    if (err.status === 403) return { code: 'access_denied', key: 'access_denied', status: 403 };
    return {
      code: 'cloud_manager_failed',
      key: 'cloud_manager_failed',
      params: { status: err.status },
      status: 502,
    };
  }
  return { code: 'upstream_failed', key: 'upstream_failed', status: 502 };
}

export function registerEnvironmentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx.handle;

  app.get('/api/orgs/:orgKey/environments', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;

    const p = params.safeParse(req.params);
    if (!p.success) return fail(reply, 400, 'invalid_request', 'org_key_required');

    const grant = authorizeOrg(ctx, su, p.data.orgKey, reply);
    if (!grant) return reply;

    const forced = (req.query as { refresh?: string } | undefined)?.refresh === 'true';
    let rows = readEnvCache(db, grant.org.key);

    // 자격증명이 바뀌었으면 캐시는 남의 환경을 들고 있는 셈이다. 반드시 다시 받는다.
    const wrongCredentials = isCacheStaleForCredentials(db, grant.org);
    if (wrongCredentials) {
      req.log.warn({ orgKey: grant.org.key }, 'env_cache was built with different credentials — refreshing');
    }

    if (forced || wrongCredentials || isStale(rows)) {
      try {
        rows = await refreshEnvCache(db, ctx.cm, grant.org);
        audit(db, {
          userId: su.user.id,
          userEmail: su.user.email,
          action: 'env_refresh',
          orgKey: grant.org.key,
          detail: { count: rows.length, forced },
          ip: clientIp(req),
        });
      } catch (err) {
        req.log.error({ err, orgKey: grant.org.key }, 'env refresh failed');
        // 자격증명이 어긋난 캐시는 보여주면 안 된다. 남의 조직 환경이다.
        if (wrongCredentials) {
          const d = describeUpstream(err);
          return fail(reply, d.status, d.code, d.key, d.params);
        }
        // 캐시라도 있으면 그걸 준다. 조직 하나의 자격증명 만료가 화면 전체를 막지 않는다.
        if (rows.length === 0) {
          const d = describeUpstream(err);
          return fail(reply, d.status, d.code, d.key, d.params);
        }
      }
    }

    // prod 열람 권한이 없으면 prod 환경은 목록에서도 뺀다.
    const visible = grant.allowProd ? rows : rows.filter((r) => r.environmentType !== 'prod');
    return reply.send({ environments: visible, stale: isStale(visible) });
  });

  app.get('/api/orgs/:orgKey/environments/:envId/log-options', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;

    const p = envParams.safeParse(req.params);
    if (!p.success) return fail(reply, 400, 'invalid_request', 'org_env_required');

    const grant = authorizeEnv(ctx, su, p.data.orgKey, p.data.envId, reply);
    if (!grant) return reply;

    const cached = grant.env.availableServices;
    const forced = (req.query as { refresh?: string } | undefined)?.refresh === 'true';
    // 파서가 있는 로그만 뷰어에서 열 수 있다. 어느 것이 열리는지 프론트가 알아야 한다.
    const supported = supportedLogNames();
    if (cached.length > 0 && !forced) return reply.send({ services: cached, supported });

    try {
      const services = await refreshLogOptions(db, ctx.cm, grant.org, grant.env.programId, grant.env.environmentId);
      return reply.send({ services, supported });
    } catch (err) {
      req.log.error({ err, orgKey: grant.org.key, envId: grant.env.environmentId }, 'log options failed');
      const d = describeUpstream(err);
      return fail(reply, d.status, d.code, d.key, d.params);
    }
  });
}
