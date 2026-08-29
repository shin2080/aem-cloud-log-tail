import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { LogEntry, LogLevel } from '../../shared/types.js';
import { LOG_LEVELS } from '../../shared/types.js';
import { requireUser, fail, clientIp } from '../auth/middleware.js';
import { authorizeEnv } from '../auth/authz.js';
import { audit } from '../auth/audit.js';
import { hasParser } from '../parse/parser.js';
import type { TailEvent } from '../tail/session.js';

const PING_INTERVAL_MS = 15_000;
/** 배치 기준: 100ms 디바운스 또는 500건 */
const FLUSH_DEBOUNCE_MS = 100;
const FLUSH_MAX_BATCH = 500;

const query = z.object({
  org: z.string().min(1).max(64),
  env: z.string().min(1).max(64),
  service: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  levels: z.string().max(200).optional(),
});

function parseLevels(raw: string | undefined): LogLevel[] | null {
  if (!raw) return null;
  const wanted = new Set(raw.split(',').map((s) => s.trim().toUpperCase()));
  const levels = LOG_LEVELS.filter((l) => wanted.has(l));
  return levels.length > 0 ? levels : null;
}

/** SSE 한 건. data 는 반드시 한 줄이어야 하므로 JSON 으로 직렬화한다. */
function sse(reply: FastifyReply, event: string, data?: unknown): void {
  const payload = data === undefined ? '' : `data: ${JSON.stringify(data)}\n`;
  reply.raw.write(`event: ${event}\n${payload}\n`);
}

export function registerTailRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx.handle;

  app.get('/api/tail', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;

    const q = query.safeParse(req.query);
    if (!q.success) return fail(reply, 400, 'invalid_request', 'tail_params');

    const grant = authorizeEnv(ctx, su, q.data.org, q.data.env, reply);
    if (!grant) return reply;

    if (!hasParser(q.data.name)) {
      return fail(reply, 400, 'unsupported_log', 'unsupported_log', { name: q.data.name });
    }

    const levels = parseLevels(q.data.levels);
    const key = {
      orgKey: grant.org.key,
      environmentId: grant.env.environmentId,
      service: q.data.service,
      logName: q.data.name,
    };

    let handle: Awaited<ReturnType<typeof ctx.tails.subscribe>>;

    /* ── 여기부터 SSE. 헤더를 먼저 내보내고 응답을 열어둔다. ── */
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let closed = false;
    let pending: LogEntry[] = [];
    let flushTimer: NodeJS.Timeout | null = null;

    const flush = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (closed || pending.length === 0) return;
      const batch = pending;
      pending = [];
      sse(reply, 'entries', { entries: batch });
    };

    const onEvent = (ev: TailEvent): void => {
      if (closed) return;
      switch (ev.type) {
        case 'entries': {
          // 레벨 필터는 서버에서 건다. ERROR 만 보는데 INFO 수만 줄을 브라우저로 보낼 이유가 없다.
          const kept = levels ? ev.entries.filter((e) => levels.includes(e.level)) : ev.entries;
          if (kept.length === 0) return;
          pending.push(...kept);
          if (pending.length >= FLUSH_MAX_BATCH) flush();
          else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
          return;
        }
        case 'rollover':
          flush();
          sse(reply, 'rollover', { newDate: ev.newDate });
          return;
        case 'truncated':
          flush();
          sse(reply, 'truncated', { droppedCount: ev.droppedCount, oldestSeq: ev.oldestSeq });
          return;
        case 'error':
          sse(reply, 'error', { code: ev.code, message: ev.message, recoverable: ev.recoverable });
          return;
      }
    };

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (flushTimer) clearTimeout(flushTimer);
      clearInterval(pingTimer);
      handle?.unsubscribe();
    };

    // 프록시가 유휴 연결을 끊지 않게 한다.
    const pingTimer = setInterval(() => {
      if (closed) return;
      sse(reply, 'ping');
    }, PING_INTERVAL_MS);
    pingTimer.unref();

    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

    try {
      handle = await ctx.tails.subscribe(key, grant.org, grant.env.programId, onEvent);
    } catch (err) {
      req.log.error({ err, key }, 'tail session start failed');
      sse(reply, 'error', {
        code: 'tail_start_failed',
        message: err instanceof Error ? err.message : '로그 스트림을 열지 못했다',
        recoverable: false,
      });
      cleanup();
      reply.raw.end();
      return reply;
    }

    audit(db, {
      userId: su.user.id,
      userEmail: su.user.email,
      action: 'tail_open',
      orgKey: grant.org.key,
      environmentId: grant.env.environmentId,
      environmentType: grant.env.environmentType,
      detail: { service: key.service, logName: key.logName, levels },
      ip: clientIp(req),
    });

    // 이미 버퍼에 쌓인 것을 먼저 넘긴다. 화면이 비어 있는 채로 시작하지 않게.
    const buffered = handle.session.snapshot();
    const initial = levels ? buffered.filter((e) => levels.includes(e.level)) : buffered;
    const state = handle.session.bufferState;

    sse(reply, 'ready', {
      sessionId: `${key.orgKey}:${key.environmentId}:${key.service}:${key.logName}`,
      bufferedCount: initial.length,
      oldestSeq: state.oldestSeq,
      newestSeq: state.newestSeq,
    });
    if (initial.length > 0) sse(reply, 'entries', { entries: initial });

    return reply;
  });
}
