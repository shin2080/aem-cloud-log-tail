/**
 * 화면에 그대로 뜨는 서버 오류 메시지.
 *
 * 클라이언트가 요청마다 `X-Lang` 을 실어 보낸다. 헤더가 없으면 한국어다 —
 * curl 로 두드릴 때와 지금까지의 동작이 같다.
 *
 * 로그·감사기록은 여기를 쓰지 않는다. 그쪽은 서버를 돌리는 사람이 보는
 * 것이라 언어를 섞을 이유가 없다.
 */
export type Lang = 'ko' | 'en';

export const ko = {
  /* 공통 */
  internal_error: '서버 오류',
  bad_request: '잘못된 요청',
  not_found: '찾을 수 없다',
  unauthenticated: '로그인이 필요하다',
  session_expired: '세션이 만료됐다. 다시 로그인한다',
  password_change_required: '비밀번호를 먼저 변경해야 한다',

  /* 로그인·비밀번호 */
  login_params: '이메일과 비밀번호가 필요하다',
  too_many_attempts: '로그인 시도가 너무 많다. {mins}분 후 다시 시도한다',
  invalid_credentials: '이메일 또는 비밀번호가 올바르지 않다',
  password_params: '현재 비밀번호와 새 비밀번호가 필요하다',
  current_password_wrong: '현재 비밀번호가 올바르지 않다',
  password_reuse: '이전과 다른 비밀번호를 쓴다',
  password_too_short: '비밀번호는 {min}자 이상이어야 한다',

  /* tail·조회 */
  tail_params: 'org, env, service, name 이 필요하다',
  search_params: '조회 조건이 올바르지 않다',
  unsupported_log: "'{name}' 로그는 아직 파서가 없다. v1 은 aemerror 만 지원한다",
  invalid_range: '끝 시각이 시작 시각보다 앞이다',
  invalid_regex: '정규식이 올바르지 않다',
  access_revoked: '이 로그를 볼 권한이 없어졌다. 다시 로그인해 확인한다',
  scan_range: '조회 구간이 올바르지 않다',
  out_of_retention: 'Cloud Manager 는 7일치만 보관한다. 구간이 전부 그 밖이다',
  no_logs: '구간에 해당하는 로그 파일이 없다 (확인한 날짜: {dates})',

  /* 내보내기 */
  export_params: '내보내기 조건이 올바르지 않다',
  job_id_required: 'jobId 가 필요하다',
  session_id_required: 'sessionId 가 필요하다',
  session_id_format: 'sessionId 형식이 올바르지 않다',
  tail_session_gone: '그 tail 세션이 없다. 화면을 다시 열고 시도한다',
  empty_export: '내보낼 줄이 없다. 범위나 필터를 확인한다',
  export_too_large: '내보낼 양이 {size} ({lines}줄) 로 상한 {max} 을 넘는다. 구간을 좁히거나 레벨을 줄인다',

  /* 저장된 필터 */
  filter_params: '이름과 조건이 필요하다',
  too_many_filters: '저장된 필터는 {max}개까지다. 쓰지 않는 것을 지운다',

  /* 환경 */
  org_key_required: '조직 키가 필요하다',
  org_env_required: '조직 키와 환경 ID 가 필요하다',
  org_credentials_failed: '이 조직의 Adobe 자격증명으로 토큰을 받지 못했다',
  rate_limited: 'Cloud Manager 레이트 리밋에 걸렸다. 잠시 후 다시 시도한다',
  access_denied:
    'Adobe 가 접근을 거부했다 (403). 이 자격증명에 해당 환경 권한이 없거나, ' +
    '캐시된 환경 목록이 지금 자격증명과 다른 조직 것이다. 환경 목록을 새로고침한다',
  cloud_manager_failed: 'Cloud Manager 호출이 실패했다 ({status})',
  upstream_failed: '환경 목록을 가져오지 못했다',

  /* 계정 관리 */
  admin_user_params: '이메일과 역할이 필요하다',
  admin_patch_params: '바꿀 값이 올바르지 않다',
  audit_params: '조회 조건이 올바르지 않다',
  unknown_org: '.env 에 없는 조직이다: {orgs}',
  email_taken: '이미 있는 이메일이다',
  self_deactivate: '자기 계정은 비활성화할 수 없다',
  self_demote: '자기 계정의 관리자 권한은 뺄 수 없다',
  self_delete: '자기 계정은 지울 수 없다',
  last_admin: '마지막 관리자다. 다른 관리자를 먼저 만든다',
} as const;

