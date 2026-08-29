import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';

import type { LogEntry, LogLevel } from '../../shared/types.js';
import { createParser } from '../parse/parser.js';
import { maskEntry, type Masker } from '../parse/mask.js';
import type { OrgConfig } from '../config/env.js';
import { CloudManagerClient } from '../adobe/cloudmanager.js';
import { splitRetained, utcDatesInRange } from './range.js';
import type { MsgKey, MsgParams } from '../i18n/messages.js';

export interface ScanRequest {
  org: OrgConfig;
  programId: string;
  environmentId: string;
  service: string;
  logName: string;
  /** epoch ms */
  from: number;
  to: number;
  levels: LogLevel[];
  query?: string;
  regex?: boolean;
}

/** 스캔이 바깥과 닿는 지점. fetchImpl 을 주입받아야 테스트에서 가짜 스토리지를 물릴 수 있다. */
export interface ScanDeps {
  cm: CloudManagerClient;
  masker: Masker;
  maxResultLines: number;
  fetchImpl?: typeof fetch;
}

export interface ScanCallbacks {
  onEntries(entries: LogEntry[]): void;
  onProgress(scannedBytes: number, totalBytes: number, matched: number): void;
}

export interface ScanResult {
  matched: number;
  truncated: boolean;
  /** 보존 기간이 지나 아예 요청하지 않은 날짜 */
  skippedDates: string[];
  /** 요청했지만 파일이 없던 날짜. 환경이 그날 없었거나 로그가 안 쌓인 것이다 */
  missingDates: string[];
}

/** 진행률 이벤트를 이 간격 이상으로는 보내지 않는다. */
const PROGRESS_THROTTLE_MS = 250;
const ENTRY_BATCH = 500;

export function buildMatcher(query: string | undefined, regex: boolean | undefined): ((e: LogEntry) => boolean) | null {
  if (!query || query.trim().length === 0) return null;

  if (regex) {
    let re: RegExp;
    try {
      re = new RegExp(query, 'i');
    } catch {
      throw new ScanError('invalid_regex', 'invalid_regex');
    }
    return (e) => re.test(e.raw) || e.continuation.some((c) => re.test(c));
  }

  const needle = query.toLowerCase();
  return (e) => e.raw.toLowerCase().includes(needle) || e.continuation.some((c) => c.toLowerCase().includes(needle));
}

/**
 * 화면까지 올라가는 오류. 글이 아니라 키를 든다 — 응답을 만들 때
 * 요청의 언어로 옮긴다. Error 의 message 에는 키를 넣어두어 서버 로그에서
 * 어떤 오류였는지 알아볼 수 있게 한다.
 */
export class ScanError extends Error {
  constructor(
    readonly code: string,
    readonly key: MsgKey,
    readonly params?: MsgParams,
  ) {
    super(key);
    this.name = 'ScanError';
  }
}

/**
 * 시간대 조회. 날짜별 `.gz` 파일을 순서대로 스트리밍으로 훑는다.
 *
 * **전체를 메모리에 올리지 않는다.** gunzip 스트림에 흘리면서 파싱·필터하고,
 * 조건에 맞는 것만 모은다. 하루치 평문이 180MB 라 이걸 어기면 바로 죽는다.
 *
 * tail 과 달리 download 링크(.gz)를 쓴다 — 과거 구간은 이미 다 쓰여 있어
 * 부분 읽기가 필요 없고, 압축된 채로 받는 편이 대역폭이 21배 적다.
 */
