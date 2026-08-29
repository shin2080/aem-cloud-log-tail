import { randomUUID } from 'node:crypto';
import type { LogEntry } from '../../shared/types.js';
import { Masker } from '../parse/mask.js';
import type { AppConfig } from '../config/env.js';
import { CloudManagerClient } from '../adobe/cloudmanager.js';
import { runScan, ScanError, type ScanRequest, type ScanResult } from './scan.js';

export type JobStatus = 'running' | 'done' | 'cancelled' | 'error';

export interface JobEvent {
  type: 'progress' | 'entries' | 'done' | 'error';
  payload: unknown;
}

type JobListener = (e: JobEvent) => void;

export interface SearchJob {
  id: string;
  /** 이 잡을 만든 사용자. 다른 사람이 jobId 를 알아내도 열 수 없다 */
  userId: string;
  status: JobStatus;
  /** 내보내기 헤더에 쓸 원본 요청 */
  request: ScanRequest;
  /** 결과. SEARCH_MAX_RESULT_LINES 로 상한이 걸린다 */
  entries: LogEntry[];
  result: ScanResult | null;
  error: { code: string; message: string } | null;
  progress: { scannedBytes: number; totalBytes: number; matched: number };
  createdAt: number;
  finishedAt: number | null;
}

/** 끝난 잡을 이만큼 들고 있는다. 내보내기가 jobId 를 참조하므로 바로 버리면 안 된다. */
const DONE_TTL_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

/**
 * 시간대 조회 잡 관리.
 *
 * 결과는 메모리에만 있다. tail 버퍼와 같은 원칙이다 — 프로세스가 죽으면 사라진다.
 */
export class SearchJobRegistry {
  private readonly jobs = new Map<string, SearchJob>();
  private readonly listeners = new Map<string, Set<JobListener>>();
  private readonly aborts = new Map<string, AbortController>();

  constructor(
    private readonly cfg: AppConfig,
    private readonly cm: CloudManagerClient,
  ) {
    const t = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    t.unref();
  }

  get(id: string, userId: string): SearchJob | null {
    const job = this.jobs.get(id);
    // 남의 잡은 존재 자체를 알리지 않는다.
    if (!job || job.userId !== userId) return null;
    return job;
  }

  start(userId: string, request: ScanRequest): SearchJob {
    const id = randomUUID();
    const job: SearchJob = {
      id,
      userId,
      status: 'running',
      request,
      entries: [],
      result: null,
      error: null,
      progress: { scannedBytes: 0, totalBytes: 0, matched: 0 },
      createdAt: Date.now(),
      finishedAt: null,
    };
    this.jobs.set(id, job);

    const ac = new AbortController();
    this.aborts.set(id, ac);

    void this.execute(job, ac);
    return job;
  }

  private async execute(job: SearchJob, ac: AbortController): Promise<void> {
    try {
      const result = await runScan(
        {
          cm: this.cm,
          masker: new Masker(this.cfg.MASKING_ENABLED),
          maxResultLines: this.cfg.SEARCH_MAX_RESULT_LINES,
        },
        job.request,
        {
          onEntries: (entries) => {
            job.entries.push(...entries);
            this.emit(job.id, { type: 'entries', payload: { entries } });
          },
          onProgress: (scannedBytes, totalBytes, matched) => {
            job.progress = { scannedBytes, totalBytes, matched };
            this.emit(job.id, { type: 'progress', payload: job.progress });
          },
        },
        ac.signal,
      );

      job.result = result;
      job.status = ac.signal.aborted ? 'cancelled' : 'done';
      this.emit(job.id, {
        type: 'done',
        payload: {
          matched: result.matched,
          truncated: result.truncated,
          skippedDates: result.skippedDates,
          missingDates: result.missingDates,
          cancelled: job.status === 'cancelled',
        },
      });
    } catch (err) {
      if (ac.signal.aborted) {
        job.status = 'cancelled';
        this.emit(job.id, { type: 'done', payload: { matched: job.entries.length, truncated: false, cancelled: true } });
      } else {
        job.status = 'error';
        job.error =
          err instanceof ScanError
            ? { code: err.code, message: err.message }
            : { code: 'scan_failed', message: '조회에 실패했다' };
        this.emit(job.id, { type: 'error', payload: job.error });
      }
    } finally {
      job.finishedAt = Date.now();
      this.aborts.delete(job.id);
    }
  }

  cancel(id: string, userId: string): boolean {
    const job = this.get(id, userId);
    if (!job || job.status !== 'running') return false;
    this.aborts.get(id)?.abort();
    return true;
  }

  subscribe(id: string, fn: JobListener): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(id);
    };
  }

  private emit(id: string, e: JobEvent): void {
    const set = this.listeners.get(id);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(e);
      } catch {
        // 구독자 하나가 터져도 나머지는 계속 받는다
      }
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.finishedAt !== null && now - job.finishedAt > DONE_TTL_MS) {
        this.jobs.delete(id);
        this.listeners.delete(id);
      }
    }
  }

  stopAll(): void {
    for (const ac of this.aborts.values()) ac.abort();
    this.aborts.clear();
    this.jobs.clear();
    this.listeners.clear();
  }
}
