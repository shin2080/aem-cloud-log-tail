import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Me } from '@shared/types';
import { api, ApiRequestError } from './client';

interface SessionState {
  me: Me | null;
  loading: boolean;
  setMe: (me: Me | null) => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      setMe(await api.me());
    } catch (err) {
      // 401 은 '아직 로그인 안 함'이라는 정상 상태다.
      if (!(err instanceof ApiRequestError && err.status === 401)) console.error(err);
      setMe(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return <Ctx.Provider value={{ me, loading, setMe, refresh }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error('SessionProvider 밖에서 useSession 을 썼다');
  return v;
}
