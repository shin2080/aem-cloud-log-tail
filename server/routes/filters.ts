import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, desc } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { savedFilters } from '../db/schema.js';
import { requireUser, fail } from '../auth/middleware.js';

const MAX_PER_USER = 50;

const createBody = z.object({
  name: z.string().min(1).max(80),
  /** 화면이 그대로 복원할 수 있는 조회 조건. 구조는 프론트가 정한다. */
  payload: z.record(z.string(), z.unknown()),
});

/** 자주 쓰는 조회 조건 저장. 순수 편의 기능이고 로그 본문은 담기지 않는다. */
export function registerFilterRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx.handle;

  app.get('/api/filters', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;

    const rows = db
      .select()
      .from(savedFilters)
      .where(eq(savedFilters.userId, su.user.id))
      .orderBy(desc(savedFilters.createdAt))
      .all()
      .map((r) => ({ id: r.id, name: r.name, payload: safeParse(r.payload), createdAt: r.createdAt }));

    return reply.send({ filters: rows });
  });

  app.post('/api/filters', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;

    const p = createBody.safeParse(req.body);
    if (!p.success) return fail(reply, 400, 'invalid_request', 'filter_params');

    const existing = db.select().from(savedFilters).where(eq(savedFilters.userId, su.user.id)).all();
    if (existing.length >= MAX_PER_USER) {
      return fail(reply, 400, 'too_many_filters', 'too_many_filters', { max: MAX_PER_USER });
    }

    // 같은 이름이면 덮어쓴다. 지웠다 다시 저장하게 만들 이유가 없다.
    const dup = existing.find((r) => r.name === p.data.name);
    if (dup) {
      db.update(savedFilters)
        .set({ payload: JSON.stringify(p.data.payload), createdAt: Date.now() })
        .where(eq(savedFilters.id, dup.id))
        .run();
      return reply.send({ id: dup.id, name: p.data.name, replaced: true });
    }

    const id = randomUUID();
    db.insert(savedFilters)
      .values({
        id,
        userId: su.user.id,
        name: p.data.name,
        payload: JSON.stringify(p.data.payload),
        createdAt: Date.now(),
      })
      .run();

    return reply.send({ id, name: p.data.name, replaced: false });
  });

  app.delete('/api/filters/:id', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;
    const { id } = req.params as { id: string };

    // 남의 필터는 존재 자체를 알리지 않는다.
    const res = db
      .delete(savedFilters)
      .where(and(eq(savedFilters.id, id), eq(savedFilters.userId, su.user.id)))
      .run();

    if (res.changes === 0) return fail(reply, 404, 'not_found', 'not_found');
    return reply.send({ ok: true });
  });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
