import type { LogEntry } from '../../../shared/types.js';

/**
 * 화면이 들고 있는 로그. 서버 링버퍼의 브라우저 쪽 짝이다.
 *
 * 줄 수만으로 막으면 안 된다 — aemerror 는 엔트리 하나가 스택트레이스까지 수 KB 라
 * 5만 줄이면 창 하나가 수백 MB 를 먹는다. 서버 링버퍼가 줄 수와 바이트를 함께 보는 것과
 * 같은 이유다. 몇 시간 보다 닫는 도구면 티가 안 나지만, 모니터에 며칠 걸어두면
 * 이 차이가 탭이 죽느냐 마느냐를 가른다.
 *
 * 바이트는 문자 수로 어림한다. 로그는 거의 ASCII 라 실제 크기와 크게 다르지 않고,
 * 정확할 필요 없이 상한만 지키면 된다.
 */
export const CLIENT_MAX_ENTRIES = 20_000;
export const CLIENT_MAX_CHARS = 24 * 1024 * 1024;

export interface Buffered {
  entries: LogEntry[];
  /** 어림한 크기. 트리밍할 때마다 전체를 훑지 않으려고 들고 다닌다 */
  chars: number;
}

export const EMPTY: Buffered = { entries: [], chars: 0 };

export function sizeOf(e: LogEntry): number {
  let n = e.raw.length + 64; // 64 = 필드 오버헤드 어림
  for (const c of e.continuation) n += c.length + 1;
  return n;
}

/**
 * seq 로 upsert 하고 상한을 지킨다.
 *
 * 스택트레이스가 뒤늦게 오면 서버가 같은 seq 를 다시 보낸다 — 갈아끼워야 한다.
 * 상한은 줄 수와 크기 둘 다 본다.
 */
export function upsertAll(
  current: Buffered,
  incoming: LogEntry[],
  maxEntries = CLIENT_MAX_ENTRIES,
  maxChars = CLIENT_MAX_CHARS,
): Buffered {
  if (incoming.length === 0) return current;
  const next = current.entries.slice();
  let chars = current.chars;

  for (const e of incoming) {
    const last = next[next.length - 1];
    if (!last || e.seq > last.seq) {
      next.push(e);
      chars += sizeOf(e);
      continue;
    }
    if (e.seq === last.seq) {
      chars += sizeOf(e) - sizeOf(last);
      next[next.length - 1] = e;
      continue;
    }
    // 드문 경우: 이전 엔트리의 개정. 이분 탐색으로 찾는다.
    let lo = 0;
    let hi = next.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = next[mid]!.seq;
      if (s === e.seq) {
        chars += sizeOf(e) - sizeOf(next[mid]!);
        next[mid] = e;
        break;
      }
      if (s < e.seq) lo = mid + 1;
      else hi = mid - 1;
    }
  }

  // 앞에서 몇 개를 버릴지 먼저 세고 한 번에 자른다.
  // 하나씩 shift 하면 그때마다 배열 전체가 밀린다 — 버퍼가 꽉 찬 뒤로는 그게 기본 동작이 된다.
  let drop = 0;
  while (next.length - drop > maxEntries || (chars > maxChars && next.length - drop > 1)) {
    chars -= sizeOf(next[drop]!);
    drop++;
  }

  return drop === 0 ? { entries: next, chars } : { entries: next.slice(drop), chars };
}
