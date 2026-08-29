import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { LOG_LEVELS, type LogEntry, type LogLevel } from '../../shared/types.js';
import { requireUser, fail, clientIp } from '../auth/middleware.js';
import { audit } from '../auth/audit.js';
import { authorizeEnv } from '../auth/authz.js';
import { estimateBytes, exportFilename, renderExport, type ExportContext } from '../export/format.js';
import { selectForExport } from '../export/select.js';

/** 준비된 내보내기를 이만큼만 들고 있는다. 받아가면 바로 버린다. */
const EXPORT_TTL_MS = 5 * 60_000;

interface PreparedExport {
  id: string;
  userId: string;
  entries: LogEntry[];
  ctx: ExportContext;
  format: 'log' | 'json' | 'csv';
  filename: string;
  createdAt: number;
}

const body = z.object({
  source: z.enum(['tail', 'search']),
  sessionId: z.string().max(200).optional(),
  jobId: z.string().max(64).optional(),
  seqFrom: z.number().int().nonnegative().optional(),
  seqTo: z.number().int().nonnegative().optional(),
  /**
   * 정확히 이 줄들만 내보낸다. 묶어보기·북마크만보기처럼 화면에 보이는 것이
   * seq 구간과 다를 때 쓴다. 구간만 보내면 화면에 안 보이던 줄까지 나가서
   * 대화상자가 말한 줄 수와 실제 파일이 어긋난다.
   */
  seqs: z.array(z.number().int().nonnegative()).max(200_000).optional(),
  levels: z.array(z.enum(LOG_LEVELS as unknown as [LogLevel, ...LogLevel[]])).optional(),
  query: z.string().max(500).optional(),
  format: z.enum(['log', 'json', 'csv']),
  includeContinuation: z.boolean(),
});

/** 상한 안내에 쓸 사람이 읽는 크기. 소수점 아래가 0MB 로 뭉개지면 안내가 무의미해진다. */
function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

export function registerExportRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx.handle;
  const prepared = new Map<string, PreparedExport>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, e] of prepared) if (now - e.createdAt > EXPORT_TTL_MS) prepared.delete(id);
  }, 60_000);
  sweep.unref();

  app.post('/api/export', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;

    const p = body.safeParse(req.body);
    if (!p.success) return fail(reply, 400, 'invalid_request', 'export_params');
    const d = p.data;

    let entries: LogEntry[];
    let base: Omit<ExportContext, 'levels' | 'query' | 'lines' | 'exportedBy' | 'exportedAt' | 'includeContinuation' | 'masked'>;

    if (d.source === 'search') {
      if (!d.jobId) return fail(reply, 400, 'invalid_request', 'job_id_required');
      const job = ctx.searches.get(d.jobId, su.user.id);
      if (!job) return fail(reply, 404, 'not_found', 'not_found');

      // 조회 결과에서도 선택한 것만 내보낸다. 이걸 빼면 범위 선택이 무시되고 전체가 나간다.
      entries = selectForExport(job.entries, d);

      // 잡을 만든 뒤 권한이 바뀌었을 수 있다. 내보내기 시점에 다시 확인한다.
      const grant = authorizeEnv(ctx, su, job.request.org.key, job.request.environmentId, reply);
      if (!grant) return reply;

      base = {
        orgKey: job.request.org.key,
        orgLabel: job.request.org.label,
        programId: job.request.programId,
        environmentId: job.request.environmentId,
        environmentType: grant.env.environmentType,
        service: job.request.service,
        logName: job.request.logName,
        // 선택 구간이 있으면 헤더의 범위도 그 구간으로 좁힌다.
        from: entries[0]?.ts ?? job.request.from,
        to: entries[entries.length - 1]?.ts ?? job.request.to,
      };
    } else {
      if (!d.sessionId) return fail(reply, 400, 'invalid_request', 'session_id_required');
      // sessionId 형식: org:envId:service:logName. 조직 경계는 여기서도 다시 확인한다.
      const [orgKey, environmentId, service, logName] = d.sessionId.split(':');
      if (!orgKey || !environmentId || !service || !logName) {
        return fail(reply, 400, 'invalid_request', 'session_id_format');
      }
      const grant = authorizeEnv(ctx, su, orgKey, environmentId, reply);
      if (!grant) return reply;

      const session = ctx.tails.peek({ orgKey, environmentId, service, logName });
      if (!session) return fail(reply, 404, 'not_found', 'tail_session_gone');

      entries = selectForExport(session.snapshot(), d);
      base = {
        orgKey,
        orgLabel: grant.org.label,
        programId: grant.env.programId,
        environmentId,
        environmentType: grant.env.environmentType,
        service,
        logName,
        from: entries[0]?.ts ?? Date.now(),
        to: entries[entries.length - 1]?.ts ?? Date.now(),
      };
    }

    if (entries.length === 0) {
      return fail(reply, 400, 'empty_export', 'empty_export');
    }

    const exportCtx: ExportContext = {
      ...base,
      levels: d.levels && d.levels.length > 0 ? d.levels : null,
      query: d.query,
      masked: ctx.cfg.MASKING_ENABLED,
      lines: entries.length,
      exportedBy: su.user.email,
      exportedAt: Date.now(),
      includeContinuation: d.includeContinuation,
    };

    const estimatedBytes = estimateBytes(entries, d.format, d.includeContinuation);
    if (estimatedBytes > ctx.cfg.EXPORT_MAX_BYTES) {
      return fail(reply, 400, 'export_too_large', 'export_too_large', {
        size: humanBytes(estimatedBytes),
        lines: entries.length.toLocaleString(),
        max: humanBytes(ctx.cfg.EXPORT_MAX_BYTES),
      });
    }

    const id = randomUUID();
    prepared.set(id, {
      id,
      userId: su.user.id,
      entries,
      ctx: exportCtx,
      format: d.format,
      filename: exportFilename(exportCtx, d.format),
      createdAt: Date.now(),
    });

    return reply.send({ exportId: id, estimatedBytes, lines: entries.length, filename: exportFilename(exportCtx, d.format) });
  });

  app.get('/api/export/:exportId/download', async (req, reply) => {
    const su = requireUser(req, reply);
    if (!su) return reply;

    const { exportId } = req.params as { exportId: string };
    const item = prepared.get(exportId);
    if (!item || item.userId !== su.user.id) return fail(reply, 404, 'not_found', 'not_found');

    // 받아가면 즉시 폐기한다. 서버 디스크에는 애초에 쓰지 않았다.
    prepared.delete(exportId);

    audit(db, {
      userId: su.user.id,
      userEmail: su.user.email,
      action: 'export',
      orgKey: item.ctx.orgKey,
      environmentId: item.ctx.environmentId,
      environmentType: item.ctx.environmentType,
      detail: {
        format: item.format,
        lines: item.ctx.lines,
        from: new Date(item.ctx.from).toISOString(),
        to: new Date(item.ctx.to).toISOString(),
        filename: item.filename,
      },
      ip: clientIp(req),
    });

    reply.raw.writeHead(200, {
      'Content-Type': item.format === 'json' ? 'application/x-ndjson; charset=utf-8' : 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${item.filename}"`,
      'Cache-Control': 'no-store',
    });

    // 버퍼에서 바로 흘린다. 전체를 한 문자열로 만들지 않는다.
    for (const chunk of renderExport(item.entries, item.ctx, item.format)) {
      if (!reply.raw.write(chunk)) {
        await new Promise((r) => reply.raw.once('drain', r));
      }
    }
    reply.raw.end();
    return reply;
  });
}
