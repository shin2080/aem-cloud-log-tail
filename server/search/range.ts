/**
 * 조회 구간 → 읽어야 할 UTC 날짜 파일 목록.
 *
 * 로그 파일은 UTC 날짜로 쪼개져 있는데 사용자는 KST 로 생각한다.
 * KST 오전 0~9시 구간은 **UTC 전날 파일**에 들어 있다. 여기가 이 기능에서
 * 가장 조용히 틀리는 지점이라 별도 모듈로 빼고 테스트를 붙였다.
 */

/** epoch ms -> UTC 기준 YYYY-MM-DD */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;

/**
 * [fromMs, toMs] 이 걸치는 UTC 날짜를 오름차순으로 준다. 경계 포함.
 * 입력은 epoch ms 이므로 사용자가 어느 타임존으로 골랐든 상관없다 —
 * 프론트에서 이미 epoch 으로 바꿔 보낸다.
 */
export function utcDatesInRange(fromMs: number, toMs: number): string[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return [];

  const dates: string[] = [];
  // 자정으로 내림한 뒤 하루씩 더한다. DST 가 없는 UTC 라 단순 산술로 충분하다.
  const start = Date.UTC(
    new Date(fromMs).getUTCFullYear(),
    new Date(fromMs).getUTCMonth(),
    new Date(fromMs).getUTCDate(),
  );
  for (let t = start; t <= toMs; t += DAY_MS) dates.push(utcDate(t));
  return dates;
}

/** Cloud Manager 는 7일치만 보관한다. 그보다 오래된 날짜는 애초에 요청하지 않는다. */
export const RETENTION_DAYS = 7;

export function isWithinRetention(dateUtc: string, now = Date.now()): boolean {
  const oldest = utcDate(now - (RETENTION_DAYS - 1) * DAY_MS);
  return dateUtc >= oldest && dateUtc <= utcDate(now);
}

export function splitRetained(dates: string[], now = Date.now()): { retained: string[]; expired: string[] } {
  const retained: string[] = [];
  const expired: string[] = [];
  for (const d of dates) (isWithinRetention(d, now) ? retained : expired).push(d);
  return { retained, expired };
}
