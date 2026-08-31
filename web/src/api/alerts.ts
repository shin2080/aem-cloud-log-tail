import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogLevel } from '@shared/types';

export interface AlertRule {
  id: string;
  name: string;
  orgKey: string;
  environmentId: string;
  service: string;
  logName: string;
  pattern: string;
  isRegex: boolean;
  levels: string[];
  cooldownSec: number;
  enabled: boolean;
  /** 스스로 꺼진 이유. 사람이 끈 것과 구분해 보여준다 */
  disabledReason: string | null;
  createdAt: number;
}

export interface AlertHit {
  id: string;
  ruleId: string;
  ruleName: string;
  orgKey: string;
  environmentId: string;
  service: string;
  logName: string;
  level: LogLevel;
  count: number;
  firstTs: number;
  lastTs: number;
  lastSeq: number;
  read: boolean;
  createdAt: number;
}

export interface CreateRuleInput {
  name: string;
  org: string;
  env: string;
  service: string;
  logName: string;
  pattern: string;
  isRegex: boolean;
  levels: LogLevel[];
  cooldownSec: number;
}

/**
 * 알림함으로 데려갈 창의 주소.
 * 히트는 seq 만 들고 있다 — 본문은 서버 메모리에만 있으므로 그 자리를 가리킬 뿐이다.
 */
export function paneUrlFor(h: AlertHit): string {
  return `/tail?p=${encodeURIComponent(`${h.orgKey}:${h.environmentId}:${h.service}:${h.logName}`)}`;
}

/**
 * 새 알림을 실시간으로 받는다.
 *
 * 모니터에 띄워두는 화면이 전제라 이걸로 충분하다 — 화면은 늘 열려 있다.
 * 닫혀 있을 때도 받으려면 웹푸시가 필요하고, 그건 페이로드가 제3자 푸시 서비스를
 * 지나가므로 로그 본문이 아니라 메타데이터만 실어야 한다. 지금은 거기까지 가지 않는다.
 */
export function useAlertStream(enabled: boolean): {
  unread: number;
  latest: AlertHit | null;
  setUnread: (n: number) => void;
  bump: () => void;
} {
  const [unread, setUnread] = useState(0);
  const [latest, setLatest] = useState<AlertHit | null>(null);
  /** 목록을 다시 불러오게 하는 신호 */
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const es = new EventSource('/api/alerts/stream');
    esRef.current = es;

    es.addEventListener('ready', (ev) => {
      const d = (ev as MessageEvent<string>).data;
      if (d) setUnread((JSON.parse(d) as { unread: number }).unread);
    });

    es.addEventListener('hit', (ev) => {
      const hit = JSON.parse((ev as MessageEvent<string>).data) as AlertHit;
      setLatest({ ...hit, read: false, firstTs: hit.lastTs, createdAt: Date.now() });
      setUnread((n) => n + 1);
    });

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [enabled]);

  return { unread, latest, setUnread, bump };
}
