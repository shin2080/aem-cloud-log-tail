import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { users, userOrgs } from '../db/schema.js';
import { SESSION_COOKIE, createSession, destroySession, destroyUserSessions } from '../auth/session.js';
import { sessionCookieOptions } from '../auth/cookie.js';
import {
  verifyPassword,
  hashPassword,
  validatePassword,
  verifyAgainstDummy,
  MIN_PASSWORD_LENGTH,
} from '../auth/password.js';
import { audit } from '../auth/audit.js';
import { clientIp, fail, requireUser } from '../auth/middleware.js';
import type { Me, UserOrgAccess } from '../../shared/types.js';

const loginBody = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});

const passwordBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024),
});

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx.handle;
  const { cfg } = ctx;

  const cookieOpts = sessionCookieOptions(cfg);

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', 'login_params');

    const email = parsed.data.email.trim().toLowerCase();
    const ip = clientIp(req);

    // 이메일과 IP 를 각각 센다. 이메일만 세면 주소를 바꿔가며 뿌리는 것을 못 막는다.
    const lockedFor = ctx.loginLimiter.retryAfterMs(email) ?? ctx.loginLimiter.retryAfterMs(`ip:${ip}`);
    if (lockedFor !== null) {
      const mins = Math.ceil(lockedFor / 60_000);
      return fail(reply, 429, 'too_many_attempts', 'too_many_attempts', { mins });
    }

    const user = db.select().from(users).where(eq(users.email, email)).get();
    // 계정이 없어도 같은 비용을 치른다. 안 그러면 응답 시간이 존재 여부를 흘린다.
    const ok =
      user && user.isActive === 1
        ? await verifyPassword(user.passwordHash, parsed.data.password)
        : await verifyAgainstDummy(parsed.data.password);

    // `!user` 를 함께 봐야 아래에서 user 가 좁혀진다. 검증 비용은 위에서 이미 치렀다.
    if (!ok || !user) {
      ctx.loginLimiter.recordFailure(email);
      ctx.loginLimiter.recordFailure(`ip:${ip}`);
      audit(db, { userId: user?.id ?? null, userEmail: email, action: 'login_failed', ip });
      // 계정 존재 여부를 구분해서 알려주지 않는다.
      return fail(reply, 401, 'invalid_credentials', 'invalid_credentials');
    }

    ctx.loginLimiter.clear(email);
    ctx.loginLimiter.clear(`ip:${ip}`);
    const session = createSession(db, user.id, cfg.SESSION_TTL_HOURS, req.headers['user-agent']);
    db.update(users).set({ lastLoginAt: Date.now() }).where(eq(users.id, user.id)).run();
    audit(db, { userId: user.id, userEmail: email, action: 'login', ip });

    reply.setCookie(SESSION_COOKIE, session.id, { ...cookieOpts, expires: new Date(session.expiresAt) });
    return reply.send(meFor(ctx, user.id));
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const su = req.sessionUser;
    if (su) {
      destroySession(db, su.sessionId);
      audit(db, { userId: su.user.id, userEmail: su.user.email, action: 'logout', ip: clientIp(req) });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;
    return reply.send(meFor(ctx, su.user.id));
  });

  app.post('/api/auth/password', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;

    const parsed = passwordBody.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', 'password_params');

    const { currentPassword, newPassword } = parsed.data;
    if (!(await verifyPassword(su.user.passwordHash, currentPassword))) {
      return fail(reply, 400, 'invalid_credentials', 'current_password_wrong');
    }
    const problem = validatePassword(newPassword);
    if (problem) return fail(reply, 400, 'weak_password', problem.key, problem.params);
    if (newPassword === currentPassword) {
      return fail(reply, 400, 'weak_password', 'password_reuse');
    }

    db.update(users)
      .set({ passwordHash: await hashPassword(newPassword), mustChangePassword: 0 })
      .where(eq(users.id, su.user.id))
      .run();

    // 비밀번호를 바꾸면 다른 세션은 모두 끊고 현재 세션만 새로 발급한다.
    destroyUserSessions(db, su.user.id);
    const session = createSession(db, su.user.id, cfg.SESSION_TTL_HOURS, req.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, session.id, { ...cookieOpts, expires: new Date(session.expiresAt) });

    audit(db, { userId: su.user.id, userEmail: su.user.email, action: 'password_changed', ip: clientIp(req) });
    return reply.send(meFor(ctx, su.user.id));
  });
}

/** 세션 사용자에게 허용된 조직만, 그리고 key/label 만 담는다. */
export function meFor(ctx: AppContext, userId: string): Me {
  const { db } = ctx.handle;
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new Error(`user ${userId} not found`);

  const rows = db.select().from(userOrgs).where(eq(userOrgs.userId, userId)).all();
  const orgs: UserOrgAccess[] = rows
    .map((r) => {
      const org = ctx.cfg.orgs.get(r.orgKey);
      // .env 에서 사라진 org key 는 조용히 빼고 보여주지 않는다.
      return org ? { key: org.key, label: org.label, allowProd: r.allowProd === 1 } : null;
    })
    .filter((o): o is UserOrgAccess => o !== null)
    .sort((a, b) => a.label.localeCompare(b.label, 'ko'));

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    mustChangePassword: user.mustChangePassword === 1,
    orgs,
    minPasswordLength: MIN_PASSWORD_LENGTH,
  };
}
