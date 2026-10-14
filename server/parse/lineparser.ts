import type { LogEntry, LogLevel } from '../../shared/types.js';
import type { LogParser } from './parser.js';

/** parseLine 이 돌려주는 것. seq 와 continuation 은 기반 클래스가 채운다. */
export type ParsedLine = Omit<LogEntry, 'seq' | 'continuation'>;

/**
 * 줄 단위 로그 파서의 공통 뼈대.
 *
 * 청크가 임의의 바이트 경계에서 잘려 들어오므로 마지막 개행 이후의 잔여를 들고 있다가
 * 다음 청크 앞에 이어붙여야 한다. 이 처리를 로그 종류마다 복붙하면 반드시 어긋난다.
 * 구현체는 `parseLine` 하나만 채운다.
 */
export abstract class LineBufferedParser implements LogParser {
  abstract readonly name: string;

  /** 마지막 개행 이후의 잔여. 다음 청크 앞에 붙는다. */
  private carry = '';
  /** 아직 열려 있는 엔트리. 뒤따르는 비정형 라인이 여기 붙는다. */
  private open: LogEntry | null = null;
  /**
   * 시각을 아직 모르는 선두 조각. 스트림 중간에 붙으면 첫 줄이 잘려 들어오는데,
   * 그 조각은 바로 다음 정상 줄과 같은 시각이다. 다음 줄이 오면 그 시각을 물려준다.
   * 예전에는 Date.now() 를 박아서, 시각 이동이 늘 이 줄에 걸려 맨 위로 튀었다.
   */
  private pendingOrphan: LogEntry | null = null;
  private seq: number;

  constructor(startSeq = 0) {
    this.seq = startSeq;
  }

  get nextSeq(): number {
    return this.seq;
  }

  /**
   * 한 줄을 엔트리로 바꾼다.
   * `null` 을 돌려주면 직전 엔트리의 continuation 으로 붙는다 (스택트레이스 등).
   */
  protected abstract parseLine(line: string): ParsedLine | null;

  /**
   * 이 로그가 여러 줄에 걸치는가.
   * access 로그처럼 한 줄이 곧 한 엔트리인 종류는 false 로 두어,
   * 파싱 실패한 줄이 직전 엔트리에 엉겨붙지 않게 한다.
   */
  protected readonly multiline: boolean = true;

  push(chunk: string): LogEntry[] {
    if (chunk.length === 0) return [];

    const text = this.carry + chunk;
    const lines = text.split('\n');
    // 마지막 조각은 개행으로 끝나지 않았다 -- 다음 청크를 기다린다.
    this.carry = lines.pop() ?? '';

    const touched = new Map<number, LogEntry>();
    for (const line of lines) this.consume(line, touched);
    return [...touched.values()];
  }

  flush(): LogEntry[] {
    if (this.carry.length === 0) return [];
    const touched = new Map<number, LogEntry>();
    this.consume(this.carry, touched);
    this.carry = '';
    return [...touched.values()];
  }

  private consume(rawLine: string, touched: Map<number, LogEntry>): void {
    // CRLF 로 와도 견딘다.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    const parsed = this.parseLine(line);
    if (parsed) {
      if (this.pendingOrphan) {
        this.pendingOrphan.ts = parsed.ts;
        touched.set(this.pendingOrphan.seq, this.pendingOrphan);
        this.pendingOrphan = null;
      }
      const entry: LogEntry = { ...parsed, seq: this.seq++, continuation: [] };
      this.open = entry;
      touched.set(entry.seq, entry);
      return;
    }

    // 정규식에 안 맞는 라인은 버리지 않는다.
    if (this.multiline && this.open) {
      // 엔트리 사이에 낀 빈 줄은 무시한다. 스택 안의 빈 줄은 살린다.
      if (line.length === 0 && this.open.continuation.length === 0) return;
      this.open.continuation.push(line);
      touched.set(this.open.seq, this.open);
      return;
    }

    if (line.trim().length === 0) return;

    // 스트림 중간에 붙었을 때의 첫 몇 줄, 또는 형식을 모르는 줄.
    // 직전 줄이 있으면 그 시각, 없으면 다음 정상 줄이 올 때 물려받는다.
    const orphan: LogEntry = {
      seq: this.seq++,
      ts: this.open?.ts ?? 0,
      level: 'UNKNOWN',
      pod: '',
      thread: '',
      logger: '',
      message: line,
      continuation: [],
      raw: line,
    };
    if (!this.open) this.pendingOrphan = orphan;
    this.open = orphan;
    touched.set(orphan.seq, orphan);
  }
}

/* ── 공통 헬퍼 ─────────────────────────────────────────── */

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * CLF 형식 시각: `29/Aug/2026:00:58:48 +0000`
 * AEMaaCS 는 전부 +0000 으로 쓰지만 오프셋이 오면 반영한다.
 */
export function parseClfTime(s: string): number | null {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\s+([+-])(\d{2})(\d{2}))?$/.exec(s);
  if (!m) return null;
  const [, dd, mon, yyyy, hh, mi, ss, sign, oh, om] = m;
  const month = MONTHS[mon!];
  if (month === undefined) return null;

  let t = Date.UTC(+yyyy!, month, +dd!, +hh!, +mi!, +ss!);
  if (sign) {
    const offset = (+oh! * 60 + +om!) * 60_000;
    t += sign === '+' ? -offset : offset;
  }
  return t;
}

/**
 * HTTP 상태코드를 레벨로 옮긴다.
 *
 * access 로그에는 레벨이란 게 없지만, 뷰어의 레벨 필터·색·ERROR 강조를 그대로 쓰려면
 * 뭔가로 매핑해야 한다. 상태코드가 가장 쓸모 있다 — 'ERROR 만 보기' 가 5xx 만 보기가 된다.
 */
export function levelFromStatus(status: number): LogLevel {
  if (status >= 500) return 'ERROR';
  if (status >= 400) return 'WARN';
  return 'INFO';
}
