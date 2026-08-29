import type { OrgConfig } from '../config/env.js';
import type { EnvironmentType } from '../../shared/types.js';
import { ImsTokenCache } from './ims.js';

const BASE = 'https://cloudmanager.adobe.io';
const BASE_HOST = 'cloudmanager.adobe.io';

export class CloudManagerError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'CloudManagerError';
  }
}

export interface Program {
  id: string;
  name: string;
}

export interface Environment {
  id: string;
  name: string;
  type: EnvironmentType;
  programId: string;
}

/**
 * logs?days=N 응답의 한 항목. 스키마는 Phase 0 에서 확인했다 (docs/findings.md).
 * days=1 이어도 오늘과 어제 두 날짜가 함께 온다.
 */
export interface LogOption {
  service: string;
  name: string;
  date?: string;
  programId?: string;
  environmentId?: string;
  /** rel: .../logs/download — 302 로 하루치 .gz 파일의 서명 URL 을 준다 */
  downloadHref?: string;
  /** rel: .../logs/tail — Phase 0b 에서 조사 중. 평문 스트림이면 tail 전략이 여기로 간다 */
  tailHref?: string;
}

const REL_DOWNLOAD = 'http://ns.adobe.com/adobecloud/rel/logs/download';
const REL_TAIL = 'http://ns.adobe.com/adobecloud/rel/logs/tail';

export interface SignedDownload {
  url: string;
  /** 서명 URL 에 박힌 만료 시각 (epoch ms). 파싱에 실패하면 undefined */
  expiresAt?: number;
}

/**
 * Cloud Manager 읽기 전용 클라이언트.
 * 쓰기 작업(파이프라인 실행, 환경 변경)은 이 파일에 절대 추가하지 않는다.
 */
