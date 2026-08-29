/** 서버와 브라우저가 함께 쓰는 타입. 여기에 자격증명 관련 타입을 두지 않는다. */

export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE' | 'UNKNOWN';

export const LOG_LEVELS: readonly LogLevel[] = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE', 'UNKNOWN'];

export type EnvironmentType = 'dev' | 'stage' | 'prod' | 'rde';

/**
 * Phase 0 에서 확인한 실제 service 값 (docs/findings.md).
 * SPEC 7장은 author|publish|preview 로 적었지만 실물은 preview 가 아니라
 * preview_publish 이고, dispatcher 계열이 별도 service 로 나온다.
 */
export type ServiceName = 'author' | 'publish' | 'preview_publish' | 'dispatcher' | 'preview_dispatcher';

export const SERVICE_NAMES: readonly ServiceName[] = [
  'author',
  'publish',
  'preview_publish',
  'dispatcher',
  'preview_dispatcher',
];

/**
 * Phase 0 에서 확인한 실제 로그 이름.
 * v1 은 aemerror 만 파싱한다 (SPEC 비목표). 나머지는 파서를 붙이면 열린다.
 */
export type LogName = 'aemerror' | 'aemaccess' | 'aemrequest' | 'cdn' | 'aemdispatcher' | 'httpdaccess' | 'httpderror';

/** service 별로 실제 제공되는 로그 이름. Phase 0 관측값이며, env_cache 가 최종 근거다. */
/**
 * 자주 쓰는 순서. 화면에서 로그 버튼을 이 순서로 늘어놓는다.
 * 여기 없는 이름은 뒤에 알파벳순으로 붙는다.
 */
export const LOG_NAME_ORDER: readonly string[] = [
  'aemerror',
  'aemrequest',
  'aemaccess',
  'cdn',
  'httpderror',
  'httpdaccess',
  'aemdispatcher',
];

export function compareLogNames(a: string, b: string): number {
  const ia = LOG_NAME_ORDER.indexOf(a);
  const ib = LOG_NAME_ORDER.indexOf(b);
  if (ia === -1 && ib === -1) return a.localeCompare(b);
  if (ia === -1) return 1;
  if (ib === -1) return -1;
  return ia - ib;
}

export const LOG_NAMES_BY_SERVICE: Record<ServiceName, readonly LogName[]> = {
  author: ['aemerror', 'aemaccess', 'aemrequest', 'cdn'],
  publish: ['aemerror', 'aemaccess', 'aemrequest'],
  preview_publish: ['aemerror', 'aemaccess', 'aemrequest'],
  dispatcher: ['aemdispatcher', 'httpdaccess', 'httpderror'],
  preview_dispatcher: ['aemdispatcher', 'httpdaccess', 'httpderror'],
};

export interface LogEntry {
  /** 세션 내 단조 증가. 클라이언트 dedupe·범위 선택 키 */
  seq: number;
  /** epoch ms. 원본은 UTC */
  ts: number;
  level: LogLevel;
  /** cm-p33452-e121351-aem-author-... */
  pod: string;
  thread: string;
  logger: string;
  message: string;
  /** 스택트레이스 등 후속 라인 */
  continuation: string[];
  raw: string;
  /** 마스킹이 한 군데라도 적용됐으면 true */
  masked?: boolean;
}

export interface UserOrgAccess {
  key: string;
  label: string;
  allowProd: boolean;
}

export interface Me {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'member';
  mustChangePassword: boolean;
  orgs: UserOrgAccess[];
  /**
   * 비밀번호 최소 길이. 화면이 안내 문구에 쓴다.
   *
   * 화면에 박아두면 서버 정책을 바꿨을 때 '8자 이상' 이라고 안내해놓고
   * 12자를 요구하는 상태가 된다. 정하는 쪽에서 내려준다.
   */
  minPasswordLength: number;
}

export interface AvailableService {
  service: string;
  logNames: string[];
}

export interface EnvironmentSummary {
  orgKey: string;
  programId: string;
  programName: string;
  environmentId: string;
  environmentName: string;
  environmentType: EnvironmentType;
  availableServices: AvailableService[];
  refreshedAt: number;
}

export interface ApiError {
  error: { code: string; message: string };
}

/* ── SSE 이벤트 페이로드 ────────────────────────────────── */

export interface TailReadyEvent {
  sessionId: string;
  bufferedCount: number;
  oldestSeq: number;
  newestSeq: number;
}

export interface TailEntriesEvent {
  entries: LogEntry[];
}

export interface TailRolloverEvent {
  newDate: string; // YYYY-MM-DD (UTC)
}

export interface TailTruncatedEvent {
  droppedCount: number;
  oldestSeq: number;
}

export interface StreamErrorEvent {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface SearchProgressEvent {
  scannedBytes: number;
  totalBytes: number;
  matched: number;
}

export interface SearchDoneEvent {
  matched: number;
  truncated: boolean;
}

/* ── 요청 페이로드 ──────────────────────────────────────── */

export interface SearchRequest {
  org: string;
  envId: string;
  service: string;
  name: string;
  /** epoch ms */
  from: number;
  /** epoch ms */
  to: number;
  levels: LogLevel[];
  query?: string;
  regex?: boolean;
}

export type ExportFormat = 'log' | 'json' | 'csv';

export interface ExportRequest {
  source: 'tail' | 'search';
  sessionId?: string;
  jobId?: string;
  seqFrom?: number;
  seqTo?: number;
  /** 정확히 이 줄들만. 화면에 보이는 것이 seq 구간과 다를 때 쓴다 */
  seqs?: number[];
  levels?: LogLevel[];
  query?: string;
  format: ExportFormat;
  includeContinuation: boolean;
}
