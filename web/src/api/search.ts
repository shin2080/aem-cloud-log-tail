import { useCallback, useRef, useState } from 'react';
import type { LogEntry, SearchRequest } from '@shared/types';
import { api, ApiRequestError } from './client';
import { tStatic } from '../i18n';

export type SearchStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error';

export interface SearchState {
  status: SearchStatus;
  jobId: string | null;
  entries: LogEntry[];
  matched: number;
  scannedBytes: number;
  totalBytes: number;
  truncated: boolean;
  /** 보존 기간이 지나 못 읽은 날짜 */
  skippedDates: string[];
  /** 파일이 없던 날짜 */
  missingDates: string[];
  error: string | null;
}

const INITIAL: SearchState = {
  status: 'idle',
  jobId: null,
  entries: [],
  matched: 0,
  scannedBytes: 0,
  totalBytes: 0,
  truncated: false,
  skippedDates: [],
  missingDates: [],
  error: null,
};

export function useSearch(): SearchState & {
  run: (req: SearchRequest) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
} {
  const [state, setState] = useState<SearchState>(INITIAL);
  const esRef = useRef<EventSource | null>(null);

  const closeStream = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const run = useCallback(
    async (req: SearchRequest) => {
      closeStream();
      setState({ ...INITIAL, status: 'running' });

      let jobId: string;
      try {
        ({ jobId } = await api.startSearch(req));
      } catch (err) {
        setState({
          ...INITIAL,
          status: 'error',
          error: err instanceof ApiRequestError ? err.message : tStatic('search.startFailed'),
        });
        return;
      }

      setState((s) => ({ ...s, jobId }));

      const es = new EventSource(`/api/search/${encodeURIComponent(jobId)}/stream`);
      esRef.current = es;

      es.addEventListener('progress', (ev) => {
        const p = JSON.parse((ev as MessageEvent<string>).data) as {
          scannedBytes: number;
          totalBytes: number;
          matched: number;
        };
        setState((s) => ({ ...s, ...p }));
      });

      es.addEventListener('entries', (ev) => {
        const { entries } = JSON.parse((ev as MessageEvent<string>).data) as { entries: LogEntry[] };
        // 스캔은 시간순으로 훑으므로 그냥 이어붙이면 된다.
        setState((s) => ({ ...s, entries: s.entries.concat(entries) }));
      });

      es.addEventListener('done', (ev) => {
        const d = JSON.parse((ev as MessageEvent<string>).data) as {
          matched: number;
          truncated: boolean;
          skippedDates?: string[];
          missingDates?: string[];
          cancelled?: boolean;
        };
        setState((s) => ({
          ...s,
          status: d.cancelled ? 'cancelled' : 'done',
          matched: d.matched,
          truncated: d.truncated,
          skippedDates: d.skippedDates ?? [],
          missingDates: d.missingDates ?? [],
        }));
        closeStream();
      });

      es.addEventListener('error', (ev) => {
        const data = (ev as MessageEvent<string>).data;
        if (data) {
          const e = JSON.parse(data) as { message: string };
          setState((s) => ({ ...s, status: 'error', error: e.message }));
          closeStream();
          return;
        }
        // 전송 계층 오류. 잡은 서버에서 계속 돌고 있을 수 있다.
        if (es.readyState === EventSource.CLOSED) {
          setState((s) => (s.status === 'running' ? { ...s, status: 'error', error: tStatic('search.streamLost') } : s));
        }
      });
    },
    [closeStream],
  );

  const cancel = useCallback(async () => {
    const id = esRef.current ? state.jobId : null;
    if (!id) return;
    try {
      await api.cancelSearch(id);
    } catch {
      // 이미 끝났을 수 있다
    }
  }, [state.jobId]);

  const reset = useCallback(() => {
    closeStream();
    setState(INITIAL);
  }, [closeStream]);

  return { ...state, run, cancel, reset };
}
