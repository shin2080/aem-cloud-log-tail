import type { LogEntry } from '../../shared/types.js';
import { createParser, type LogParser } from '../parse/parser.js';
import { maskEntry, type Masker } from '../parse/mask.js';
import { RingBuffer } from './buffer.js';
import type { TailTransport } from './transport.js';

export interface TailKey {
  orgKey: string;
  environmentId: string;
  service: string;
  logName: string;
}

export function tailKeyOf(k: TailKey): string {
  return `${k.orgKey} ${k.environmentId} ${k.service} ${k.logName}`;
}

export interface TailSessionOptions {
  key: TailKey;
  transport: TailTransport;
  masker: Masker;
  pollIntervalMs: number;
  initialBytes: number;
  maxLines: number;
  maxBytes: number;
  now?: () => number;
}

export type TailEvent =
  | { type: 'entries'; entries: LogEntry[] }
  | { type: 'rollover'; newDate: string }
  | { type: 'truncated'; droppedCount: number; oldestSeq: number }
  | { type: 'error'; code: string; message: string; recoverable: boolean };

export type TailListener = (e: TailEvent) => void;

/**
 * 새 날짜 파일이 안 보일 때 목록을 다시 부르는 최소 간격.
 * 이 호출만 Cloud Manager 로 나가므로(Range 폴링은 스토리지 직행) 아껴 써야 한다.
 */
const ROLLOVER_RETRY_MS = 60_000;

/** epoch ms -> UTC 기준 YYYY-MM-DD. 로그 파일 이름의 날짜가 이것이다. */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 환경×서비스×로그파일 하나를 따라가는 폴링 루프 + 링버퍼.
 *
 * 폴링은 스토리지로 직접 나간다. Cloud Manager API 를 매번 부르지 않는다 --
 * 그게 이 도구가 레이트 리밋을 소모하지 않는 이유다.
 *
 * 시간에 의존하는 부분은 전부 now() 와 pollOnce() 로 빼뒀다.
 * UTC 자정 롤오버는 조용히 깨지는 버그라 모의 시계로 직접 검증한다.
 */
export class TailSession {
  readonly key: TailKey;
  private readonly transport: TailTransport;
  private readonly masker: Masker;
  private readonly now: () => number;
  private readonly opts: TailSessionOptions;

  private readonly buffer: RingBuffer;
  private parser: LogParser;
  private listeners = new Set<TailListener>();

  /** 현재 따라가고 있는 UTC 날짜의 파일 */
  private currentDate = '';
  private url = '';
  /** 압축이 없으므로 그대로 바이트 오프셋이다 */
  private offset = 0;
  private started = false;
  private timer: NodeJS.Timeout | null = null;
  private lastDropped = 0;
  private polling = false;
  private lastRolloverAttempt = 0;