export type MsgKey = keyof typeof ko;

export const en: Record<MsgKey, string> = {
  internal_error: 'Server error',
  bad_request: 'Bad request',
  not_found: 'Not found',
  unauthenticated: 'Sign-in required',
  session_expired: 'Your session expired. Sign in again.',
  password_change_required: 'Change your password first',

  login_params: 'Email and password are required',
  too_many_attempts: 'Too many sign-in attempts. Try again in {mins} minutes.',
  invalid_credentials: 'Wrong email or password',
  password_params: 'The current and new passwords are required',
  current_password_wrong: 'That is not your current password',
  password_reuse: 'Use a password different from the last one',
  password_too_short: 'The password must be at least {min} characters',

  tail_params: 'org, env, service, and name are required',
  search_params: 'The search conditions are not valid',
  unsupported_log: "There is no parser for the '{name}' log yet. v1 supports aemerror only.",
  invalid_range: 'The end is before the start',
  invalid_regex: 'That is not a valid regular expression',
  access_revoked: 'Access to this log was revoked. Sign in again to check.',
  scan_range: 'The search range is not valid',
  out_of_retention: 'Cloud Manager keeps only seven days. The whole range is outside it.',
  no_logs: 'No log file covers this range (dates checked: {dates})',

  export_params: 'The export conditions are not valid',
  job_id_required: 'jobId is required',
  session_id_required: 'sessionId is required',
  session_id_format: 'sessionId is malformed',
  tail_session_gone: 'That tail session is gone. Reopen the pane and try again.',
  empty_export: 'Nothing to export. Check the range and the filter.',
  export_too_large:
    'The export would be {size} ({lines} lines), over the {max} limit. Narrow the range or drop some levels.',

  filter_params: 'A name and conditions are required',
  too_many_filters: '{max} saved filters is the limit. Delete one you do not use.',

  org_key_required: 'An org key is required',
  org_env_required: 'An org key and an environment ID are required',
  org_credentials_failed: "Could not get a token with this org's Adobe credentials",
  rate_limited: 'Hit the Cloud Manager rate limit. Try again shortly.',
  access_denied:
    'Adobe denied access (403). Either these credentials lack rights to that environment, or ' +
    'the cached environment list belongs to a different org than the current credentials. Refresh the environment list.',
  cloud_manager_failed: 'The Cloud Manager call failed ({status})',
  upstream_failed: 'Could not load the environment list',

  admin_user_params: 'An email and a role are required',
  admin_patch_params: 'The values to change are not valid',
  audit_params: 'The query conditions are not valid',
  unknown_org: 'Not an org in .env: {orgs}',
  email_taken: 'That email already exists',
  self_deactivate: 'You cannot disable your own account',
  self_demote: 'You cannot remove admin from your own account',
  self_delete: 'You cannot delete your own account',
  last_admin: 'This is the last admin. Create another admin first.',
};

const CATALOGS: Record<Lang, Record<MsgKey, string>> = { ko, en };

export type MsgParams = Record<string, string | number>;

/** 헤더에서 언어를 고른다. 아는 값이 아니면 한국어. */
export function langFrom(header: string | string[] | undefined): Lang {
  const v = Array.isArray(header) ? header[0] : header;
  return v === 'en' ? 'en' : 'ko';
}

export function msg(lang: Lang, key: MsgKey, params?: MsgParams): string {
  const template = CATALOGS[lang][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    return v === undefined ? whole : String(v);
  });
}
