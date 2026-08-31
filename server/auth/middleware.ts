import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/cookie'; // FastifyRequest.cookies / FastifyReply.clearCookie 타입 확장
import type { AppContext } from '../context.js';
import { SESSION_COOKIE, resolveSession, touchSession, type SessionUser } from './session.js';
import { sessionCookieOptions } from './cookie.js';
import { langFrom, msg, type MsgKey, type MsgParams } from '../i18n/messages.js';

declare module 'fastify' {
  interface FastifyRequest {
    sessionUser?: SessionUser;
  }
}

/**
 * 오류 응답. 메시지는 글이 아니라 키로 받는다 — 요청의 `X-Lang` 을 보고 고른다.
 *
 * `code` 는 그대로 둔다. 화면이 코드로 분기하는 곳이 있고, 언어가 바뀌어도
 * 코드는 같아야 한다.
 */
export function fail(
  reply: FastifyReply,
  status: number,
  code: string,
  key: MsgKey,
  params?: MsgParams,
): FastifyReply {
  const lang = langFrom(reply.request.headers['x-lang']);
  return reply.status(status).send({ error: { code, message: msg(lang, key, params) } });
}

/** 비밀번호 변경 전에도 허용되는 경로. 그 외는 must_change_password 일 때 403. */
const ALLOWED_WHILE_LOCKED = new Set(['/api/auth/me', '/api/auth/logout', '/api/auth/password']);

export function registerAuthGuard(app: FastifyInstance, ctx: AppContext): void {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return;
    // 로그인 자체는 세션 없이 들어온다.
    if (req.url === '/api/auth/login' || req.url === '/api/health') return;

    const sid = req.cookies[SESSION_COOKIE];
    if (!sid) return fail(reply, 401, 'unauthenticated', 'unauthenticated');

    const su = resolveSession(ctx.handle.db, sid);
    if (!su) {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return fail(reply, 401, 'unauthenticated', 'session_expired');
    }

    req.sessionUser = su;

    /*
      쓰는 동안에는 연장한다.

      SSE 는 한 번 열고 끝이라 연결 자체로는 세션이 갱신되지 않는다.
      화면이 주기적으로 /api/auth/me 를 두드려 여기까지 오게 되어 있다.
      쿠키에도 만료가 박히므로 DB 만 늘리면 브라우저가 먼저 쿠키를 버린다 — 같이 다시 심는다.
    */
    const renewed = touchSession(ctx.handle.db, su, ctx.cfg.SESSION_TTL_HOURS, ctx.cfg.SESSION_MAX_HOURS);
    if (renewed !== null) {
      reply.setCookie(SESSION_COOKIE, su.sessionId, {
        ...sessionCookieOptions(ctx.cfg),
        expires: new Date(renewed),
      });
    }

    const path = req.url.split('?')[0]!;
    if (su.user.mustChangePassword === 1 && !ALLOWED_WHILE_LOCKED.has(path)) {
      return fail(reply, 403, 'password_change_required', 'password_change_required');
    }
  });
}

export function requireUser(req: FastifyRequest, reply: FastifyReply): SessionUser | null {
  if (!req.sessionUser) {
    fail(reply, 401, 'unauthenticated', 'unauthenticated');
    return null;
  }
  return req.sessionUser;
}

export function requireAdmin(req: FastifyRequest, reply: FastifyReply): SessionUser | null {
  const su = requireUser(req, reply);
  if (!su) return null;
  if (su.user.role !== 'admin') {
    // 관리자 전용 경로의 존재를 확인시켜 줄 이유가 없다.
    fail(reply, 404, 'not_found', 'not_found');
    return null;
  }
  return su;
}

export function clientIp(req: FastifyRequest): string {
  return req.ip;
}
