import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireUser } from '../auth/middleware.js';
import type { PublicOrg } from '../config/env.js';

export function registerOrgRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * 세션 사용자에게 허용된 조직만 반환한다.
   * 응답에는 key 와 label 만 담는다 — clientId/secret/imsOrgId 는 절대 직렬화하지 않는다.
   */
  app.get('/api/orgs', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;

    const orgs: PublicOrg[] = su.orgs
      .map((a) => ctx.cfg.orgs.get(a.orgKey))
      .filter((o): o is NonNullable<typeof o> => o !== undefined)
      .map((o) => ({ key: o.key, label: o.label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ko'));

    /**
     * .env 에는 있는데 이 계정에는 권한이 없는 조직.
     *
     * '.env 에 넣었는데 왜 안 보이지' 가 가장 헷갈리는 지점이다.
     * 조직 접근은 관리자가 명시적으로 주는 것이라 자동으로 붙지 않는다 —
     * 그 사실을 화면이 말해줘야 한다.
     */
    const granted = new Set(su.orgs.map((a) => a.orgKey));
    const notGranted: PublicOrg[] = [...ctx.cfg.orgs.values()]
      .filter((o) => !granted.has(o.key))
      .map((o) => ({ key: o.key, label: o.label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ko'));

    /** DB 에 권한만 남고 .env 에서 사라진 조직. 정리 대상이다. */
    const stale = su.orgs.map((a) => a.orgKey).filter((k) => !ctx.cfg.orgs.has(k));

    return reply.send({ orgs, notGranted, stale, isAdmin: su.user.role === 'admin' });
  });
}
