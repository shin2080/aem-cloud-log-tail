import type { ExportFormat, LogEntry, LogLevel } from '../../shared/types.js';

export interface ExportContext {
  orgKey: string;
  orgLabel: string;
  programId: string;
  environmentId: string;
  environmentType: string;
  service: string;
  logName: string;
  /** epoch ms. 실제로 내보내는 구간 */
  from: number;
  to: number;
  levels: LogLevel[] | null;
  query?: string;
  masked: boolean;
  lines: number;
  exportedBy: string;
  exportedAt: number;
  includeContinuation: boolean;
}

const KST_OFFSET_MS = 9 * 3600_000;

/** epoch ms -> 2026-08-28T14:00:00+09:00 */
export function kstIso(ms: number): string {
  const d = new Date(ms + KST_OFFSET_MS);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+09:00`
  );
}

/**
 * 파일명 규칙 (SPEC 7장).
 *   {orgKey}-p{programId}-e{envId}-{service}-{logName}-{fromYYYYMMDDTHHmm}_{toHHmm}.{ext}
 */
export function exportFilename(ctx: ExportContext, format: ExportFormat): string {
  const d = (ms: number) => new Date(ms + KST_OFFSET_MS);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const f = d(ctx.from);
  const t = d(ctx.to);

  const from = `${f.getUTCFullYear()}${p(f.getUTCMonth() + 1)}${p(f.getUTCDate())}T${p(f.getUTCHours())}${p(f.getUTCMinutes())}`;
  const to = `${p(t.getUTCHours())}${p(t.getUTCMinutes())}`;
  const ext = format === 'log' ? 'log' : format;

  return `${ctx.orgKey}-p${ctx.programId}-e${ctx.environmentId}-${ctx.service}-${ctx.logName}-${from}_${to}.${ext}`;
}

/**
 * 출처 헤더. 며칠 뒤 이 파일이 어디서 왔는지 헷갈리지 않게 하는 것이 목적이다.
 * log/csv 는 주석 라인, json 은 첫 객체로 나간다.
 */
export function provenanceLines(ctx: ExportContext): string[] {
  const filters: string[] = [];
  if (ctx.levels && ctx.levels.length > 0) filters.push(`level:${ctx.levels.join('|')}`);
  if (ctx.query) filters.push(`query:"${ctx.query}"`);

  return [
    'AEM Cloud Log Viewer export',
    `org=${ctx.orgKey}  program=${ctx.programId}  environment=${ctx.environmentId} (${ctx.environmentType})  service=${ctx.service}  log=${ctx.logName}`,
    `range=${kstIso(ctx.from)} ~ ${kstIso(ctx.to)} (KST)`,
    `filters=${filters.length > 0 ? filters.join('  ') : '(없음)'}`,
    `masked=${ctx.masked}  lines=${ctx.lines}  continuation=${ctx.includeContinuation}`,
    `exported by ${ctx.exportedBy} at ${kstIso(ctx.exportedAt)}`,
  ];
}

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * 엔트리를 포맷에 맞춰 한 덩이씩 내놓는다.
 * 제너레이터라 전체를 문자열로 이어붙이지 않는다 — 500MB 까지 허용하므로 그러면 죽는다.
 */
export function* renderExport(
  entries: Iterable<LogEntry>,
  ctx: ExportContext,
  format: ExportFormat,
): Generator<string> {
  const header = provenanceLines(ctx);

  if (format === 'json') {
    // JSONL. 첫 줄이 출처 객체다.
    yield JSON.stringify({ _export: Object.fromEntries(header.map((l, i) => [`line${i + 1}`, l])) }) + '\n';
    for (const e of entries) {
      const out = ctx.includeContinuation ? e : { ...e, continuation: [] };
      yield JSON.stringify(out) + '\n';
    }
    return;
  }

  for (const l of header) yield `# ${l}\n`;

  if (format === 'csv') {
    yield 'ts,level,pod,thread,logger,message\n';
    for (const e of entries) {
      const message = ctx.includeContinuation && e.continuation.length > 0
        ? `${e.message}\n${e.continuation.join('\n')}`
        : e.message;
      yield [
        new Date(e.ts).toISOString(),
        e.level,
        e.pod,
        e.thread,
        e.logger,
        message,
      ]
        .map(csvCell)
        .join(',') + '\n';
    }
    return;
  }

  // log — 원본 라인 그대로
  for (const e of entries) {
    yield e.raw + '\n';
    if (ctx.includeContinuation) for (const c of e.continuation) yield c + '\n';
  }
}

/** 상한 검사를 위한 어림값. 정확할 필요는 없고 과소평가만 안 하면 된다. */
export function estimateBytes(entries: LogEntry[], format: ExportFormat, includeContinuation: boolean): number {
  let n = 512; // 헤더
  for (const e of entries) {
    n += Buffer.byteLength(e.raw, 'utf8') + 1;
    if (includeContinuation) for (const c of e.continuation) n += Buffer.byteLength(c, 'utf8') + 1;
    // json 은 필드명·이스케이프 때문에 원본보다 커진다
    if (format === 'json') n += 200;
  }
  return n;
}
