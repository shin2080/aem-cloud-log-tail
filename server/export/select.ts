import type { LogEntry, LogLevel } from '../../shared/types.js';

export interface SelectionSpec {
  /** 정확히 이 줄들만. 화면에 보이는 것이 seq 구간과 다를 때 쓴다 */
  seqs?: number[];
  seqFrom?: number;
  seqTo?: number;
  levels?: LogLevel[];
  query?: string;
}

/**
 * 내보낼 줄을 고른다.
 *
 * 라우트 안에 두면 테스트가 HTTP 를 거쳐야 해서 이 규칙만 따로 검증할 수가 없다.
 * 실제로 여기 있던 버그(구간만 보고 화면과 어긋나던 것)를 테스트 없이 고쳤었다.
 */
export function selectForExport(all: LogEntry[], spec: SelectionSpec): LogEntry[] {
  let out: LogEntry[];

  if (spec.seqs && spec.seqs.length > 0) {
    const want = new Set(spec.seqs);
    out = all.filter((e) => want.has(e.seq));
  } else {
    out = all.filter(
      (e) =>
        (spec.seqFrom === undefined || e.seq >= spec.seqFrom) &&
        (spec.seqTo === undefined || e.seq <= spec.seqTo),
    );
  }

  const levelSet = spec.levels && spec.levels.length > 0 ? new Set(spec.levels) : null;
  const needle = spec.query?.trim().toLowerCase();
  if (!levelSet && !needle) return out;

  return out.filter(
    (e) =>
      (!levelSet || levelSet.has(e.level)) &&
      (!needle ||
        e.raw.toLowerCase().includes(needle) ||
        e.continuation.some((c) => c.toLowerCase().includes(needle))),
  );
}
