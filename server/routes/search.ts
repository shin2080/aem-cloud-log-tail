import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { LOG_LEVELS, type LogLevel } from '../../shared/types.js';
import { requireUser, fail, clientIp } from '../auth/middleware.js';
import { authorizeEnv } from '../auth/authz.js';
import { audit } from '../auth/audit.js';
import { hasParser } from '../parse/parser.js';
import { buildMatcher, ScanError } from '../search/scan.js';
import type { JobEvent } from '../search/jobs.js';

const PING_INTERVAL_MS = 15_000;

const body = z.object({
  org: z.string().min(1).max(64),
  envId: z.string().min(1).max(64),
  service: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  from: z.number().int().positive(),
  to: z.number().int().positive(),
  levels: z.array(z.enum(LOG_LEVELS as unknown as [LogLevel, ...LogLevel[]])).default([]),
  query: z.string().max(500).optional(),
  regex: z.boolean().optional(),
});

function sse(reply: FastifyReply, event: string, data?: unknown): void {
  reply.raw.write(`event: ${event}\n${data === undefined ? '' : `data: ${JSON.stringify(data)}\n`}\n`);
}

export function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx.handle;

  app.post('/api/search', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;

    const p = body.safeParse(req.body);
    if (!p.success) return fail(reply, 400, 'invalid_request', 'search_params');

    const grant = authorizeEnv(ctx, su, p.data.org, p.data.envId, reply);
    if (!grant) return reply;

    if (!hasParser(p.data.name)) {
      return fail(reply, 400, 'unsupported_log', 'unsupported_log', { name: p.data.name });
    }
    if (p.data.to < p.data.from) {
      return fail(reply, 400, 'invalid_range', 'invalid_range');
    }
    // 정규식은 잡을 만들기 전에 검증한다. 나중에 터지면 사용자가 이유를 못 본다.
    try {
      buildMatcher(p.data.query, p.data.regex);
    } catch (err) {
      if (err instanceof ScanError) return fail(reply, 400, err.code, err.key, err.params);
      throw err;
    }

    const job = ctx.searches.start(su.user.id, {
      org: grant.org,
      programId: grant.env.programId,
      environmentId: grant.env.environmentId,
      service: p.data.service,
      logName: p.data.name,
      from: p.data.from,
      to: p.data.to,
      levels: p.data.levels,
      query: p.data.query,
      regex: p.data.regex,
    });

    audit(db, {
      userId: su.user.id,
      userEmail: su.user.email,
      action: 'search',
      orgKey: grant.org.key,
      environmentId: grant.env.environmentId,
      environmentType: grant.env.environmentType,
      detail: {
        service: p.data.service,
        logName: p.data.name,
        from: new Date(p.data.from).toISOString(),
        to: new Date(p.data.to).toISOString(),
        levels: p.data.levels,
        query: p.data.query,
        regex: p.data.regex,
      },
      ip: clientIp(req),
    });

    return reply.send({ jobId: job.id });
  });

  app.get('/api/search/:jobId/stream', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;

    const { jobId } = req.params as { jobId: string };
    const job = ctx.searches.get(jobId, su.user.id);
    if (!job) return fail(reply, 404, 'not_found', 'not_found');

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      off();
    };

    const ping = setInterval(() => {
      if (!closed) sse(reply, 'ping');
    }, PING_INTERVAL_MS);
    ping.unref();

    const onEvent = (e: JobEvent): void => {
      if (closed) return;
      sse(reply, e.type, e.payload);
      if (e.type === 'done' || e.type === 'error') {
        cleanup();
        reply.raw.end();
      }
    };
    const off = ctx.searches.subscribe(jobId, onEvent);

    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

    // 구독 전에 이미 나온 것을 먼저 넘긴다. 잡이 끝난 뒤 붙어도 결과를 다 받는다.
    sse(reply, 'progress', job.progress);
    if (job.entries.length > 0) sse(reply, 'entries', { entries: job.entries });

    if (job.status !== 'running') {
      if (job.status === 'error' && job.error) sse(reply, 'error', job.error);
      else
        sse(reply, 'done', {
          matched: job.result?.matched ?? job.entries.length,
          truncated: job.result?.truncated ?? false,
          skippedDates: job.result?.skippedDates ?? [],
          missingDates: job.result?.missingDates ?? [],
          cancelled: job.status === 'cancelled',
        });
      cleanup();
      reply.raw.end();
    }

    return reply;
  });

  app.delete('/api/search/:jobId', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;

    const { jobId } = req.params as { jobId: string };
    if (!ctx.searches.get(jobId, su.user.id)) return fail(reply, 404, 'not_found', 'not_found');

    const cancelled = ctx.searches.cancel(jobId, su.user.id);
    return reply.send({ cancelled });
  });
}
