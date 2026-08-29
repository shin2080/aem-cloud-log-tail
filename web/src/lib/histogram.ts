import type { LogEntry } from '../../../shared/types.js';

export interface Bucket {
  /** 구간 시작 (epoch ms) */
  t: number;
  error: number;
  warn: number;
  other: number;
}

/**
 * 시간축 히스토그램. 스크롤로 훑는 것보다 '언제 터졌나' 를 빨리 찾게 하는 것이 목적이다.
 *
 * 버킷 폭은 버퍼가 걸친 시간에 맞춰 고른다 — 5분치를 1분 버킷으로 그리면 막대가 다섯 개뿐이고,
 * 하루치를 1분 버킷으로 그리면 1440개가 되어 아무것도 안 보인다.
 */
export function buildHistogram(entries: LogEntry[], targetBuckets = 60): Bucket[] {
  if (entries.length === 0) return [];

  let min = Infinity;
  let max = -Infinity;
  for (const e of entries) {
    if (e.ts < min) min = e.ts;
    if (e.ts > max) max = e.ts;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];

  const span = Math.max(1, max - min);
  const width = Math.max(1000, Math.ceil(span / targetBuckets));
  const start = Math.floor(min / width) * width;
  const count = Math.min(targetBuckets * 2, Math.floor((max - start) / width) + 1);

  const buckets: Bucket[] = Array.from({ length: count }, (_, i) => ({
    t: start + i * width,
    error: 0,
    warn: 0,
    other: 0,
  }));

  for (const e of entries) {
    const i = Math.min(buckets.length - 1, Math.floor((e.ts - start) / width));
    const b = buckets[i];
    if (!b) continue;
    if (e.level === 'ERROR') b.error++;
    else if (e.level === 'WARN') b.warn++;
    else b.other++;
  }

  return buckets;
}

export function bucketWidthMs(buckets: Bucket[]): number {
  return buckets.length >= 2 ? buckets[1]!.t - buckets[0]!.t : 1000;
}
