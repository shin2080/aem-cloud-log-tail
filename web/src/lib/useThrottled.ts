import { useEffect, useRef, useState } from 'react';

/**
 * 값을 최대 `ms` 간격으로만 흘려보낸다.
 *
 * 무거운 집계(묶기·히스토그램)를 SSE 배치마다 다시 하면 안 된다.
 * 5만 엔트리 기준 묶기 한 번이 40ms 남짓인데, 배치가 100ms 디바운스라
 * 초당 10회면 메인 스레드의 절반을 먹는다. 창을 여러 개 열면 그대로 멈춘다.
 *
 * 집계는 눈으로 보는 요약이라 반 초쯤 늦어도 티가 안 난다 —
 * 애초에 로그 자체가 2분 밀려 있다.
 */
export function useThrottled<T>(value: T, ms: number, enabled = true): T {
  const [throttled, setThrottled] = useState(value);
  const lastRun = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) {
      setThrottled(value);
      return;
    }

    const since = Date.now() - lastRun.current;
    if (since >= ms) {
      lastRun.current = Date.now();
      setThrottled(value);
      return;
    }

    // 아직 이르다. 남은 시간 뒤에 마지막 값으로 한 번만 갱신한다.
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      lastRun.current = Date.now();
      setThrottled(value);
    }, ms - since);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, ms, enabled]);

  return enabled ? throttled : value;
}
