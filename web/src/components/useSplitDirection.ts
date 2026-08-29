import { useCallback, useEffect, useState } from 'react';

export type SplitDirection = 'row' | 'column';

const KEY = 'aclv.splitDirection';

/**
 * 이 폭부터는 좌우로 쪼개도 로그 한 줄이 안 접힌다.
 * 실측: 12px 모노스페이스에서 한 창이 760px 아래로 내려가면 메시지가 줄바꿈되기 시작한다.
 */
const WIDE_ENOUGH_PX = 1600;

function stored(): SplitDirection | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'row' || v === 'column' ? v : null;
  } catch {
    return null;
  }
}

/**
 * 분할 방향. 사용자가 고른 적 있으면 그걸 쓰고, 없으면 화면 폭으로 정한다.
 * 와이드 모니터에서는 좌우가 자연스럽고, 좁은 화면에서는 좌우로 쪼개면 글자가 몇 자씩 접힌다.
 */
export function useSplitDirection(): [SplitDirection, (d: SplitDirection) => void, boolean] {
  const [explicit, setExplicit] = useState<SplitDirection | null>(null);
  const [wide, setWide] = useState(() => (typeof window === 'undefined' ? false : window.innerWidth >= WIDE_ENOUGH_PX));

  useEffect(() => {
    setExplicit(stored());
  }, []);

  // 창 크기를 바꾸면 자동 모드에서는 따라간다.
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${WIDE_ENOUGH_PX}px)`);
    const onChange = (e: MediaQueryListEvent): void => setWide(e.matches);
    setWide(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const set = useCallback((d: SplitDirection) => {
    setExplicit(d);
    try {
      localStorage.setItem(KEY, d);
    } catch {
      // 저장 못 해도 이번 세션에는 적용된다
    }
  }, []);

  const auto: SplitDirection = wide ? 'row' : 'column';
  return [explicit ?? auto, set, explicit === null];
}
