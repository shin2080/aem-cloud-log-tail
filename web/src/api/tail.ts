import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LogEntry, LogLevel } from '@shared/types';
import { EMPTY, upsertAll, type Buffered } from '../lib/logbuffer';

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

export function useTailStream(params: TailParams | null): TailState & {
  setPaused: (p: boolean) => void;
  clear: () => void;
} {
  const [buffered, setBuffered] = useState<Buffered>(EMPTY);
  const [status, setStatus] = useState<TailStatus>('closed');
  const [error, setError] = useState<string | null>(null);
  const [droppedCount, setDroppedCount] = useState(0);
  const [rolloverDate, setRolloverDate] = useState<string | null>(null);
  const [paused, setPausedState] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  // 일시정지 중에는 여기에 쌓아두고 화면은 건드리지 않는다. 서버 폴링은 계속 돈다.
  const parked = useRef<Buffered>(EMPTY);
  const pausedRef = useRef(false);

  /**
   * 마지막으로 확인한 서버 세션의 세대.
   *
   * EventSource 는 끊기면 스스로 다시 붙는데, 그 사이 서버 세션이 유휴 정리되거나
   * 서버가 재시작했으면 seq 가 0부터 다시 시작한다. 그러면 새 엔트리의 seq 가
   * 화면의 마지막 seq 보다 작아서 upsert 가 전부 버린다 —
   * 화면은 '연결됨' 인데 로그만 안 늘어나는, 모니터에 걸어두면 알 수 없는 고장이다.
   */
  const generation = useRef<string | null>(null);
  /** 화면에 있는 마지막 seq. 세대가 없던 옛 서버까지 대비한 2차 방어선이다. */
  const newestSeq = useRef(-1);

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
    if (!p && parked.current.entries.length > 0) {
      const flush = parked.current.entries;
      parked.current = EMPTY;
      setPendingCount(0);
      setBuffered((cur) => upsertAll(cur, flush));
    }
  }, []);

  const clear = useCallback(() => {
    parked.current = EMPTY;
    newestSeq.current = -1;
    setPendingCount(0);
    setBuffered(EMPTY);
    setDroppedCount(0);
  }, []);

  useEffect(() => {
    if (!url) {
      setStatus('closed');
      return;
    }

    setBuffered(EMPTY);
    setError(null);
    setDroppedCount(0);
    setRolloverDate(null);
    parked.current = EMPTY;
    generation.current = null;
    newestSeq.current = -1;
    setPendingCount(0);
    setStatus('connecting');

    /** 서버 세션이 새로 만들어졌다. 쌓아둔 것은 이제 다른 세계의 seq 다. */
    const resetForNewSession = (): void => {
      parked.current = EMPTY;
      newestSeq.current = -1;
      setPendingCount(0);
      setDroppedCount(0);
      setBuffered(EMPTY);
    };

    // 세션 쿠키가 자동으로 실린다. WebSocket 대신 SSE 를 쓰는 이유다.
    const es = new EventSource(url);

    es.addEventListener('ready', (ev) => {
      const data = (ev as MessageEvent<string>).data;
      const info = data ? (JSON.parse(data) as { generation?: string }) : null;
      // 처음 붙는 것이면 세대만 기억한다. 이미 알던 세션과 다르면 화면을 비운다.
      if (info?.generation) {
        if (generation.current !== null && generation.current !== info.generation) resetForNewSession();
        generation.current = info.generation;
      }
      setStatus('open');
      setError(null);
    });

    es.addEventListener('entries', (ev) => {
      const { entries: batch } = JSON.parse((ev as MessageEvent<string>).data) as { entries: LogEntry[] };
      if (batch.length === 0) return;

      /*
        세대를 못 받았을 때를 위한 2차 방어선.

        한 세션 안에서 seq 는 늘기만 한다. 재연결로 버퍼 전체를 다시 받으면
        배치의 '첫' seq 는 뒤로 갈 수 있지만 '마지막' seq 는 절대 뒤로 가지 않는다.
        마지막이 뒤로 갔다면 세션이 다시 시작한 것이다.
      */
      const batchNewest = batch[batch.length - 1]!.seq;
      if (newestSeq.current >= 0 && batchNewest < newestSeq.current) resetForNewSession();
      newestSeq.current = Math.max(newestSeq.current, batchNewest);

      if (pausedRef.current) {
        parked.current = upsertAll(parked.current, batch);
        setPendingCount(parked.current.entries.length);
        return;
      }
      setBuffered((cur) => upsertAll(cur, batch));
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

  return {
    entries: buffered.entries,
    status,
    error,
    droppedCount,
    rolloverDate,
    paused,
    pendingCount,
    setPaused,
    clear,
  };
}
