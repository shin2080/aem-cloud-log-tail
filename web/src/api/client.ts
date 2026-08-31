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
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin', // 세션 쿠키
    // 오류 메시지는 서버가 만든다. 어느 말로 받을지 여기서 알려준다.
    headers: { 'Content-Type': 'application/json', 'X-Lang': lang, ...(init.headers ?? {}) },
  });

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
