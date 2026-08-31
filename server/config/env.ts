import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { MIN_PASSWORD_LENGTH } from '../auth/password.js';

loadDotenv({ quiet: true });

/**
 * 조직 자격증명. 이 객체는 프로세스 메모리에만 존재한다.
 * DB에 쓰거나 HTTP 응답에 직렬화하는 코드를 절대 만들지 않는다.
 */
export interface OrgConfig {
  key: string;
  label: string;
  imsOrgId: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
}

/** 프론트로 나가도 되는 조직 정보. 이 두 필드 외에는 어떤 것도 추가하지 않는다. */
export interface PublicOrg {
  key: string;
  label: string;
}

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v.toLowerCase() === 'true' || v === '1'));

const int = (def: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(min));

/** 필수 문자열. 없거나 빈 값이면 '무엇이 빠졌는지'를 그대로 말해준다. */
const required = (hint: string) =>
  z
    .string()
    .optional()
    .transform((v) => v?.trim() ?? '')
    .refine((v) => v.length > 0, { message: `값이 비어 있다. ${hint}` });

const serverSchema = z.object({
  PORT: int(7300, 1),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_PATH: z.string().default('./data/app.db'),
  SESSION_SECRET: required('openssl rand -hex 32 로 만든 값을 넣는다').pipe(
    z.string().min(32, '32자 이상이어야 한다 (openssl rand -hex 32)'),
  ),
  /**
   * 유휴 기준 유효기간. 쓰는 동안에는 이 길이만큼 계속 연장된다.
   * 이 값이 곧 '아무도 안 건드렸을 때 로그인이 풀리는 시간' 이다.
   */
  SESSION_TTL_HOURS: int(12, 1),
  /**
   * 연장의 천장. 처음 로그인한 뒤 이만큼 지나면 계속 쓰고 있어도 다시 로그인해야 한다.
   * 모니터에 걸어두는 화면 때문에 무한 연장으로 두면, 상시 로그인된 브라우저가
   * 그대로 상시 유효한 자격증명이 된다.
   */
  SESSION_MAX_HOURS: int(168, 1),
  SESSION_COOKIE_SECURE: bool(false),
  /**
   * 리버스 프록시/터널 뒤에 둘 때만 켠다.
   * 켜면 X-Forwarded-For 를 믿어 감사 기록의 IP 가 실제 접속자 주소가 된다.
   * 프록시 없이 켜면 헤더를 조작해 IP 를 속일 수 있으므로 기본은 꺼둔다.
   */
  TRUST_PROXY: bool(false),

  ADMIN_EMAIL: required('최초 관리자 계정의 이메일').pipe(z.string().email('이메일 형식이 올바르지 않다')),
  ADMIN_INITIAL_PASSWORD: required('최초 관리자의 임시 비밀번호').pipe(
    z.string().min(MIN_PASSWORD_LENGTH, `${MIN_PASSWORD_LENGTH}자 이상이어야 한다`),
  ),

  // 실측: 로그가 blob 으로 flush 되는 주기가 약 60초다 (docs/findings.md).
  // 5초로 폴링하면 12번 중 11번이 416 이다. flush 당 3회 확인하는 20초로 둔다.
  TAIL_POLL_INTERVAL_MS: int(20000, 1000),
  TAIL_INITIAL_BYTES: int(262144, 1024),
  /**
   * 세션당 링버퍼 상한.
   *
   * 이건 '세션마다' 다. 창을 넷 열면 넷 다 이만큼 쥔다.
   * 24시간 켜두면 꽉 찬 상태가 정상이므로, 기본값은 곧 상시 점유 메모리다.
   * 5만 줄/128MB 는 몇 시간 보고 닫는 쓰임에는 맞지만 상시 모니터에는 과하다.
   */
  TAIL_BUFFER_MAX_LINES: int(20000, 100),
  TAIL_BUFFER_MAX_BYTES: int(33554432, 1024 * 1024),
  TAIL_IDLE_TIMEOUT_MS: int(300000, 1000),
  SEARCH_MAX_RESULT_LINES: int(200000, 100),
  EXPORT_MAX_BYTES: int(524288000, 1024),
  MASKING_ENABLED: bool(true),
  /**
   * 감사 기록 보존 기간. 0이면 영구 보관한다.
   *
   * 삭제 API 를 안 만드는 것과 무한히 쌓이게 두는 것은 다른 문제다.
   * tail 을 열 때마다, 조회할 때마다, 내보낼 때마다 한 줄씩 쌓이는데
   * 오래 쓰는 도구라 이걸 안 두면 이메일 검색(LIKE) 이 인덱스를 못 써서
   * 그 동안 모든 tail 이 멈춘다.
   */
  AUDIT_RETENTION_DAYS: int(365, 0),
}).refine((c) => c.SESSION_MAX_HOURS >= c.SESSION_TTL_HOURS, {
  path: ['SESSION_MAX_HOURS'],
  message: 'SESSION_TTL_HOURS 보다 짧을 수 없다. 연장의 천장이지 유효기간이 아니다',
});