  constructor(opts: TailSessionOptions) {
    this.opts = opts;
    this.key = opts.key;
    this.transport = opts.transport;
    this.masker = opts.masker;
    this.now = opts.now ?? Date.now;
    this.buffer = new RingBuffer(opts.maxLines, opts.maxBytes);
    this.parser = createParser(opts.key.logName, 0);
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  get bufferState(): { count: number; oldestSeq: number; newestSeq: number } {
    return { count: this.buffer.size, oldestSeq: this.buffer.oldestSeq, newestSeq: this.buffer.newestSeq };
  }

  get date(): string {
    return this.currentDate;
  }

  get byteOffset(): number {
    return this.offset;
  }

  snapshot(fromSeq?: number, toSeq?: number): LogEntry[] {
    return this.buffer.slice(fromSeq, toSeq);
  }

  subscribe(fn: TailListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * 최초 진입. 파일 전체를 받지 않는다 -- 끝에서 initialBytes 만 읽어 시작점을 잡는다.
   * 하루치가 180MB 인 파일이라 이걸 어기면 도구의 존재 이유가 사라진다.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // 오늘 UTC 날짜 파일이 아직 없을 수 있다 (자정 직후). 열린 날짜를 그대로 받아 쓴다.
    const opened = await this.transport.resolveTail(utcDate(this.now()));
    this.currentDate = opened.date;
    this.url = opened.url;

    const size = await this.transport.sizeOf(this.url);
    const from = Math.max(0, size - this.opts.initialBytes);
    this.offset = from;

    const read = await this.transport.readFrom(this.url, from);
    if (read.status !== 416 && read.bytes.byteLength > 0) {
      this.offset = from + read.bytes.byteLength;
      // 파일 중간부터 읽었으므로 첫 줄은 잘려 있다. 파서가 UNKNOWN 으로 처리하고 넘어간다.
      this.ingest(read.bytes);
    }

    this.timer = setInterval(() => void this.tick(), this.opts.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
    this.buffer.clear();
    this.listeners.clear();
  }

  private async tick(): Promise<void> {
    // 폴링이 겹치지 않게 한다. 느린 응답이 쌓이면 오프셋이 꼬인다.
    if (this.polling) return;
    this.polling = true;
    try {
      await this.pollOnce();
    } catch (err) {
      this.emit({
        type: 'error',
        code: 'poll_failed',
        message: err instanceof Error ? err.message : String(err),
        recoverable: true,
      });
    } finally {
      this.polling = false;
    }
  }

  /**
   * 폴링 한 번. 테스트가 직접 부른다.
   *
   * SPEC 6.3 의 5번 루프:
   *   a. Range: bytes={offset}-
   *   b. 416 -> 새 데이터 없음
   *   c. 206 -> 파서로 넘기고 offset += 길이
   *   e. UTC 자정 경과 -> 이전 파일의 꼬리를 한 번 더 읽고 새 파일로 전환
   */
  async pollOnce(): Promise<void> {
    // 읽기가 실패해도 날짜 검사는 반드시 돈다.
    // 이전 파일의 서명 URL 이 죽으면 매 폴링이 여기서 터지는데, 그때 롤오버를 건너뛰면
    // 세션이 죽은 파일에 영영 붙잡힌다. 조용히 멈춘 tail 이 가장 나쁘다.
    let readError: unknown = null;
    try {
      const read = await this.transport.readFrom(this.url, this.offset);
      if (read.status !== 416 && read.bytes.byteLength > 0) {
        this.offset += read.bytes.byteLength;
        this.ingest(read.bytes);
      }
    } catch (err) {
      readError = err;
    }

    const today = utcDate(this.now());
    if (today !== this.currentDate) {
      // 새 파일로 넘어갔으면 이전 파일의 오류는 더 이상 의미가 없다.
      await this.rollover(today);
      return;
    }
    if (readError) throw readError;
  }

  /**
   * UTC 자정 롤오버. 한국 시간 오전 9시에 일어난다.
   *
   * 전환 직전에 이전 파일의 남은 꼬리를 한 번 더 읽는다.
   * 이걸 빼면 자정 직전 몇 초의 로그가 조용히 사라진다.
   */
  private async rollover(targetDate: string): Promise<void> {
    // 자정 직후에는 Adobe 가 새 날짜 파일을 아직 안 올린다. 그동안은 조용히 기다린다 —
    // 매 폴링마다 목록을 다시 부르면 Cloud Manager 레이트 리밋을 태운다.
    const now = this.now();
    if (now - this.lastRolloverAttempt < ROLLOVER_RETRY_MS) return;
    this.lastRolloverAttempt = now;

    let opened;
    try {
      opened = await this.transport.resolveTail(targetDate);
    } catch {
      return; // 다음 폴링에서 다시 시도한다
    }

    // 아직 새 파일이 없어 같은 파일이 잡혔다. 전환하지 않는다 —
    // 여기서 currentDate 를 먼저 바꿔버리면 다시는 재시도하지 않아 옛 파일에 갇힌다.
    if (opened.date === this.currentDate) return;

    // 1. 이전 파일에 남은 꼬리를 마저 긁는다. 이걸 빼면 자정 직전 로그가 사라진다.
    try {
      const tail = await this.transport.readFrom(this.url, this.offset);
      if (tail.status !== 416 && tail.bytes.byteLength > 0) {
        this.offset += tail.bytes.byteLength;
        this.ingest(tail.bytes);
      }
    } catch {
      // 이전 파일 URL 이 이미 죽었을 수 있다. 새 파일로 넘어가는 게 우선이다.
    }

    // 2. 열려 있던 마지막 엔트리를 닫는다 (개행 없이 끝난 라인).
    this.emitEntries(this.parser.flush());

    // 3. 전환. seq 는 이어받아 클라이언트의 범위 선택이 끊기지 않게 한다.
    this.parser = createParser(this.key.logName, this.parser.nextSeq);
    this.currentDate = opened.date;
    this.url = opened.url;
    this.offset = 0;

    this.emit({ type: 'rollover', newDate: opened.date });

    // 4. 새 파일의 처음부터 읽는다. 자정 직후라 아직 작다.
    const read = await this.transport.readFrom(this.url, 0);
    if (read.status !== 416 && read.bytes.byteLength > 0) {
      this.offset = read.bytes.byteLength;
      this.ingest(read.bytes);
    }
  }

  /** 파싱 -> 마스킹 -> 버퍼. 마스킹은 버퍼에 들어가기 전에 끝난다. */
  private ingest(bytes: Uint8Array): void {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    this.emitEntries(this.parser.push(text));
  }

  private emitEntries(entries: LogEntry[]): void {
    if (entries.length === 0) return;

    const masked = entries.map((e) => maskEntry(e, this.masker));
    for (const e of masked) this.buffer.upsert(e);

    this.emit({ type: 'entries', entries: masked });

    if (this.buffer.droppedCount > this.lastDropped) {
      const droppedCount = this.buffer.droppedCount - this.lastDropped;
      this.lastDropped = this.buffer.droppedCount;
      // 조용히 사라지면 안 된다.
      this.emit({ type: 'truncated', droppedCount, oldestSeq: this.buffer.oldestSeq });
    }
  }

  private emit(ev: TailEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        // 구독자 하나가 터져도 나머지는 계속 받아야 한다.
      }
    }
  }
}
