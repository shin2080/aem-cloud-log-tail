import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireAdmin, fail, clientIp } from '../auth/middleware.js';
import { audit } from '../auth/audit.js';
import {
  AdminOpError,
  createUser,
  deleteUser,
  distinctAuditActions,
  listUsers,
  queryAudit,
  resetPassword,
  revokeSessions,
  updateUser,
} from '../auth/adminops.js';

const orgGrant = z.object({ key: z.string().min(1).max(64), allowProd: z.boolean() });

const createBody = z.object({
  email: z.string().email().max(320),
  displayName: z.string().max(120).default(''),
  role: z.enum(['admin', 'member']),
  orgs: z.array(orgGrant).max(50).default([]),
});

const patchBody = z.object({
  displayName: z.string().max(120).optional(),
  role: z.enum(['admin', 'member']).optional(),
  isActive: z.boolean().optional(),
  orgs: z.array(orgGrant).max(50).optional(),
});

const auditQuery = z.object({
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  userId: z.string().max(64).optional(),
  action: z.string().max(64).optional(),
  orgKey: z.string().max(64).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

function handle(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof AdminOpError) return fail(reply, err.status, err.code, err.key, err.params);
  throw err;
}

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx.handle;
  const knownKeys = (): Set<string> => new Set(ctx.cfg.orgs.keys());

  /** 프론트가 조직 선택지를 그리려면 .env 의 전체 목록이 필요하다 (key/label 만). */
  app.get('/api/admin/orgs', async (req, reply) => {
    const su = requireAdmin(req, reply);
    if (!su) return reply;
    return reply.send({
      orgs: [...ctx.cfg.orgs.values()].map((o) => ({ key: o.key, label: o.label })),
    });
  });

  app.get('/api/admin/users', async (req, reply) => {
    const su = requireAdmin(req, reply);
    if (!su) return reply;
    return reply.send({ users: listUsers(db) });
  });

  app.post('/api/admin/users', async (req, reply) => {
    const su = requireAdmin(req, reply);
    if (!su) return reply;

    const p = createBody.safeParse(req.body);
    if (!p.success) return fail(reply, 400, 'invalid_request', 'admin_user_params');

    try {
      const { user, tempPassword } = await createUser(db, p.data, knownKeys());
      audit(db, {
        userId: su.user.id,
        userEmail: su.user.email,
        action: 'admin_user_create',
        detail: { targetEmail: user.email, role: user.role, orgs: user.orgs },
        ip: clientIp(req),
      });
      // 임시 비밀번호는 여기서 한 번만 나간다. 저장하지 않으므로 다시 볼 수 없다.
      return reply.send({ user, tempPassword });
    } catch (err) {
      return handle(err, reply);
    }
  });

  app.patch('/api/admin/users/:id', async (req, reply) => {
    const su = requireAdmin(req, reply);
    if (!su) return reply;

    const p = patchBody.safeParse(req.body);
    if (!p.success) return fail(reply, 400, 'invalid_request', 'admin_patch_params');
    const { id } = req.params as { id: string };

    try {
      const user = updateUser(db, id, p.data, su.user.id, knownKeys());
      audit(db, {
        userId: su.user.id,
        userEmail: su.user.email,
        action: 'admin_user_update',
        detail: { targetEmail: user.email, patch: p.data },
        ip: clientIp(req),
      });
      return reply.send({ user });
    } catch (err) {
      return handle(err, reply);
    }
  });

  app.post('/api/admin/users/:id/reset-password', async (req, reply) => {
    const su = requireAdmin(req, reply);
    if (!su) return reply;
    const { id } = req.params as { id: string };

    try {
      const tempPassword = await resetPassword(db, id);
      const target = listUsers(db).find((u) => u.id === id);
      audit(db, {
        userId: su.user.id,
        userEmail: su.user.email,
        action: 'admin_password_reset',
        detail: { targetEmail: target?.email },
        ip: clientIp(req),
      });
      return reply.send({ tempPassword });
    } catch (err) {
      return handle(err, reply);
    }
  });

  app.post('/api/admin/users/:id/revoke-sessions', async (req, reply) => {
    const su = requireAdmin(req, reply);
    if (!su) return reply;
    const { id } = req.params as { id: string };

    try {
      const revoked = revokeSessions(db, id);
      const target = listUsers(db).find((u) => u.id === id);
      audit(db, {
        userId: su.user.id,
        userEmail: su.user.email,
        action: 'admin_user_update',
        detail: { targetEmail: target?.email, revokedSessions: revoked },
        ip: clientIp(req),
      });
      return reply.send({ revoked });
    } catch (err) {
      return handle(err, reply);
    }
  });

  app.delete('/api/admin/users/:id', async (req, reply) => {
    const su = requireAdmin(req, reply);
    if (!su) return reply;
    const { id } = req.params as { id: string };

    try {
      const { email } = deleteUser(db, id, su.user.id);
      audit(db, {
        userId: su.user.id,
        userEmail: su.user.email,
        action: 'admin_user_delete',
        detail: { targetEmail: email },
        ip: clientIp(req),
      });
      return reply.send({ ok: true });
    } catch (err) {
      return handle(err, reply);
    }
  });

  app.get('/api/admin/audit', async (req, reply) => {
    const su = requireAdmin(req, reply);
    if (!su) return reply;

    const p = auditQuery.safeParse(req.query);
    if (!p.success) return fail(reply, 400, 'invalid_request', 'audit_params');

    const { rows, total } = queryAudit(db, p.data);
    return reply.send({ rows, total, actions: distinctAuditActions(db) });
  });
}
