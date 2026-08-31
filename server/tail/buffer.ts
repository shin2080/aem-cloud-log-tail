import type { LogEntry, LogLevel } from '../../shared/types.js';

/**
 * 세션당 하나. 로그 본문이 존재하는 유일한 장소다.
 * 프로세스가 죽으면 사라진다 — 그게 설계다 (SPEC 제약 1).
 */
export class RingBuffer {
  /** seq 오름차순 */
  private entries: LogEntry[] = [];
  private bytes = 0;
  private dropped = 0;

  /**
   * 넘칠 때 상한보다 이만큼 더 버린다.
   *
   * 상한에 딱 맞춰 자르면 그 뒤로는 새 줄이 올 때마다 배열 앞을 한 칸씩 밀게 된다.
   * 24시간 켜두는 도구에서는 '버퍼가 꽉 찬 상태' 가 예외가 아니라 정상 상태라,
   * 그 한 칸이 곧 5만 원소 memmove × 초당 수백 번이 된다.
   * 여유를 두고 한 번에 잘라 그 사이에는 아예 자르지 않는다.
   *
   * 작게 잡은 설정(테스트 등)에서는 0 이 되어 예전처럼 정확히 상한을 지킨다.
   */
  private readonly lineSlack: number;
  private readonly byteSlack: number;

  constructor(
    private readonly maxLines: number,
    private readonly maxBytes: number,
  ) {
    this.lineSlack = Math.floor(maxLines * 0.02);
    this.byteSlack = Math.floor(maxBytes * 0.02);
  }

  get size(): number {
    return this.entries.length;
  }

  get byteSize(): number {
    return this.bytes;
  }

  /** 넘쳐서 밀려난 누적 건수. 0이 아니면 사용자에게 알려야 한다. */
  get droppedCount(): number {
    return this.dropped;
  }

  get oldestSeq(): number {
    return this.entries[0]?.seq ?? -1;
  }

  get newestSeq(): number {
    return this.entries[this.entries.length - 1]?.seq ?? -1;
  }

  /**
   * 새 엔트리는 뒤에 붙이고, 이미 있는 seq 는 갈아끼운다.
   * 스택트레이스가 뒤늦게 도착하면 직전 엔트리가 개정된 채 다시 온다.
   */
  upsert(entry: LogEntry): void {
    const last = this.entries[this.entries.length - 1];

    if (last && entry.seq === last.seq) {
      this.bytes += sizeOf(entry) - sizeOf(last);
      this.entries[this.entries.length - 1] = entry;
      this.evict();
      return;
    }
    if (last && entry.seq < last.seq) {
      // 이미 밀려났거나 순서가 뒤집혔다. 조용히 버리되 되살리지는 않는다.
      const i = this.indexOf(entry.seq);
      if (i >= 0) {
        this.bytes += sizeOf(entry) - sizeOf(this.entries[i]!);
        this.entries[i] = entry;
      }
      return;
    }

    this.entries.push(entry);
    this.bytes += sizeOf(entry);
    this.evict();
  }

  /** seq 구간 [fromSeq, toSeq] 을 잘라낸다. 경계 포함. */
  slice(fromSeq?: number, toSeq?: number): LogEntry[] {
    return this.entries.filter(
      (e) => (fromSeq === undefined || e.seq >= fromSeq) && (toSeq === undefined || e.seq <= toSeq),
    );
  }

  all(): LogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    this.bytes = 0;
    this.dropped = 0;
  }

  private indexOf(seq: number): number {
    // seq 오름차순이라 이분 탐색이 가능하다.
    let lo = 0;
    let hi = this.entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = this.entries[mid]!.seq;
      if (s === seq) return mid;
      if (s < seq) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** 몇 개를 버릴지 먼저 세고 한 번에 자른다. shift 를 반복하면 그때마다 배열 전체가 밀린다. */
  private evict(): void {
    if (this.entries.length <= this.maxLines && this.bytes <= this.maxBytes) return;

    const lineTarget = Math.max(1, this.maxLines - this.lineSlack);
    const byteTarget = Math.max(0, this.maxBytes - this.byteSlack);

    const total = this.entries.length;
    let drop = 0;
    let bytes = this.bytes;
    while (total - drop > lineTarget || (bytes > byteTarget && total - drop > 1)) {
      bytes -= sizeOf(this.entries[drop]!);
      drop++;
    }
    if (drop === 0) return;

    this.entries.splice(0, drop);
    this.bytes = bytes;
    this.dropped += drop;
  }
}

/** 대략적인 바이트 크기. 정확할 필요는 없고 상한을 지키기만 하면 된다. */
function sizeOf(e: LogEntry): number {
  let n = Buffer.byteLength(e.raw, 'utf8') + 64; // 64 = 필드 오버헤드 어림
  for (const c of e.continuation) n += Buffer.byteLength(c, 'utf8') + 1;
  return n;
}

export function filterByLevel(entries: LogEntry[], levels: LogLevel[] | null): LogEntry[] {
  if (!levels || levels.length === 0) return entries;
  const set = new Set(levels);
  return entries.filter((e) => set.has(e.level));
}
