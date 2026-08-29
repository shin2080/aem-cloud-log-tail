/**
 * 로그인 실패 레이트 리밋. 이메일 단위로 5분에 5회.
 * 프로세스 메모리에만 둔다 — 재시작하면 초기화되지만 로컬 도구에서는 충분하다.
 */
const WINDOW_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

/**
 * IP 단위는 넉넉하게 둔다. 한 사람이 계정 여러 개를 쓰거나, 사무실처럼
 * 여러 사람이 같은 주소를 공유할 수 있다. 그래도 무제한 뿌리기는 막힌다.
 */
const IP_PREFIX = 'ip:';
const MAX_ATTEMPTS_IP = 20;

interface Bucket {
  count: number;
  firstAt: number;
}

export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 잠겨 있으면 남은 밀리초, 아니면 null */
  retryAfterMs(email: string): number | null {
    const key = email.toLowerCase();
    const b = this.buckets.get(key);
    if (!b) return null;
    const elapsed = this.now() - b.firstAt;
    if (elapsed >= WINDOW_MS) {
      this.buckets.delete(key);
      return null;
    }
    const limit = key.startsWith(IP_PREFIX) ? MAX_ATTEMPTS_IP : MAX_ATTEMPTS;
    return b.count >= limit ? WINDOW_MS - elapsed : null;
  }

  recordFailure(email: string): void {
    const key = email.toLowerCase();
    const b = this.buckets.get(key);
    if (!b || this.now() - b.firstAt >= WINDOW_MS) {
      this.buckets.set(key, { count: 1, firstAt: this.now() });
      return;
    }
    b.count++;
  }

  clear(email: string): void {
    this.buckets.delete(email.toLowerCase());
  }
}
