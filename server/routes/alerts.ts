import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { LOG_LEVELS, type LogLevel } from '../../shared/types.js';
import { alertHits, alertRules } from '../db/schema.js';
import { requireUser, fail, clientIp } from '../auth/middleware.js';
import { authorizeEnv } from '../auth/authz.js';
import { audit } from '../auth/audit.js';
import { hasParser } from '../parse/parser.js';
import { compileRule, PatternError, MAX_PATTERN_CHARS } from '../alerts/matcher.js';
import { tailKeyOf } from '../tail/session.js';
import { unreadCount } from '../alerts/watch.js';

const MAX_RULES_PER_USER = 20;
const PING_INTERVAL_MS = 25_000;

const createBody = z.object({
  name: z.string().min(1).max(80),
  org: z.string().min(1).max(64),
  env: z.string().min(1).max(64),
  service: z.string().min(1).max(64),
  logName: z.string().min(1).max(64),
  pattern: z.string().min(1).max(MAX_PATTERN_CHARS),
  isRegex: z.boolean(),
  levels: z.array(z.enum(LOG_LEVELS as unknown as [LogLevel, ...LogLevel[]])).optional(),
  /** 같은 사건을 다시 알리기까지. 0이면 매번 알린다 */
  cooldownSec: z.number().int().min(0).max(86_400),
});

const patchBody = z.object({ enabled: z.boolean() });

function sse(reply: FastifyReply, event: string, data?: unknown): void {
  const payload = data === undefined ? '' : `data: ${JSON.stringify(data)}\n`;
  reply.raw.write(`event: ${event}\n${payload}\n`);
}

/**
 * 알림 규칙과 알림함.
 *
 * 규칙이 걸린 대상은 아무도 안 보고 있어도 폴링이 돈다 — 그게 이 기능의 값이자 비용이다.
 * 그래서 대상 수에 상한(ALERT_MAX_TARGETS)이 있고, 여기서 미리 막아
 * "만들었는데 조용히 안 도는 규칙" 이 생기지 않게 한다.
 */