export async function runScan(
  deps: ScanDeps,
  req: ScanRequest,
  cb: ScanCallbacks,
  signal: AbortSignal,
): Promise<ScanResult> {
  const { cm, masker, maxResultLines } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const allDates = utcDatesInRange(req.from, req.to);
  if (allDates.length === 0) throw new ScanError('invalid_range', 'scan_range');

  const { retained, expired } = splitRetained(allDates);
  if (retained.length === 0) {
    throw new ScanError('out_of_retention', 'out_of_retention');
  }

  const matcher = buildMatcher(req.query, req.regex);
  const levelSet = req.levels.length > 0 ? new Set(req.levels) : null;

  let matched = 0;
  let scannedBytes = 0;
  let totalBytes = 0;
  let truncated = false;
  let pending: LogEntry[] = [];
  let lastProgress = 0;

  const flush = (): void => {
    if (pending.length === 0) return;
    cb.onEntries(pending);
    pending = [];
  };

  const progress = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastProgress < PROGRESS_THROTTLE_MS) return;
    lastProgress = now;
    cb.onProgress(scannedBytes, totalBytes, matched);
  };

  // 전체 크기를 먼저 잡아 진행률의 분모로 쓴다.
  const urls: { date: string; url: string; size: number }[] = [];
  const missingDates: string[] = [];

  for (const date of retained) {
    if (signal.aborted) break;
    try {
      const signed = await cm.getSignedLogUrl(
        req.org,
        req.programId,
        req.environmentId,
        req.service,
        req.logName,
        date,
      );
      const head = await doFetch(signed.url, { headers: { Range: 'bytes=0-0' }, signal });
      await head.body?.cancel();
      if (!head.ok && head.status !== 206) {
        missingDates.push(date);
        continue;
      }
      const cr = head.headers.get('content-range');
      const size = cr ? Number(cr.split('/')[1]) : 0;
      urls.push({ date, url: signed.url, size });
      totalBytes += size;
    } catch {
      // 그날 파일이 없을 수 있다 (환경이 아직 없었거나 로그가 안 쌓였다).
      // 하루가 비었다고 조회 전체를 실패시키면 나머지 날짜의 결과까지 잃는다.
      missingDates.push(date);
    }
  }

  if (urls.length === 0) {
    throw new ScanError('no_logs', 'no_logs', { dates: retained.join(', ') });
  }
  progress(true);

  // seq 는 결과 전체에서 이어진다 — 범위 선택이 날짜를 건너도 끊기지 않게.
  let seq = 0;

  for (const { date, url } of urls) {
    if (signal.aborted || truncated) break;

    const res = await doFetch(url, { signal });
    if (!res.ok || !res.body) {
      // 크기 확인은 됐는데 본문을 못 받았다. 이 날짜만 건너뛰고 계속한다.
      missingDates.push(date);
      continue;
    }

    const parser = createParser(req.logName, seq);
    const decoder = new TextDecoder('utf-8', { fatal: false });

    // 압축 바이트를 세어 진행률에 쓴다.
    const counting = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        scannedBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });

    const take = (entries: LogEntry[]): void => {
      for (const raw of entries) {
        // 구간 밖은 버린다. 파일 하나가 하루치라 앞뒤로 남는 부분이 있다.
        if (raw.ts < req.from || raw.ts > req.to) continue;
        if (levelSet && !levelSet.has(raw.level)) continue;

        const e = maskEntry(raw, masker);
        if (matcher && !matcher(e)) continue;

        pending.push(e);
        matched++;
        if (pending.length >= ENTRY_BATCH) flush();
        if (matched >= maxResultLines) {
          truncated = true;
          return;
        }
      }
    };

    try {
      const source = Readable.fromWeb(res.body.pipeThrough(counting) as Parameters<typeof Readable.fromWeb>[0]);
      const gunzip = createGunzip();
      // pipe 는 오류를 전달하지 않는다. 네트워크가 끊기면 gunzip 이 조용히 끝나버리므로 직접 넘긴다.
      source.on('error', (err) => gunzip.destroy(err));

      for await (const chunk of source.pipe(gunzip)) {
        if (signal.aborted || truncated) break;
        take(parser.push(decoder.decode(chunk as Buffer, { stream: true })));
        progress();
      }
      if (!truncated) take(parser.flush());
    } catch (err) {
      if (signal.aborted) break;
      // 한 날짜가 없을 수 있다 (그날 로그가 아예 없는 환경). 다음 날짜로 넘어간다.
      if (err instanceof ScanError) throw err;
      cb.onProgress(scannedBytes, totalBytes, matched);
    }

    seq = parser.nextSeq;
  }

  flush();
  progress(true);
  return { matched, truncated, skippedDates: expired, missingDates };
}
