import type { OrgConfig } from '../config/env.js';

const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';

/** expires_in 의 이 비율 지점에서 선제 갱신한다. */
const REFRESH_AT = 0.9;

interface CachedToken {
  accessToken: string;
  /** epoch ms. 이 시점을 넘으면 갱신한다 */
  refreshAt: number;
  expiresAt: number;
}

export class ImsError extends Error {
  constructor(
    readonly orgKey: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ImsError';
  }
}

/**
 * 조직별 IMS 액세스 토큰 캐시.
 *
 * 토큰 값은 어떤 로그에도 찍지 않는다. 디버그 출력에서도.
 * 갱신 실패는 조직 단위로 격리된다 — A사 자격증명이 만료돼도 B사는 계속 동작한다.
 */
export class ImsTokenCache {
  private readonly tokens = new Map<string, CachedToken>();
  /** 같은 조직에 동시 갱신 요청이 몰려도 한 번만 나가게 한다 */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getToken(org: OrgConfig): Promise<string> {
    const cached = this.tokens.get(org.key);
    if (cached && this.now() < cached.refreshAt) return cached.accessToken;

    const existing = this.inflight.get(org.key);
    if (existing) return existing;

    const p = this.fetchToken(org).finally(() => this.inflight.delete(org.key));
    this.inflight.set(org.key, p);
    return p;
  }

  /** 401 을 받았을 때 캐시를 버리고 다시 받게 한다. */
  invalidate(orgKey: string): void {
    this.tokens.delete(orgKey);
  }

  private async fetchToken(org: OrgConfig): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: org.clientId,
      client_secret: org.clientSecret,
      scope: org.scopes,
    });

    const res = await this.fetchImpl(IMS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      // 응답 본문에 토큰이 없더라도 자격증명 관련 값을 흘리지 않도록 상태만 담는다.
      const detail = await res.text().catch(() => '');
      const safe = detail.slice(0, 300).replace(org.clientSecret, '***');
      throw new ImsError(org.key, res.status, `IMS 토큰 발급 실패 (${res.status}): ${safe}`);
    }

    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token || typeof json.expires_in !== 'number') {
      throw new ImsError(org.key, res.status, 'IMS 응답에 access_token/expires_in 이 없다');
    }

    const now = this.now();
    const ttlMs = json.expires_in * 1000;
    this.tokens.set(org.key, {
      accessToken: json.access_token,
      refreshAt: now + ttlMs * REFRESH_AT,
      expiresAt: now + ttlMs,
    });
    return json.access_token;
  }
}