export class CloudManagerClient {
  constructor(
    private readonly ims: ImsTokenCache,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async headers(org: OrgConfig): Promise<Record<string, string>> {
    const token = await this.ims.getToken(org);
    return {
      Authorization: `Bearer ${token}`,
      'x-gw-ims-org-id': org.imsOrgId,
      'x-api-key': org.clientId,
      Accept: 'application/json',
    };
  }

  /** 401 을 만나면 토큰을 한 번 버리고 재시도한다. 429 는 Retry-After 를 담아 던진다. */
  private async request(org: OrgConfig, path: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const res = await this.fetchImpl(`${BASE}${path}`, {
      ...init,
      headers: { ...(await this.headers(org)), ...(init.headers as Record<string, string> | undefined) },
      redirect: 'manual', // 302 Location 을 직접 읽어야 한다
    });

    if (res.status === 401 && !retried) {
      this.ims.invalidate(org.key);
      return this.request(org, path, init, true);
    }
    if (res.status === 429) {
      const ra = res.headers.get('retry-after');
      const ms = ra ? (/^\d+$/.test(ra) ? Number(ra) * 1000 : Math.max(0, Date.parse(ra) - Date.now())) : undefined;
      throw new CloudManagerError(429, `Cloud Manager 레이트 리밋 (${path})`, ms);
    }
    return res;
  }

  private async json<T>(org: OrgConfig, path: string): Promise<T> {
    const res = await this.request(org, path);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new CloudManagerError(res.status, `${path} → ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  async listPrograms(org: OrgConfig): Promise<Program[]> {
    const body = await this.json<HalCollection<RawProgram>>(org, '/api/programs');
    return embedded<RawProgram>(body, 'programs').map((p) => ({ id: String(p.id), name: p.name ?? String(p.id) }));
  }

  async listEnvironments(org: OrgConfig, programId: string): Promise<Environment[]> {
    const body = await this.json<HalCollection<RawEnvironment>>(org, `/api/program/${programId}/environments`);
    return embedded<RawEnvironment>(body, 'environments').map((e) => ({
      id: String(e.id),
      name: e.name ?? String(e.id),
      type: normalizeEnvType(e.type),
      programId,
    }));
  }

  /** 가용 로그 옵션. 응답 스키마 실물은 Phase 0 에서 확인해 이 매핑을 확정한다. */
  async listLogOptions(org: OrgConfig, programId: string, environmentId: string, days = 1): Promise<LogOption[]> {
    const body = await this.json<RawLogsResponse>(
      org,
      `/api/program/${programId}/environment/${environmentId}/logs?days=${days}`,
    );
    const items = embedded<RawLog>(body, 'downloads');
    return items.map((l) => ({
      service: l.service ?? '',
      name: l.name ?? '',
      date: l.date,
      programId: l.programId === undefined ? undefined : String(l.programId),
      environmentId: l.environmentId === undefined ? undefined : String(l.environmentId),
      downloadHref: l._links?.[REL_DOWNLOAD]?.href,
      tailHref: l._links?.[REL_TAIL]?.href,
    }));
  }

  /**
   * HAL 링크(download / tail)를 서명된 스토리지 URL 로 바꾼다.
   *
   * 두 링크의 형태가 다르다 (Phase 0b 에서 확인).
   *   download → Cloud Manager 경로. 호출하면 302 로 서명 URL 을 준다
   *   tail     → 이미 서명된 스토리지 URL 그 자체. 그대로 쓴다
   *
   * 후자에 Authorization 헤더를 실어 Cloud Manager 로 보내면 404 가 난다.
   */
  async resolveSignedUrl(org: OrgConfig, href: string): Promise<SignedDownload> {
    if (/^https?:\/\//i.test(href)) {
      const u = new URL(href);
      if (u.host.toLowerCase() !== BASE_HOST) {
        // 스토리지로 직접 가는 서명 URL. Cloud Manager 를 거치지 않는다.
        return { url: href, expiresAt: signedUrlExpiry(href) };
      }
    }
    const path = href.startsWith('http') ? new URL(href).pathname + new URL(href).search : href;
    const res = await this.request(org, path);

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new CloudManagerError(res.status, '리다이렉트 응답에 Location 헤더가 없다');
      return { url: loc, expiresAt: signedUrlExpiry(loc) };
    }
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { redirect?: string } | null;
      if (body?.redirect) return { url: body.redirect, expiresAt: signedUrlExpiry(body.redirect) };
    }
    const text = await res.text().catch(() => '');
    throw new CloudManagerError(res.status, `서명 URL 획득 실패 (${res.status}): ${text.slice(0, 300)}`);
  }

  /**
   * 로그 다운로드 엔드포인트는 302 로 서명된 스토리지 URL을 반환한다.
   * 자동 리다이렉트를 끄고 Location 헤더를 직접 읽는다 —
   * 따라가버리면 스토리지로 나가는 Range 요청에 Authorization 헤더가 실려 서명이 깨진다.
   */
  async getSignedLogUrl(
    org: OrgConfig,
    programId: string,
    environmentId: string,
    service: string,
    name: string,
    date: string,
  ): Promise<SignedDownload> {
    const path =
      `/api/program/${programId}/environment/${environmentId}/logs/download` +
      `?service=${encodeURIComponent(service)}&name=${encodeURIComponent(name)}&date=${encodeURIComponent(date)}`;

    const res = await this.request(org, path);

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new CloudManagerError(res.status, '리다이렉트 응답에 Location 헤더가 없다');
      return { url: loc, expiresAt: signedUrlExpiry(loc) };
    }

    // 일부 배포는 302 대신 { redirect: "..." } 본문을 준다. Phase 0 에서 어느 쪽인지 확정한다.
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { redirect?: string } | null;
      if (body?.redirect) return { url: body.redirect, expiresAt: signedUrlExpiry(body.redirect) };
    }

    const text = await res.text().catch(() => '');
    throw new CloudManagerError(res.status, `로그 다운로드 URL 획득 실패 (${res.status}): ${text.slice(0, 300)}`);
  }
}

/** Azure SAS(se=) / AWS SigV4(X-Amz-Date + X-Amz-Expires) 양쪽의 만료 시각을 읽는다. */
export function signedUrlExpiry(url: string): number | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }

  const se = u.searchParams.get('se');
  if (se) {
    const t = Date.parse(se);
    if (!Number.isNaN(t)) return t;
  }

  const amzDate = u.searchParams.get('X-Amz-Date');
  const amzExpires = u.searchParams.get('X-Amz-Expires');
  if (amzDate && amzExpires) {
    // 20260828T150211Z → ISO
    const iso = amzDate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z');
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) return t + Number(amzExpires) * 1000;
  }
  return undefined;
}

export function normalizeEnvType(raw: string | undefined): EnvironmentType {
  const v = (raw ?? '').toLowerCase();
  if (v === 'prod' || v === 'production') return 'prod';
  if (v === 'stage' || v === 'staging') return 'stage';
  if (v === 'rde') return 'rde';
  return 'dev';
}

/* ── HAL 응답 헬퍼 ─────────────────────────────────────── */

interface HalCollection<T> {
  _embedded?: Record<string, T[]>;
}
interface RawProgram {
  id: string | number;
  name?: string;
}
interface RawEnvironment {
  id: string | number;
  name?: string;
  type?: string;
}
interface RawLog {
  service?: string;
  name?: string;
  date?: string;
  programId?: string | number;
  environmentId?: string | number;
  _links?: Record<string, { href?: string }>;
}
type RawLogsResponse = HalCollection<RawLog>;

function embedded<T>(body: HalCollection<T>, key: string): T[] {
  const bucket = body._embedded?.[key];
  return Array.isArray(bucket) ? bucket : [];
}
