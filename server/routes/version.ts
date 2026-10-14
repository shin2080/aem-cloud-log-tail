import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireUser } from '../auth/middleware.js';

/**
 * 실행 중인 버전과, 관리자에게만, 새 릴리스 여부.
 *
 * 일반 뷰어에게 업데이트를 알려봐야 서버를 올릴 수 없다. 버전 자체는 누구나 본다 —
 * "어느 버전이에요?" 에 답할 수 있어야 한다.
 */
export function registerVersionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/version', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;

    const isAdmin = su.user.role === 'admin';
    const checker = ctx.updates;
    return reply.send({
      version: ctx.version,
      checkEnabled: checker !== null,
      update: isAdmin && checker ? checker.available() : null,
      checkedAt: isAdmin && checker ? checker.state().checkedAt : null,
    });
  });
}