export function registerAlertRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx.handle;

  const rulesOf = (userId: string) =>
    db.select().from(alertRules).where(eq(alertRules.userId, userId)).orderBy(desc(alertRules.createdAt)).all();

  app.get('/api/alerts/rules', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;
    return reply.send({
      rules: rulesOf(su.user.id).map(toWire),
      maxTargets: ctx.cfg.ALERT_MAX_TARGETS,
      watchedTargets: ctx.alerts.watchedTargets,
    });
  });

  app.post('/api/alerts/rules', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;
    if (ctx.cfg.ALERT_MAX_TARGETS === 0) return fail(reply, 400, 'alerts_disabled', 'alerts_disabled');

    const p = createBody.safeParse(req.body);
    if (!p.success) return fail(reply, 400, 'invalid_request', 'alert_params');
    const d = p.data;

    // 볼 수 없는 환경에 규칙을 걸 수는 없다. prod 는 allowProd 까지 본다.
    const grant = authorizeEnv(ctx, su, d.org, d.env, reply);
    if (!grant) return reply;
    if (!hasParser(d.logName)) {
      return fail(reply, 400, 'unsupported_log', 'unsupported_log', { name: d.logName });
    }

    if (rulesOf(su.user.id).length >= MAX_RULES_PER_USER) {
      return fail(reply, 400, 'too_many_rules', 'too_many_rules', { max: MAX_RULES_PER_USER });
    }

    // 패턴이 못 쓸 것이면 여기서 막는다. 서버에서 도는 정규식이라 등록이 마지막 관문이다.
    try {
      compileRule({ pattern: d.pattern, isRegex: d.isRegex, levels: d.levels ?? null });
    } catch (err) {
      if (err instanceof PatternError) return fail(reply, 400, err.key, err.key);
      throw err;
    }

    /*
      대상 상한을 미리 본다.

      만들고 나서 watcher 가 조용히 꺼버리면 "규칙은 있는데 알림이 안 온다" 가 된다.
      이 기능에서 가장 알아채기 어려운 실패라, 만들기 전에 거절하는 편이 낫다.
    */
    const target = tailKeyOf({ orgKey: grant.org.key, environmentId: d.env, service: d.service, logName: d.logName });
    const active = db.select().from(alertRules).where(eq(alertRules.enabled, 1)).all();
    const targets = new Set(
      active.map((r) => tailKeyOf({ orgKey: r.orgKey, environmentId: r.environmentId, service: r.service, logName: r.logName })),
    );
    if (!targets.has(target) && targets.size >= ctx.cfg.ALERT_MAX_TARGETS) {
      return fail(reply, 400, 'too_many_targets', 'too_many_targets', { max: ctx.cfg.ALERT_MAX_TARGETS });
    }

    const id = randomUUID();
    db.insert(alertRules)
      .values({
        id,
        userId: su.user.id,
        name: d.name.trim(),
        orgKey: grant.org.key,
        environmentId: d.env,
        service: d.service,
        logName: d.logName,
        pattern: d.pattern,
        isRegex: d.isRegex ? 1 : 0,
        levels: d.levels && d.levels.length > 0 ? d.levels.join(',') : null,
        cooldownSec: d.cooldownSec,
        enabled: 1,
        disabledReason: null,
        createdAt: Date.now(),
      })
      .run();

    // 규칙 등록은 "아무도 안 볼 때도 이 로그를 계속 읽겠다" 는 선언이다. 남긴다.
    audit(db, {
      userId: su.user.id,
      userEmail: su.user.email,
      action: 'alert_rule_created',
      orgKey: grant.org.key,
      environmentId: d.env,
      environmentType: grant.env.environmentType,
      detail: { name: d.name, service: d.service, logName: d.logName, isRegex: d.isRegex },
      ip: clientIp(req),
    });

    await ctx.alerts.sync();
    const row = db.select().from(alertRules).where(eq(alertRules.id, id)).get();
    return reply.send({ rule: row ? toWire(row) : null });
  });

  app.patch('/api/alerts/rules/:id', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;

    const { id } = req.params as { id: string };
    const row = db.select().from(alertRules).where(eq(alertRules.id, id)).get();
    if (!row || row.userId !== su.user.id) return fail(reply, 404, 'not_found', 'not_found');

    const p = patchBody.safeParse(req.body);
    if (!p.success) return fail(reply, 400, 'invalid_request', 'alert_params');

    db.update(alertRules)
      .set({ enabled: p.data.enabled ? 1 : 0, disabledReason: null })
      .where(eq(alertRules.id, id))
      .run();

    await ctx.alerts.sync();
    const next = db.select().from(alertRules).where(eq(alertRules.id, id)).get();
    return reply.send({ rule: next ? toWire(next) : null });
  });

  app.delete('/api/alerts/rules/:id', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;

    const { id } = req.params as { id: string };
    const row = db.select().from(alertRules).where(eq(alertRules.id, id)).get();
    if (!row || row.userId !== su.user.id) return fail(reply, 404, 'not_found', 'not_found');

    db.delete(alertRules).where(eq(alertRules.id, id)).run(); // hits 는 CASCADE 로 함께
    await ctx.alerts.sync();
    return reply.send({ ok: true });
  });

  /* ── 알림함 ─────────────────────────────────────────── */

  app.get('/api/alerts/hits', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;

    const limit = Math.min(200, Number((req.query as { limit?: string }).limit ?? 50) || 50);
    const rows = db
      .select({ hit: alertHits, rule: alertRules })
      .from(alertHits)
      .innerJoin(alertRules, eq(alertRules.id, alertHits.ruleId))
      .where(eq(alertRules.userId, su.user.id))
      .orderBy(desc(alertHits.createdAt))
      .limit(limit)
      .all();

    return reply.send({
      hits: rows.map(({ hit, rule }) => ({
        id: hit.id,
        ruleId: rule.id,
        ruleName: rule.name,
        orgKey: rule.orgKey,
        environmentId: rule.environmentId,
        service: rule.service,
        logName: rule.logName,
        level: hit.level,
        count: hit.count,
        firstTs: hit.firstTs,
        lastTs: hit.lastTs,
        lastSeq: hit.lastSeq,
        read: hit.readAt !== null,
        createdAt: hit.createdAt,
      })),
      unread: unreadCount(db, su.user.id),
    });
  });

  app.post('/api/alerts/hits/read', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;

    const body = z.object({ ids: z.array(z.string().max(64)).max(500).optional() }).safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, 'invalid_request', 'alert_params');

    // 남의 히트를 읽음 처리할 수 없게 소유 규칙으로 좁힌다.
    const mine = db.select({ id: alertRules.id }).from(alertRules).where(eq(alertRules.userId, su.user.id)).all();
    const ruleIds = mine.map((r) => r.id);
    if (ruleIds.length === 0) return reply.send({ unread: 0 });

    const scope = body.data.ids?.length
      ? and(inArray(alertHits.ruleId, ruleIds), inArray(alertHits.id, body.data.ids), isNull(alertHits.readAt))
      : and(inArray(alertHits.ruleId, ruleIds), isNull(alertHits.readAt));

    db.update(alertHits).set({ readAt: Date.now() }).where(scope).run();
    return reply.send({ unread: unreadCount(db, su.user.id) });
  });

  /* ── 실시간 밀어주기 ─────────────────────────────────── */

  app.get('/api/alerts/stream', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let closed = false;
    const off = ctx.alerts.subscribe((e) => {
      if (closed) return;
      // 남의 규칙이 맞은 것은 보내지 않는다.
      if (e.userId !== su.user.id) return;
      sse(reply, 'hit', {
        id: e.hitId,
        ruleId: e.ruleId,
        ruleName: e.ruleName,
        orgKey: e.orgKey,
        environmentId: e.environmentId,
        service: e.service,
        logName: e.logName,
        level: e.level,
        count: e.count,
        lastTs: e.lastTs,
        lastSeq: e.lastSeq,
      });
    });

    const ping = setInterval(() => {
      if (!closed) sse(reply, 'ping');
    }, PING_INTERVAL_MS);
    ping.unref();

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      off();
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

    sse(reply, 'ready', { unread: unreadCount(db, su.user.id) });
    return reply;
  });
}

function toWire(r: typeof alertRules.$inferSelect) {
  return {
    id: r.id,
    name: r.name,
    orgKey: r.orgKey,
    environmentId: r.environmentId,
    service: r.service,
    logName: r.logName,
    pattern: r.pattern,
    isRegex: r.isRegex === 1,
    levels: r.levels ? r.levels.split(',') : [],
    cooldownSec: r.cooldownSec,
    enabled: r.enabled === 1,
    disabledReason: r.disabledReason,
    createdAt: r.createdAt,
  };
}
