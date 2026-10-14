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
  /** 자동 재연결까지 남은 초. 재시도가 걸려 있지 않으면 null */
  retryIn: number | null;
  /** 다시 붙어도 소용없는 상태(권한 회수). 재시도 버튼을 보여주지 않는다 */
  terminal: boolean;
}

/** 재시도 간격. 5초에서 시작해 두 배씩, 1분에서 멈춘다. */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

/**
 * 다시 붙어봐야 소용없는 오류. 그 밖의 '복구 불가' 는 **그 연결**이 복구 불가라는
 * 뜻이지 **대상**이 죽었다는 뜻이 아니다 — 세션을 여는 순간 Cloud Manager 가
 * 잠깐 흔들린 것(tail_start_failed)이 대표적이다.
 */
const TERMINAL_CODES = new Set(['access_revoked']);

export function useTailStream(params: TailParams | null): TailState & {
  setPaused: (p: boolean) => void;
  clear: () => void;
  /** 백오프를 기다리지 않고 지금 다시 붙는다 */
  retry: () => void;
} {
  const [buffered, setBuffered] = useState<Buffered>(EMPTY);
  const [status, setStatus] = useState<TailStatus>('closed');
  const [error, setError] = useState<string | null>(null);
  const [droppedCount, setDroppedCount] = useState(0);
  const [rolloverDate, setRolloverDate] = useState<string | null>(null);
  const [paused, setPausedState] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [retryIn, setRetryIn] = useState<number | null>(null);
  const [terminal, setTerminal] = useState(false);

  /*
    재연결.

    예전에는 서버가 recoverable:false 를 보내면 EventSource 를 닫고 끝이었다.
    그런데 그 중 하나(tail_start_failed)는 세션을 여는 순간 IMS·Cloud Manager 가
    잠깐 흔들린 것이라, 몇 초 뒤면 멀쩡히 열린다. 그걸 영구 '끊김' 으로 두면
    모니터에 걸어둔 창은 사람이 새로고침할 때까지 죽어 있다 — 하필 배포 뒤
    서비스워커가 자동 새로고침을 하는 순간이 CM 이 가장 바쁜 때라, 네 창이
    한꺼번에 죽는 일이 실제로 가능했다.

    `reconnectKey` 를 올리면 아래 effect 가 다시 돌아 새 EventSource 를 만든다.
    url 이 그대로면 버퍼는 비우지 않는다 — 서버 세션이 바뀌었으면 세대(generation)
    검사가 알아서 비운다.
  */
  const [reconnectKey, setReconnectKey] = useState(0);
  const attempt = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdown = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastUrl = useRef<string | null>(null);

  const cancelRetry = useCallback(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    if (countdown.current) clearInterval(countdown.current);
    retryTimer.current = null;
    countdown.current = null;
    setRetryIn(null);
  }, []);

  const scheduleRetry = useCallback(() => {
    cancelRetry();
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt.current);
    attempt.current += 1;
    const at = Date.now() + delay;
    setRetryIn(Math.ceil(delay / 1000));
    countdown.current = setInterval(() => setRetryIn(Math.max(0, Math.ceil((at - Date.now()) / 1000))), 1000);
    retryTimer.current = setTimeout(() => {
      cancelRetry();
      setReconnectKey((k) => k + 1);
    }, delay);
  }, [cancelRetry]);

  const retry = useCallback(() => {
    cancelRetry();
    setReconnectKey((k) => k + 1);
  }, [cancelRetry]);

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

    // 대상이 바뀐 것과 같은 대상에 다시 붙는 것은 다르다. 재연결이면 화면을 지키고,
    // 서버 세션이 새것이면 아래 세대 검사가 비운다.
    if (lastUrl.current !== url) {
      lastUrl.current = url;
      attempt.current = 0;
      setBuffered(EMPTY);
      setDroppedCount(0);
      setRolloverDate(null);
      parked.current = EMPTY;
      generation.current = null;
      newestSeq.current = -1;
      setPendingCount(0);
    }
    setError(null);
    setTerminal(false);
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
      attempt.current = 0;
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
        const e = JSON.parse(data) as { code?: string; message: string; recoverable: boolean };
        setError(e.message);
        if (!e.recoverable) {
          setStatus('error');
          es.close();
          if (e.code && TERMINAL_CODES.has(e.code)) setTerminal(true);
          else scheduleRetry();
        }
        return;
      }
      // 전송 계층 오류. 네트워크가 끊긴 것이면 EventSource 가 스스로 다시 붙는다.
      // 서버가 200 이 아닌 것(401·404·5xx)을 줬으면 CLOSED 로 끝나는데, 그건 우리가 다시 붙여야 한다.
      if (es.readyState === EventSource.CLOSED) {
        setStatus('error');
        scheduleRetry();
      } else {
        setStatus('connecting');
      }
    });

    return () => {
      es.close();
      cancelRetry();
      setStatus('closed');
    };
  }, [url, reconnectKey, scheduleRetry, cancelRetry]);

  return {
    entries: buffered.entries,
    status,
    error,
    droppedCount,
    rolloverDate,
    paused,
    pendingCount,
    retryIn,
    terminal,
    setPaused,
    clear,
    retry,
  };
}
