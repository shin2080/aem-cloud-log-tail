import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Me } from '@shared/types';
import { api, ApiRequestError } from './client';

interface SessionState {
  me: Me | null;
  loading: boolean;
  /** 로그인해 있다가 끊긴 것인가. 처음 들어온 것과 구분해 안내를 바꾼다 */
  expired: boolean;
  setMe: (me: Me | null) => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);

/**
 * 세션을 살려두는 주기.
 *
 * tail 은 SSE 를 한 번 열고 끝이라 연결만으로는 세션이 갱신되지 않는다.
 * 모니터에 걸어둔 화면은 사람이 아무것도 누르지 않으므로, 이 주기적인 호출이
 * 유일한 '쓰고 있다' 는 신호다. 서버가 이걸 보고 만료를 미룬다.
 *
 * 겸사겸사 로그아웃·권한 회수도 여기서 알아챈다 — 관리자가 세션을 끊었는데
 * 화면만 계속 떠 있으면 사람이 그걸 알 방법이 없다.
 */
const KEEPALIVE_MS = 10 * 60_000;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);
  // 콜백이 낡은 me 를 보지 않게 한다. 인터벌은 한 번만 걸고 싶다.
  const signedIn = useRef(false);
  signedIn.current = me !== null;

  const refresh = useCallback(async () => {
    try {
      setMe(await api.me());
      setExpired(false);
    } catch (err) {
      // 401 은 '아직 로그인 안 함'이라는 정상 상태다.
      if (!(err instanceof ApiRequestError && err.status === 401)) console.error(err);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const tick = (): void => {
      // 로그인 화면에서는 두드리지 않는다. 401 을 세느라 서버 로그만 지저분해진다.
      if (!signedIn.current) return;
      void api.me().catch((err: unknown) => {
        // 만료·회수됐다. 화면을 로그인으로 돌린다 — 조용히 멈춰 있는 것보다 낫다.
        if (err instanceof ApiRequestError && err.status === 401) {
          setExpired(true);
          setMe(null);
        }
        // 그 밖의 오류(서버 재시작, 네트워크)는 다음 주기에 다시 본다.
      });
    };

    const timer = setInterval(tick, KEEPALIVE_MS);
    // 절전에서 깨어나면 그 사이에 만료됐을 수 있다. 인터벌을 기다리지 않고 바로 확인한다.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const signIn = useCallback((next: Me | null) => {
    if (next) setExpired(false);
    setMe(next);
  }, []);

  return <Ctx.Provider value={{ me, loading, expired, setMe: signIn, refresh }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error('SessionProvider 밖에서 useSession 을 썼다');
  return v;
}
