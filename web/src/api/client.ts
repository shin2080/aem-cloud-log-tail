import type { Me, ApiError, EnvironmentSummary, AvailableService, SearchRequest, ExportRequest } from '@shared/types';
import type { AdminUser } from '../pages/AdminUsersPage';
import type { AuditRow } from '../pages/AdminAuditPage';
import type { AlertHit, AlertRule, CreateRuleInput } from './alerts';
import { currentLang, tStatic } from '../i18n';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const lang = currentLang();

  /*
    서버에 닿지도 못한 경우와 서버가 거절한 경우는 다른 일이다.

    fetch 가 그냥 던지게 두면 화면마다 자기 말로 받아서, 로그인 화면은
    "로그인에 실패했다" 를 띄운다 — 비밀번호가 틀린 것과 구분이 안 된다.
    서비스워커가 앱 껍데기를 캐시에서 내주기 때문에 서버가 죽어도 화면은 멀쩡히
    떠서, 사람은 비밀번호부터 의심하게 된다. 실제로 그렇게 헤맸다.
  */
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'same-origin', // 세션 쿠키
      /*
        본문이 없으면 Content-Type 도 붙이지 않는다.

        `application/json` 이라고 해놓고 본문을 비워 보내면 Fastify 가 본문 파서에서
        400(FST_ERR_CTP_EMPTY_JSON_BODY) 으로 끊는다. 이건 인증 훅보다 **앞**이라
        세션이 멀쩡해도 끊기고, 라우트 안으로는 들어가지도 못한다.

        본문 없는 호출이 적지 않다 — 로그아웃, 조회 취소, 비밀번호 초기화,
        세션 회수, 계정·알림규칙·저장필터 삭제. 전부 여기에 걸려 있었다.
        로그아웃이 '눌러도 아무 일도 안 일어나는' 증상으로 먼저 드러났다.

        오류 메시지는 서버가 만드니, 어느 말로 받을지는 X-Lang 으로 알려준다.
      */
      headers: {
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        'X-Lang': lang,
        ...(init.headers ?? {}),
      },
    });
  } catch {
    // status 0 = 응답 자체가 없었다. 서버가 안 떠 있거나 네트워크가 끊겼다.
    throw new ApiRequestError(0, 'unreachable', tStatic('err.unreachable'));
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    // 몸통이 없는 경우 — 서버가 죽었거나 프록시가 가로챘다. 여기서 말을 만든다.
    const fallback = tStatic('err.requestFailed', { status: res.status });
    throw new ApiRequestError(res.status, body?.error.code ?? 'unknown', body?.error.message ?? fallback);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<Me>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),

  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  me: () => request<Me>('/api/auth/me'),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<Me>('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),

  orgs: () =>
    request<{
      orgs: { key: string; label: string }[];
      /** .env 에는 있는데 이 계정에 권한이 없는 조직 */
      notGranted: { key: string; label: string }[];
      /** DB 에 권한만 남고 .env 에서 사라진 조직 */
      stale: string[];
      isAdmin: boolean;
    }>('/api/orgs'),

  environments: (orgKey: string, refresh = false) =>
    request<{ environments: EnvironmentSummary[]; stale: boolean }>(
      `/api/orgs/${encodeURIComponent(orgKey)}/environments${refresh ? '?refresh=true' : ''}`,
    ),

  logOptions: (orgKey: string, envId: string, refresh = false) =>
    request<{ services: AvailableService[]; supported: string[] }>(
      `/api/orgs/${encodeURIComponent(orgKey)}/environments/${encodeURIComponent(envId)}/log-options${
        refresh ? '?refresh=true' : ''
      }`,
    ),

  startSearch: (req: SearchRequest) =>
    request<{ jobId: string }>('/api/search', { method: 'POST', body: JSON.stringify(req) }),

  cancelSearch: (jobId: string) =>
    request<{ cancelled: boolean }>(`/api/search/${encodeURIComponent(jobId)}`, { method: 'DELETE' }),

  prepareExport: (req: ExportRequest) =>
    request<{ exportId: string; estimatedBytes: number; lines: number; filename: string }>('/api/export', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  /* ── 관리자 ─────────────────────────────────────────── */

  adminOrgs: () => request<{ orgs: { key: string; label: string }[] }>('/api/admin/orgs'),

  adminUsers: () => request<{ users: AdminUser[] }>('/api/admin/users'),

  adminCreateUser: (input: {
    email: string;
    displayName: string;
    role: 'admin' | 'member';
    orgs: { key: string; allowProd: boolean }[];
  }) =>
    request<{ user: AdminUser; tempPassword: string }>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  adminUpdateUser: (id: string, patch: Record<string, unknown>) =>
    request<{ user: AdminUser }>(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  adminResetPassword: (id: string) =>
    request<{ tempPassword: string }>(`/api/admin/users/${encodeURIComponent(id)}/reset-password`, { method: 'POST' }),

  adminRevokeSessions: (id: string) =>
    request<{ revoked: number }>(`/api/admin/users/${encodeURIComponent(id)}/revoke-sessions`, { method: 'POST' }),

  adminDeleteUser: (id: string) =>
    request<{ ok: true }>(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  adminAudit: (q: {
    from?: number;
    to?: number;
    action?: string;
    orgKey?: string;
    q?: string;
    limit: number;
    offset: number;
  }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
    return request<{ rows: AuditRow[]; total: number; actions: string[] }>(`/api/admin/audit?${p.toString()}`);
  },

  /* ── 알림 ───────────────────────────────────────────── */

  alertRules: () =>
    request<{ rules: AlertRule[]; maxTargets: number; watchedTargets: string[] }>('/api/alerts/rules'),

  createAlertRule: (input: CreateRuleInput) =>
    request<{ rule: AlertRule }>('/api/alerts/rules', { method: 'POST', body: JSON.stringify(input) }),

  setAlertRuleEnabled: (id: string, enabled: boolean) =>
    request<{ rule: AlertRule }>(`/api/alerts/rules/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),

  deleteAlertRule: (id: string) =>
    request<{ ok: true }>(`/api/alerts/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  alertHits: (limit = 50) => request<{ hits: AlertHit[]; unread: number }>(`/api/alerts/hits?limit=${limit}`),

  markAlertsRead: (ids?: string[]) =>
    request<{ unread: number }>('/api/alerts/hits/read', {
      method: 'POST',
      body: JSON.stringify(ids ? { ids } : {}),
    }),

  /* ── 버전 ───────────────────────────────────────────── */

  version: () =>
    request<{
      version: string;
      checkEnabled: boolean;
      /** 관리자에게만, 실행 중인 것보다 새 릴리스가 있을 때 */
      update: { tag: string; version: string; url: string; publishedAt: string | null } | null;
      checkedAt: number | null;
    }>('/api/version'),

  /* ── 저장된 필터 ────────────────────────────────────── */

  filters: () =>
    request<{ filters: { id: string; name: string; payload: unknown; createdAt: number }[] }>('/api/filters'),

  saveFilter: (name: string, payload: Record<string, unknown>) =>
    request<{ id: string; name: string; replaced: boolean }>('/api/filters', {
      method: 'POST',
      body: JSON.stringify({ name, payload }),
    }),

  deleteFilter: (id: string) =>
    request<{ ok: true }>(`/api/filters/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
