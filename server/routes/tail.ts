import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { LogEntry, LogLevel } from '../../shared/types.js';
import { LOG_LEVELS } from '../../shared/types.js';
import { requireUser, fail, clientIp } from '../auth/middleware.js';
import { authorizeEnv, checkEnvAccess } from '../auth/authz.js';
import { resolveSession } from '../auth/session.js';
import { langFrom, msg } from '../i18n/messages.js';
import { audit } from '../auth/audit.js';
import { hasParser } from '../parse/parser.js';
import { tailKeyOf, type TailEvent } from '../tail/session.js';

const PING_INTERVAL_MS = 15_000;
/** 배치 기준: 100ms 디바운스 또는 500건 */
const FLUSH_DEBOUNCE_MS = 100;
const FLUSH_MAX_BATCH = 500;

/**
 * 같은 사람이 같은 대상을 다시 열어도 이 시간 안이면 기록을 남기지 않는다.
 *
 * EventSource 는 끊기면 몇 초 간격으로 계속 다시 붙는다. 그대로 두면 서버가 잠깐 죽거나
 * 네트워크가 흔들릴 때마다 tail_open 이 초당 몇 건씩 쌓인다 — 모니터에 걸어두면
 * 하룻밤에 수만 건이다. 그러면 감사 기록의 이메일 검색(LIKE)이 느려지고,
 * 정작 사람이 실제로 무엇을 봤는지가 재연결 잡음에 묻힌다.
 */
const AUDIT_DEDUPE_MS = 10 * 60_000;

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

  /** 최근에 기록한 (사용자, 대상) → 시각. 재연결 잡음을 걸러내기 위한 것뿐이다. */
  const lastAudited = new Map<string, number>();
  const auditSweep = setInterval(() => {
    const cutoff = Date.now() - AUDIT_DEDUPE_MS;
    for (const [k, at] of lastAudited) if (at < cutoff) lastAudited.delete(k);
  }, AUDIT_DEDUPE_MS);
  auditSweep.unref();

  /** 방금 남긴 것과 같은 열람이면 false. 처음이거나 시간이 지났으면 true 를 주고 기억한다. */
  const shouldAudit = (userId: string, target: string): boolean => {
    const k = `${userId} ${target}`;
    const now = Date.now();
    const prev = lastAudited.get(k);
    if (prev !== undefined && now - prev < AUDIT_DEDUPE_MS) return false;
    lastAudited.set(k, now);
    return true;
  };

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
    // 헤더를 내보낸 뒤에는 요청 객체를 통해 말을 고를 수 없다. 지금 잡아둔다.
    const lang = langFrom(req.headers['x-lang']);
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

    /**
     * 프록시가 유휴 연결을 끊지 않게 하고, 그 김에 아직 봐도 되는지 다시 확인한다.
     *
     * 인가는 연결할 때 한 번만 봤다. 몇 시간 열어두는 창이면 그럭저럭 넘어가지만,
     * 모니터에 무기한 걸어두는 것이 전제가 되면 '권한 회수가 동작하지 않는다' 와 같은 말이 된다 —
     * 관리자가 세션을 끊어도, 조직 권한을 회수해도, 계정을 꺼도
     * 이미 열린 스트림은 계속 prod 로그를 흘린다.
     */
    const pingTimer = setInterval(() => {
      if (closed) return;

      const still = resolveSession(db, su.sessionId);
      const stillAllowed = still ? checkEnvAccess(ctx, still, key.orgKey, key.environmentId) : null;
      if (!stillAllowed) {
        sse(reply, 'error', {
          code: 'access_revoked',
          message: msg(lang, 'access_revoked'),
          recoverable: false,
        });
        cleanup();
        reply.raw.end();
        return;
      }

      sse(reply, 'ping');
    }, PING_INTERVAL_MS);
    pingTimer.unref();

    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

    try {
      handle = await ctx.tails.subscribe(key, grant.org, grant.env.programId, onEvent);
      // 세션을 여는 동안(IMS 토큰 + 로그 목록 + 서명 URL) 클라이언트가 떠났을 수 있다.
      // cleanup 은 이미 지나갔고 그때 handle 은 아직 undefined 였다 —
      // 여기서 직접 해지하지 않으면 구독자가 영영 남아 폴링 루프와 링버퍼가 안 죽는다.
      if (closed) {
        handle.unsubscribe();
        return reply;
      }
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

    // 재연결로 다시 붙은 것은 새로운 열람이 아니다. 사람이 실제로 연 것만 남긴다.
    if (shouldAudit(su.user.id, `${tailKeyOf(key)} ${levels?.join(',') ?? '*'}`)) {
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
    }

    // 이미 버퍼에 쌓인 것을 먼저 넘긴다. 화면이 비어 있는 채로 시작하지 않게.
    const buffered = handle.session.snapshot();
    const initial = levels ? buffered.filter((e) => levels.includes(e.level)) : buffered;
    const state = handle.session.bufferState;

    sse(reply, 'ready', {
      sessionId: `${key.orgKey}:${key.environmentId}:${key.service}:${key.logName}`,
      // 세션이 다시 만들어졌으면 seq 가 0부터다. 클라이언트는 이 값으로 그걸 안다.
      generation: handle.session.generation,
      bufferedCount: initial.length,
      oldestSeq: state.oldestSeq,
      newestSeq: state.newestSeq,
    });
    if (initial.length > 0) sse(reply, 'entries', { entries: initial });

    return reply;
  });
}
