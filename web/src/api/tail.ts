import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LogEntry, LogLevel } from '@shared/types';

export interface TailParams {
  org: string;
  env: string;
  service: string;
  name: string;
  levels: LogLevel[];
}

export type TailStatus = 'connecting' | 'open' | 'error' | 'closed';

export interface TailState {
  entries: LogEntry[];
  status: TailStatus;
  error: string | null;
  /** 서버 링버퍼에서 밀려난 누적 건수 */
  droppedCount: number;
  rolloverDate: string | null;
  paused: boolean;
  /** 일시정지 중 밀린 건수 */
  pendingCount: number;
}

/** 브라우저 쪽 상한. 서버 링버퍼와 같은 규모로 둔다. */
const CLIENT_MAX_ENTRIES = 50_000;

/**
 * seq 로 upsert 한다.
 * 스택트레이스가 뒤늦게 오면 서버가 같은 seq 를 다시 보낸다 — 갈아끼워야 한다.
 */
function upsertAll(current: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  if (incoming.length === 0) return current;
  const next = current.slice();

  for (const e of incoming) {
    const last = next[next.length - 1];
    if (!last || e.seq > last.seq) {
      next.push(e);
      continue;
    }
    if (e.seq === last.seq) {
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
        next[mid] = e;
        break;
      }
      if (s < e.seq) lo = mid + 1;
      else hi = mid - 1;
    }
  }

  return next.length > CLIENT_MAX_ENTRIES ? next.slice(next.length - CLIENT_MAX_ENTRIES) : next;
}

export function useTailStream(params: TailParams | null): TailState & {
  setPaused: (p: boolean) => void;
  clear: () => void;
} {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<TailStatus>('closed');
  const [error, setError] = useState<string | null>(null);
  const [droppedCount, setDroppedCount] = useState(0);
  const [rolloverDate, setRolloverDate] = useState<string | null>(null);
  const [paused, setPausedState] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  // 일시정지 중에는 여기에 쌓아두고 화면은 건드리지 않는다. 서버 폴링은 계속 돈다.
  const parked = useRef<LogEntry[]>([]);
  const pausedRef = useRef(false);

  const url = useMemo(() => {
    if (!params) return null;
    const q = new URLSearchParams({
      org: params.org,
      env: params.env,
      service: params.service,
      name: params.name,
    });
    if (params.levels.length > 0) q.set('levels', params.levels.join(','));
    return `/api/tail?${q.toString()}`;
  }, [params]);

  const setPaused = useCallback((p: boolean) => {
    pausedRef.current = p;
    setPausedState(p);
    if (!p && parked.current.length > 0) {
      const flush = parked.current;
      parked.current = [];
      setPendingCount(0);
      setEntries((cur) => upsertAll(cur, flush));
    }
  }, []);

  const clear = useCallback(() => {
    parked.current = [];
    setPendingCount(0);
    setEntries([]);
    setDroppedCount(0);
  }, []);

  useEffect(() => {
    if (!url) {
      setStatus('closed');
      return;
    }

    setEntries([]);
    setError(null);
    setDroppedCount(0);
    setRolloverDate(null);
    parked.current = [];
    setPendingCount(0);
    setStatus('connecting');

    // 세션 쿠키가 자동으로 실린다. WebSocket 대신 SSE 를 쓰는 이유다.
    const es = new EventSource(url);

    es.addEventListener('ready', () => {
      setStatus('open');
      setError(null);
    });

    es.addEventListener('entries', (ev) => {
      const { entries: batch } = JSON.parse((ev as MessageEvent<string>).data) as { entries: LogEntry[] };
      if (pausedRef.current) {
        parked.current = upsertAll(parked.current, batch);
        setPendingCount(parked.current.length);
        return;
      }
      setEntries((cur) => upsertAll(cur, batch));
    });

    es.addEventListener('rollover', (ev) => {
      const { newDate } = JSON.parse((ev as MessageEvent<string>).data) as { newDate: string };
      setRolloverDate(newDate);
    });

    es.addEventListener('truncated', (ev) => {
      const { droppedCount: n } = JSON.parse((ev as MessageEvent<string>).data) as { droppedCount: number };
      setDroppedCount((d) => d + n);
    });

    es.addEventListener('error', (ev) => {
      // 서버가 보낸 error 이벤트에는 data 가 있다. 전송 계층 오류에는 없다.
      const data = (ev as MessageEvent<string>).data;
      if (data) {
        const e = JSON.parse(data) as { message: string; recoverable: boolean };
        setError(e.message);
        if (!e.recoverable) {
          setStatus('error');
          es.close();
        }
        return;
      }
      // EventSource 는 스스로 재연결한다. 끊긴 상태만 표시한다.
      setStatus(es.readyState === EventSource.CLOSED ? 'error' : 'connecting');
    });

    return () => {
      es.close();
      setStatus('closed');
    };
  }, [url]);

  return { entries, status, error, droppedCount, rolloverDate, paused, pendingCount, setPaused, clear };
}