const orgSchema = z.object({
  key: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'ORG_n_KEY 는 소문자 영숫자와 하이픈만 쓴다'),
  label: z.string().min(1),
  imsOrgId: z.string().min(1).endsWith('@AdobeOrg', 'ORG_n_IMS_ORG_ID 는 @AdobeOrg 로 끝나야 한다'),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  // Developer Console 은 scope 를 'openid, AdobeID, read_organizations' 처럼 콤마+공백으로 보여준다.
  // 그대로 붙여넣어도 되도록 공백을 털고 콤마로 다시 잇는다. 공백이 남으면 IMS 가 400 을 낸다.
  scopes: z
    .string()
    .transform((v) =>
      v
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.length > 0)
        .join(','),
    )
    .pipe(z.string().min(1)),
});

export interface AppConfig extends z.infer<typeof serverSchema> {
  orgs: Map<string, OrgConfig>;
}

class EnvError extends Error {}

function parseOrgs(env: NodeJS.ProcessEnv): Map<string, OrgConfig> {
  const orgs = new Map<string, OrgConfig>();
  const problems: string[] = [];

  // ORG_{n}_LABEL 이 비면 스캔을 멈춘다.
  for (let n = 1; ; n++) {
    const label = env[`ORG_${n}_LABEL`];
    if (label === undefined || label.trim() === '') break;

    const raw = {
      key: env[`ORG_${n}_KEY`]?.trim() ?? '',
      label: label.trim(),
      imsOrgId: env[`ORG_${n}_IMS_ORG_ID`]?.trim() ?? '',
      clientId: env[`ORG_${n}_CLIENT_ID`]?.trim() ?? '',
      clientSecret: env[`ORG_${n}_CLIENT_SECRET`]?.trim() ?? '',
      scopes: env[`ORG_${n}_SCOPES`]?.trim() ?? '',
    };

    const parsed = orgSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? '');
        const varName = `ORG_${n}_${
          { key: 'KEY', label: 'LABEL', imsOrgId: 'IMS_ORG_ID', clientId: 'CLIENT_ID', clientSecret: 'CLIENT_SECRET', scopes: 'SCOPES' }[
            field
          ] ?? field.toUpperCase()
        }`;
        problems.push(`  ${varName}: ${issue.message}`);
      }
      continue;
    }

    if (orgs.has(parsed.data.key)) {
      problems.push(`  ORG_${n}_KEY: '${parsed.data.key}' 가 중복됐다. org key 는 유일해야 한다`);
      continue;
    }
    orgs.set(parsed.data.key, parsed.data);
  }

  if (problems.length > 0) {
    throw new EnvError(`조직 설정에 문제가 있다:\n${problems.join('\n')}`);
  }
  if (orgs.size === 0) {
    throw new EnvError(
      '조직이 하나도 등록되지 않았다. .env.example 을 복사해 ORG_1_* 를 채운다.\n' +
        '  (ORG_1_LABEL 이 비어 있으면 스캔이 그 자리에서 멈춘다)',
    );
  }
  return orgs;
}

let cached: AppConfig | null = null;

/**
 * 부팅 시 한 번 호출한다. 실패하면 던진다 — 반쯤 뜬 채로 두지 않는다.
 * process.env 로 부를 때만 캐시한다. 명시적 env 를 넘기면(테스트) 매번 새로 파싱한다.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const isDefault = env === process.env;
  if (isDefault && cached) return cached;

  const parsed = serverSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new EnvError(`.env 설정에 문제가 있다:\n${lines.join('\n')}`);
  }

  const cfg: AppConfig = { ...parsed.data, orgs: parseOrgs(env) };
  if (isDefault) cached = cfg;
  return cfg;
}

/** 부팅 실패 시 사람이 읽을 수 있는 메시지를 찍고 즉시 종료한다. */
export function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n[설정 오류] 서버를 시작할 수 없다.\n\n${msg}\n\n.env.example 을 참고한다.\n\n`);
    process.exit(1);
  }
}

export function publicOrgs(cfg: AppConfig): PublicOrg[] {
  return [...cfg.orgs.values()].map((o) => ({ key: o.key, label: o.label }));
}
