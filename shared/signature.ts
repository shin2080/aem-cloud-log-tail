import type { LogEntry } from './types.js';

/**
 * '같은 사건' 을 가르는 지문.
 *
 * 화면의 묶어보기와 알림의 소음 제어가 같은 기준을 써야 한다 —
 * 화면에서 한 덩어리로 보이던 것이 알림에서는 수천 건으로 쪼개지면
 * 둘 중 하나는 거짓말을 하는 것이다. 그래서 shared 로 옮겨왔다.
 */

/**
 * 반복되는 숫자를 지워 같은 사건을 한 덩이로 본다.
 *
 * '느린 쿼리 205ms' 와 '느린 쿼리 210ms' 는 같은 문제고, epoch ms 나 요청 id 가
 * 섞인 줄도 마찬가지다. 숫자를 통째로 지우면 '오류 500건' 과 '오류 3건' 이
 * 같아지지만, 묶음을 푸는 게 목적이 아니라 '같은 종류' 를 세는 게 목적이라 이게 낫다.
 */
function normalize(s: string): string {
  return s
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\d+/g, '#')
    .trim();
}

/**
 * 한 엔트리의 '종류'. 이게 같으면 같은 사건으로 본다.
 *
 * 스택트레이스가 있으면 첫 두 줄까지 포함한다 — 같은 메시지라도 다른 곳에서 터진
 * 예외는 다른 문제이기 때문이다.
 */
export function signatureOf(e: LogEntry): string {
  const stack = e.continuation.slice(0, 2).map(normalize).join('|');
  return `${e.level} ${e.logger} ${normalize(e.message)} ${stack}`;
}
