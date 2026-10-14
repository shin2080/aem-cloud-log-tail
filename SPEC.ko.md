# AEM Cloud Log Viewer — 기술 명세서

**한국어** · [English](SPEC.md)

> **구현 전에 쓴 문서입니다.** 역사적 기록으로 남겨둡니다 — 실제 구현은 여러 곳에서
> 여기서 갈라졌습니다. 지금 동작을 알고 싶으면 [README.ko.md](README.ko.md) 를 보세요.
>
> 눈에 띄는 차이: 알림이 '비목표' 로 적혀 있지만 구현됐고(7장 참고 사항 없음),
> 파서는 `aemerror` 하나가 아니라 7종이며, Fastify 는 4 가 아니라 5,
> 폴링은 5초가 아니라 20초, 링버퍼 기본값은 5만 줄/128MB 가 아니라 2만 줄/32MB,
> 비밀번호 최소 길이는 12자가 아니라 8자입니다.

로컬에서 실행하는 AEM as a Cloud Service 로그 뷰어. 여러 고객사 조직과 환경(dev/stage/prod)을 한 화면에서 실시간으로 tail 하고, 특정 시간대의 에러 로그를 조회하고, 필요한 구간만 골라 파일로 저장한다.

---

## 1. 설계 제약

이 프로젝트의 성격을 결정하는 다섯 가지 제약. 구현 중 판단이 갈릴 때 여기로 돌아온다.

| # | 제약 | 의미 |
|---|---|---|
| 1 | **로그를 영구 저장하지 않는다** | DB에는 설정·계정·감사 기록만 넣는다. 로그 본문은 메모리 링버퍼에만 존재하고 프로세스가 죽으면 사라진다. 사용자는 스트림에서 원하는 구간을 골라 파일로 내보낸다. |
| 2 | **로컬 전용** | 외부 호스팅 없음. `localhost` 바인딩이 기본. DB는 SQLite 파일 하나. |
| 3 | **읽기 전용** | Cloud Manager에 쓰기 작업을 하는 코드는 넣지 않는다. 파이프라인 실행, 환경 변경 API는 호출하지 않는다. |
| 4 | **자격증명은 `.env`에만** | DB·소스코드·프론트엔드 어디에도 client secret이 존재하지 않는다. 브라우저는 IMS 토큰의 존재조차 몰라야 한다. |
| 5 | **조직 경계는 서버에서 강제** | 프론트가 보내는 org 식별자를 신뢰하지 않는다. 모든 요청에서 세션 사용자의 소속 조직과 대조한다. |

### 비목표

- 로그 장기 보관·아카이빙 (Cloud Manager 자체 보존 7일을 그대로 따른다)
- 알림·임계치 감지
- CDN 로그, Dispatcher 로그 (v1은 AEM `aemerror` 중심. 파서는 확장 가능하게 두되 구현은 하지 않는다)
- 멀티 유저 동시 접속 최적화 (동시 사용자 5명 이하를 가정)

---

## 2. 기술 스택

```
runtime     Node.js 20+ / TypeScript (strict)
backend     Fastify 4 + @fastify/cookie, @fastify/static
db          SQLite (better-sqlite3) + Drizzle ORM
frontend    React 18 + Vite + TypeScript
ui          Mantine v7 (+ @mantine/dates, @mantine/notifications, @mantine/hooks)
가상스크롤   @tanstack/react-virtual
폰트        Pretendard Variable (UI) / JetBrains Mono (로그 본문)
암호화      @node-rs/argon2
빌드/실행    단일 프로세스. Fastify가 Vite 빌드 산출물을 정적 서빙한다.
```

**모노레포 아님.** `server/`, `web/`, `shared/` 세 디렉터리를 가진 단일 패키지로 간다. 워크스페이스 도구를 도입할 만큼 크지 않다.

```
/
├── .env.example
├── server/
│   ├── index.ts              진입점
│   ├── config/env.ts         .env 파싱 + 조직 레지스트리 구성
│   ├── db/schema.ts          Drizzle 스키마
│   ├── db/migrate.ts
│   ├── auth/                 세션, 비밀번호, 미들웨어
│   ├── adobe/ims.ts          IMS 토큰 발급·캐시
│   ├── adobe/cloudmanager.ts Cloud Manager API 클라이언트
│   ├── tail/session.ts       TailSession (폴링 루프 + 링버퍼)
│   ├── tail/registry.ts      TailSession 생명주기 관리
│   ├── parse/aemerror.ts     로그 파서
│   ├── parse/mask.ts         마스킹
│   ├── search/scan.ts        시간대 조회 (스트리밍 스캔)
│   ├── export/               파일 내보내기
│   └── routes/
├── web/
│   ├── src/theme.ts          Mantine 테마
│   ├── src/pages/
│   ├── src/components/
│   └── src/api/
└── shared/types.ts           서버·클라이언트 공용 타입
```

---

## 3. 시스템 흐름

```
[Cloud Manager API] ──302──> [서명된 Blob URL]
        │                            │
        │ (토큰 갱신 시에만)          │ Range: bytes=<offset>-  (5초 주기)
        ▼                            ▼
   ┌────────────────────────────────────────┐
   │  TailSession (환경×서비스×로그파일 단위) │
   │   offset 관리 · 파서 · 마스킹 · 링버퍼   │
   └────────────────────────────────────────┘
        │ SSE (레벨 필터 적용 후)
        ▼
   [브라우저] ── 선택 구간 내보내기 ──> [.log / .zip 다운로드]

   [SQLite]  users · user_orgs · sessions · env_cache · audit_log · saved_filters
             (로그 본문 없음)
```

---

## 4. `.env` 명세

`.env.example`을 반드시 함께 만든다. 실제 값이 들어간 `.env`는 `.gitignore`에 넣는다.

```dotenv
# ── 서버 ──────────────────────────────────────────
PORT=7300
HOST=127.0.0.1
DATABASE_PATH=./data/app.db
SESSION_SECRET=                    # openssl rand -hex 32
SESSION_TTL_HOURS=12

# ── 최초 관리자 (첫 부팅 때만 사용) ─────────────────
ADMIN_EMAIL=admin@example.com
ADMIN_INITIAL_PASSWORD=            # 최초 로그인 후 변경 강제

# ── 버퍼 / 안전장치 ────────────────────────────────
TAIL_POLL_INTERVAL_MS=5000
TAIL_BUFFER_MAX_LINES=50000        # 세션당 링버퍼 라인 수
TAIL_BUFFER_MAX_BYTES=134217728    # 세션당 128MB
TAIL_IDLE_TIMEOUT_MS=300000        # 구독자 0명이 5분 지나면 세션 종료
SEARCH_MAX_RESULT_LINES=200000
EXPORT_MAX_BYTES=524288000         # 500MB
MASKING_ENABLED=true

# ── 조직 레지스트리 ────────────────────────────────
# ORG_{n}_ 접두어를 1부터 순번대로 스캔한다.
# ORG_{n}_LABEL 이 없으면 스캔을 멈춘다.
ORG_1_KEY=acme                     # URL·DB에서 쓰는 안정적 식별자 (소문자, 영숫자/하이픈)
ORG_1_LABEL=ACME 코퍼레이션
ORG_1_IMS_ORG_ID=XXXXXXXXXXXX@AdobeOrg
ORG_1_CLIENT_ID=
ORG_1_CLIENT_SECRET=
ORG_1_SCOPES=                      # Developer Console에 표시된 scope 문자열을 그대로 복사

ORG_2_KEY=globex
ORG_2_LABEL=Globex
ORG_2_IMS_ORG_ID=
ORG_2_CLIENT_ID=
ORG_2_CLIENT_SECRET=
ORG_2_SCOPES=
```

### 로딩 규칙

- 부팅 시 zod로 검증한다. 필수 값이 비어 있으면 **명확한 메시지와 함께 즉시 종료**한다. 반쯤 뜬 채로 런타임에 터지게 두지 않는다.
- `ORG_n_KEY`는 DB의 `user_orgs.org_key`와 조인되는 값이다. **한 번 정하면 바꾸지 않는다**는 주석을 `.env.example`에 남긴다.
- 프로그램·환경 목록은 `.env`에 넣지 않는다. Cloud Manager API로 조회해서 DB에 캐시한다. 그래야 고객사 환경이 늘어나도 `.env`를 안 건드린다.
- 조직 설정은 프로세스 메모리에만 올린다. `/api/orgs` 응답에는 `key`와 `label`만 담고 나머지 필드는 절대 직렬화하지 않는다.

---

## 5. 데이터 모델

로그 본문 테이블은 없다. 있으면 안 된다.

```sql
users
  id            TEXT PK          -- uuid
  email         TEXT UNIQUE NOT NULL
  password_hash TEXT NOT NULL    -- argon2id
  display_name  TEXT NOT NULL
  role          TEXT NOT NULL    -- 'admin' | 'member'
  must_change_password INTEGER NOT NULL DEFAULT 0
  is_active     INTEGER NOT NULL DEFAULT 1
  created_at    INTEGER NOT NULL
  last_login_at INTEGER

user_orgs                        -- 조직 접근 권한
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
  org_key       TEXT NOT NULL    -- .env의 ORG_n_KEY
  allow_prod    INTEGER NOT NULL DEFAULT 0   -- prod 환경 열람 여부를 따로 통제
  PRIMARY KEY (user_id, org_key)

sessions
  id            TEXT PK          -- 랜덤 256bit, 쿠키에 담김
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
  created_at    INTEGER NOT NULL
  expires_at    INTEGER NOT NULL
  user_agent    TEXT

env_cache                        -- Cloud Manager 조회 결과 캐시
  org_key       TEXT NOT NULL
  program_id    TEXT NOT NULL
  program_name  TEXT NOT NULL
  environment_id TEXT NOT NULL
  environment_name TEXT NOT NULL
  environment_type TEXT NOT NULL -- 'dev' | 'stage' | 'prod' | 'rde'
  available_services TEXT        -- JSON: [{service, logNames[]}]
  refreshed_at  INTEGER NOT NULL
  PRIMARY KEY (org_key, environment_id)

audit_log
  id            INTEGER PK AUTOINCREMENT
  at            INTEGER NOT NULL
  user_id       TEXT
  user_email    TEXT NOT NULL    -- 계정이 삭제돼도 기록이 남도록 비정규화
  action        TEXT NOT NULL    -- 'login' | 'login_failed' | 'tail_open' | 'search' | 'export' | 'admin_user_create' ...
  org_key       TEXT
  environment_id TEXT
  environment_type TEXT
  detail        TEXT             -- JSON: 범위, 필터, 라인 수, 바이트 수
  ip            TEXT

saved_filters                    -- 자주 쓰는 필터 저장 (편의 기능)
  id            TEXT PK
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
  name          TEXT NOT NULL
  payload       TEXT NOT NULL    -- JSON
  created_at    INTEGER NOT NULL
```

`audit_log`는 삭제 API를 만들지 않는다. 조회만 가능하다.

---

## 6. Cloud Manager 연동

### 6.1 IMS 토큰

OAuth Server-to-Server (`client_credentials`). JWT 방식은 폐기됐으므로 쓰지 않는다.

```
POST https://ims-na1.adobelogin.com/ims/token/v3
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
client_id={ORG_n_CLIENT_ID}
client_secret={ORG_n_CLIENT_SECRET}
scope={ORG_n_SCOPES}
```

- 조직별로 메모리에 캐시한다. `expires_in`의 90% 지점에서 선제 갱신.
- 갱신 실패는 조직 단위로 격리한다. A사 자격증명이 만료돼도 B사 탭은 계속 동작해야 한다.
- **토큰 값은 어떤 로그에도 찍지 않는다.** 디버그 출력에서도.

### 6.2 API 호출

```
Base: https://cloudmanager.adobe.io
Headers:
  Authorization:   Bearer {access_token}
  x-gw-ims-org-id: {ORG_n_IMS_ORG_ID}
  x-api-key:       {ORG_n_CLIENT_ID}
  Accept:          application/json
```

| 용도 | 엔드포인트 |
|---|---|
| 프로그램 목록 | `GET /api/programs` |
| 환경 목록 | `GET /api/program/{programId}/environments` |
| 가용 로그 옵션 | `GET /api/program/{p}/environment/{e}/logs?days=1` |
| 로그 다운로드 | `GET /api/program/{p}/environment/{e}/logs/download?service={service}&name={name}&date=YYYY-MM-DD` |

마지막 것은 **302로 서명된 스토리지 URL을 반환한다.** HTTP 클라이언트의 자동 리다이렉트를 끄고 `Location` 헤더를 직접 읽어야 한다.

### 6.3 Tail 알고리즘 — 이 프로젝트의 핵심

```
1. 다운로드 엔드포인트 호출 → 302 Location에서 서명 URL 획득, 만료 시각 기록
2. 서명 URL에 HEAD 또는 Range: bytes=0-0 요청 → Content-Range로 전체 크기 파악
3. 최초 진입: 끝에서 역방향으로 TAIL_INITIAL_BYTES(기본 256KB)만 읽어 시작점을 잡는다
   (파일 전체를 받지 않는다. 이게 이 도구의 존재 이유다)
4. offset = 파일 크기
5. 루프 (TAIL_POLL_INTERVAL_MS):
     a. 서명 URL에 Range: bytes={offset}- 요청
     b. 416 → 새 데이터 없음, 다음 루프
     c. 200/206 → 받은 청크를 파서로 넘기고 offset += 청크 길이
     d. 서명 URL 만료가 임박하면 1번부터 재수행 (offset은 유지)
     e. UTC 자정 경과 시 → 날짜 파라미터를 갱신하고 새 파일로 전환, offset = 0
```

**Range 요청은 Cloud Manager API가 아니라 스토리지에 직접 나간다.** 그래서 폴링을 아무리 자주 해도 Cloud Manager 레이트 리밋을 소모하지 않는다. 이 구조를 지키는 것이 중요하다. 매 폴링마다 302를 다시 받아오도록 짜면 안 된다.

**UTC 자정 롤오버**는 이 도구에서 가장 버그가 잘 나는 지점이다. 한국 시간 오전 9시에 발생한다. 전용 테스트를 반드시 작성한다. 전환 시점에 이전 파일의 남은 꼬리를 한 번 더 읽고 넘어가야 로그가 비지 않는다.

**세션 공유:** `TailSession`은 `(orgKey, environmentId, service, logName)` 키로 레지스트리에 등록하고 구독자를 ref-count 한다. 같은 환경을 두 명이 봐도 폴링 루프는 하나다. 구독자가 0이 되고 `TAIL_IDLE_TIMEOUT_MS`가 지나면 루프를 멈추고 버퍼를 비운다.

### 6.4 로그 파싱

`aemerror` 라인 포맷:

```
25.09.2023 15:34:56.428 [cm-p12345-e987654-aem-author-54c7ddc56c-vf8vb] *INFO* [sling-oak-observation-5] com.adobe.cq.Foo 메시지 본문
```

```ts
const LINE = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2}:\d{2}\.\d{3}) \[([^\]]+)\] \*(\w+)\* \[([^\]]*)\] (.*)$/;

interface LogEntry {
  seq: number;          // 세션 내 단조 증가. 클라이언트 dedupe·범위 선택 키
  ts: number;           // epoch ms (원본은 UTC)
  level: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE' | 'UNKNOWN';
  pod: string;          // cm-p12345-e987654-aem-author-...
  thread: string;
  logger: string;       // message의 첫 토큰
  message: string;
  continuation: string[]; // 스택트레이스 등 후속 라인
  raw: string;
}
```

파서가 반드시 지켜야 할 것:

- **정규식에 안 맞는 라인은 버리지 않는다.** 직전 엔트리의 `continuation`에 붙인다. 스택트레이스가 여기 들어온다. 직전 엔트리가 없으면 `level: 'UNKNOWN'`으로 단독 엔트리를 만든다.
- **청크 경계에서 라인이 잘린다.** 마지막 개행 이후의 잔여 바이트는 다음 청크 앞에 이어붙인다.
- **타임스탬프는 UTC다.** 내부는 전부 epoch ms로 다루고, 표시할 때만 KST로 변환한다. UI에 타임존 토글을 둔다.
- 파서는 `LogParser` 인터페이스로 두고 `aemerror` 구현만 등록한다. `request.log` 등은 나중에 추가한다.

### 6.5 마스킹

`MASKING_ENABLED=true`일 때 **파서 직후, 버퍼에 들어가기 전에** 적용한다. 렌더링 단계에서 가리는 방식은 금지한다 — 그러면 내보내기 파일에 원문이 그대로 나간다.

기본 규칙 (`parse/mask.ts`에 배열로 두고 확장 가능하게):

| 대상 | 패턴 예 | 치환 |
|---|---|---|
| Bearer 토큰 | `Bearer\s+[A-Za-z0-9._\-]{20,}` | `Bearer ***` |
| Basic 인증 | `Basic\s+[A-Za-z0-9+/=]{16,}` | `Basic ***` |
| 이메일 | 표준 이메일 패턴 | `a***@example.com` (도메인 유지) |
| 주민등록번호 형태 | `\d{6}[-\s]?[1-4]\d{6}` | `******-*******` |
| 쿼리스트링 민감 키 | `(password\|token\|secret\|apikey\|api_key)=[^&\s]+` | `$1=***` |
| 신용카드 형태 | Luhn 검증을 통과하는 13~19자리 | `****-****-****-1234` |

마스킹된 엔트리에 `masked: true` 플래그를 달고 UI에서 작은 배지로 표시한다. 무엇이 가려졌는지 사용자가 알아야 한다.

---

## 7. 백엔드 API

모든 응답은 JSON. 오류는 `{ error: { code, message } }`. 스택트레이스를 응답에 담지 않는다.

### 인증

```
POST   /api/auth/login          { email, password } → 세션 쿠키 발급
POST   /api/auth/logout
GET    /api/auth/me             → { id, email, displayName, role, mustChangePassword, orgs: [{key,label,allowProd}] }
POST   /api/auth/password       { currentPassword, newPassword }
```

### 조직 · 환경

```
GET    /api/orgs                                        → 세션 사용자에게 허용된 조직만
GET    /api/orgs/:orgKey/environments?refresh=true      → env_cache 반환 (refresh=true면 Cloud Manager 재조회)
GET    /api/orgs/:orgKey/environments/:envId/log-options
```

### Tail (SSE)

```
GET /api/tail?org={key}&env={id}&service={author|publish|preview}&name={aemerror}&levels=ERROR,WARN
```

`text/event-stream`으로 응답. 이벤트 종류:

```
event: ready     data: { sessionId, bufferedCount, oldestSeq, newestSeq }
event: entries   data: { entries: LogEntry[] }        // 배치. 100ms 디바운스 또는 500건마다
event: rollover  data: { newDate: "2026-08-29" }
event: error     data: { code, message, recoverable }
event: ping                                            // 15초마다. 프록시 타임아웃 방지
```

- 레벨 필터는 **서버에서 적용**한다. ERROR만 보는데 INFO 수만 줄을 브라우저로 보낼 이유가 없다.
- 링버퍼가 넘쳐 오래된 엔트리가 밀려나면 `event: truncated`로 알린다. 조용히 사라지면 안 된다.

### 시간대 조회

즉시 응답하지 않는다. 잡을 만들고 진행 상황을 스트리밍한다.

```
POST   /api/search
       { org, envId, service, name, from, to, levels[], query?, regex? }
       → { jobId }

GET    /api/search/:jobId/stream   (SSE)
       event: progress  { scannedBytes, totalBytes, matched }
       event: entries   { entries: LogEntry[] }
       event: done      { matched, truncated }

DELETE /api/search/:jobId          진행 중 취소
```

스캔 구현: 요청 구간에 걸친 날짜별 파일을 순서대로 스트리밍으로 훑으며 파싱·필터한다. **전체를 메모리에 올리지 않는다.** `SEARCH_MAX_RESULT_LINES`에 도달하면 중단하고 `truncated: true`로 알린다.

날짜 경계 계산에 주의한다. 사용자가 KST로 "8/28 14:00~15:00"을 지정하면 UTC 기준 8/28 05:00~06:00이고, KST 오전 0~9시 구간은 **UTC 전날 파일**을 읽어야 한다.

### 내보내기

```
POST   /api/export
       {
         source: 'tail' | 'search',
         sessionId | jobId,
         seqFrom?, seqTo?,          // tail: 선택 구간
         levels?[], query?,          // 추가 필터
         format: 'log' | 'json' | 'csv',
         includeContinuation: boolean
       }
       → { exportId, estimatedBytes }

GET    /api/export/:exportId/download   → 스트리밍 응답, 다운로드 후 즉시 폐기
```

- 서버 디스크에 임시 파일을 쓰지 않는다. 버퍼에서 바로 스트림으로 흘린다.
- `EXPORT_MAX_BYTES` 초과 시 400과 함께 "범위를 좁히세요" 메시지를 반환한다.
- `format: 'log'`는 원본 라인 그대로. `json`은 `LogEntry` 배열(JSONL). `csv`는 `ts,level,pod,thread,logger,message`.

**모든 내보내기 파일 첫머리에 출처 헤더를 넣는다** (`log`/`csv`는 주석 라인, `json`은 첫 객체):

```
# AEM Cloud Log Viewer export
# org=acme  program=12345  environment=67890 (prod)  service=publish  log=aemerror
# range=2026-08-28T14:00:00+09:00 ~ 2026-08-28T14:30:00+09:00 (KST)
# filters=level:ERROR  query:"NullPointer"
# masked=true  lines=1284
# exported by shin@example.com at 2026-08-28T15:02:11+09:00
```

며칠 뒤 이 파일이 어디서 왔는지 헷갈리지 않게 하는 것이 목적이다. 파일명도 고정 규칙을 쓴다:

```
{orgKey}-p{programId}-e{envId}-{service}-{logName}-{fromYYYYMMDDTHHmm}_{toHHmm}.log
```

### 관리자

```
GET    /api/admin/users
POST   /api/admin/users          { email, displayName, role, orgs: [{key, allowProd}] }
                                 → 임시 비밀번호를 응답에 1회만 반환. 저장하지 않는다.
PATCH  /api/admin/users/:id      { displayName?, role?, isActive?, orgs? }
POST   /api/admin/users/:id/reset-password  → 새 임시 비밀번호 1회 반환
DELETE /api/admin/users/:id
GET    /api/admin/audit?from&to&userId&action&orgKey&limit&offset
```

---

## 8. 인증 · 인가

### 로그인

- 관리자가 발급하는 방식만 존재한다. **회원가입 엔드포인트를 만들지 않는다.**
- 최초 부팅 시 `users`가 비어 있으면 `.env`의 `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD`로 관리자 1명을 생성하고 `must_change_password = 1`로 둔다. 콘솔에 안내를 출력한다. 이후 부팅에서는 이 로직을 타지 않는다.
- 비밀번호는 argon2id. 최소 12자 검증.
- `must_change_password`가 1이면 비밀번호 변경 외 모든 API를 403으로 막는다.
- 로그인 실패는 이메일 단위로 5회 5분 레이트 리밋. 성공·실패 모두 `audit_log`에 남긴다.

### 세션

- `httpOnly`, `SameSite=Strict`, `Path=/`. 로컬 HTTP 실행이 기본이라 `secure`는 환경변수로 토글한다.
- SSE는 쿠키가 자동으로 실린다. WebSocket을 쓰지 않는 이유다.
- 서버 재시작 시 세션 유지 (SQLite에 저장). 만료 세션은 부팅 시와 1시간 주기로 정리한다.

### 인가 체크 (모든 데이터 라우트에서)

```
1. 세션 유효한가
2. 요청의 orgKey가 user_orgs에 있는가          → 없으면 404 (403 아님. 존재 여부를 흘리지 않는다)
3. 대상 환경이 prod인가                         → 그렇다면 user_orgs.allow_prod 확인
4. env_cache에서 (orgKey, envId) 쌍이 일치하는가 → 다른 조직의 환경 ID를 넘기는 시도 차단
5. audit_log 기록
```

3번을 별도로 두는 이유: 고객사 prod 로그에는 실사용자 데이터가 섞인다. 조직 접근 권한과 prod 열람 권한은 분리되어야 한다.

---

## 9. 프론트엔드

### 화면 구성

```
/login                로그인
/                     환경 선택 (조직 → 프로그램 → 환경 → 서비스/로그)
/tail/:sessionKey     실시간 tail
/search               시간대 조회
/admin/users          계정 관리 (admin only)
/admin/audit          감사 로그 (admin only)
```

**AppShell 구조**

- Header: 좌측에 현재 조직·환경, 우측에 계정 메뉴. **환경 타입을 색으로 구분한다** — dev는 중립 회색, stage는 파랑, **prod는 붉은 계열**. prod를 보고 있다는 사실이 한눈에 들어와야 오조작이 준다.
- Navbar: 조직 → 환경 트리. prod는 아이콘으로 한 번 더 표시.
- Main: 로그 뷰.

### 로그 뷰어 컴포넌트

가장 중요한 컴포넌트다. 여기에 공을 들인다.

- **가상 스크롤 필수.** 5만 라인을 DOM에 그리면 브라우저가 죽는다. `@tanstack/react-virtual`로 처리한다. 라인 높이가 가변(스택트레이스 펼침)이므로 `measureElement`를 쓴다.
- **자동 스크롤 + 고정.** 하단에 붙어 있으면 새 로그를 따라가고, 사용자가 위로 스크롤하면 자동 추적을 멈추고 "새 로그 N건 — 맨 아래로" 버튼을 띄운다. 로그 뷰어의 기본 예의다.
- **라인 렌더링:** 시각(모노스페이스, 흐린 색) / 레벨 배지 / 로거(축약, hover 시 전체) / 메시지. 스택트레이스는 접어두고 클릭하면 펼친다.
- **레벨 색:** ERROR는 강한 강조 하나만. WARN은 중간. INFO/DEBUG는 배경과 거의 같은 톤. 로그 뷰어에서 모든 줄이 알록달록하면 아무것도 안 보인다. 강조는 ERROR 한 곳에만 쓴다.
- **범위 선택:** 시작 라인 클릭 → Shift+클릭으로 끝 라인. 선택 구간이 하이라이트되고 하단에 "N줄 선택됨 · 내보내기" 액션바가 나타난다. **이게 이 도구의 시그니처 인터랙션이다.** 파일 전체를 받는 게 아니라 눈으로 보고 필요한 만큼만 집어가는 경험.
- **하이라이트 검색:** 버퍼 내 즉시 필터. 정규식 토글.
- **일시정지:** 스트림을 멈춰 화면을 고정한다. 서버 폴링은 계속되므로 재개하면 밀린 로그가 들어온다.

### 시간대 조회 화면

- `@mantine/dates`의 `DateTimePicker` 두 개. 프리셋 버튼("최근 1시간", "최근 6시간", "어제") 제공.
- **기본 선택 레벨은 ERROR.** 이 화면의 주 용도가 그것이다.
- 스캔 중에는 `Progress` 바와 함께 결과가 점진적으로 채워진다. 취소 버튼 상시 노출.
- 결과는 tail 뷰어와 동일한 컴포넌트를 재사용한다. 범위 선택·내보내기도 동일하게 동작한다.

### Mantine v7 + Pretendard 설정

Mantine v7은 Emotion을 쓰지 않는다. `@mantine/core/styles.css`를 **반드시 최상단에서** import 한다.

```bash
npm i @mantine/core @mantine/hooks @mantine/dates @mantine/notifications dayjs
npm i pretendard @fontsource/jetbrains-mono
```

```ts
// web/src/main.tsx — import 순서가 중요하다
import 'pretendard/dist/web/variable/pretendardvariable.css';
import '@fontsource/jetbrains-mono/400.css';
import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';
import '@mantine/notifications/styles.css';
import './global.css';
```

```ts
// web/src/theme.ts
import { createTheme, MantineColorsTuple } from '@mantine/core';

const slate: MantineColorsTuple = [/* 10단계 */];

export const theme = createTheme({
  fontFamily:
    'Pretendard Variable, Pretendard, -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  fontFamilyMonospace: 'JetBrains Mono, D2Coding, Menlo, monospace',
  headings: { fontFamily: 'Pretendard Variable, Pretendard, sans-serif', fontWeight: '600' },
  defaultRadius: 'sm',
  primaryColor: 'slate',
  colors: { slate },
  components: {
    Button: { defaultProps: { size: 'sm' } },
    Table:  { defaultProps: { striped: false, highlightOnHover: true } },
  },
});
```

```tsx
<MantineProvider theme={theme} defaultColorScheme="dark">
```

**다크 모드가 기본이다.** 로그를 오래 들여다보는 도구다. 라이트 모드도 동작은 하게 두되 기본값은 다크로 둔다.

### 디자인 방향

이 도구의 성격은 "터미널을 대신하는 계기판"이다. 장식을 넣지 않는다.

- 여백은 좁게, 정보 밀도는 높게. 한 화면에 최대한 많은 라인이 보여야 한다.
- 색은 상태를 나타낼 때만 쓴다. 환경 타입(dev/stage/prod)과 로그 레벨(ERROR), 이 둘 외에는 무채색으로 간다.
- 애니메이션은 스크롤 추적과 접힘/펼침 정도만. 로딩 스켈레톤에 힘주지 않는다.
- 빈 상태는 다음 행동을 지시한다. "로그가 없습니다"가 아니라 "이 환경에는 최근 1시간 동안 ERROR가 없습니다. 레벨을 넓히거나 시간대를 바꿔보세요."
- 버튼 문구는 실제로 일어나는 일을 그대로 쓴다. "제출"이 아니라 "선택 구간 내보내기".

---

## 10. 구현 순서

각 단계는 그 자체로 동작해야 한다. 전부 만들고 마지막에 붙이는 방식은 금지.

**Phase 0 — 검증 (코드 작성 전)**
실제 환경 하나로 다음을 확인하고 결과를 `docs/findings.md`에 기록한다. 여기서 나온 사실이 이후 설계를 바꿀 수 있다.
1. `logs/download`가 반환하는 302 Location URL의 만료 시간
2. **당일 파일이 gzip으로 오는가, 평문으로 오는가** — gzip이면 Range 바이트 오프셋으로 부분 디코딩이 안 되므로 tail 전략을 다시 짜야 한다. 가장 중요한 확인 항목이다
3. 서명 URL이 `Range` 헤더에 `206 Partial Content`로 응답하는가
4. 새 로그가 실제로 반영되기까지의 지연 (여러 번 측정해 중앙값)
5. `logs?days=N` 응답 스키마 실물

**Phase 1 — 골격**
`.env` 로더 + zod 검증, SQLite 스키마·마이그레이션, Fastify 부팅, 최초 관리자 시딩, 로그인/로그아웃/세션, 최소 로그인 화면. 여기까지 되면 로그인해서 빈 화면을 볼 수 있다.

**Phase 2 — Adobe 연동**
IMS 토큰 캐시, Cloud Manager 클라이언트, 프로그램·환경 조회와 `env_cache` 적재, 환경 선택 화면. 여기까지 되면 조직별 환경 트리가 보인다.

**Phase 3 — Tail**
파서 + 마스킹 + 단위 테스트(멀티라인 스택, 청크 경계, **UTC 롤오버**), `TailSession` 폴링 루프, SSE 라우트, 가상 스크롤 뷰어, 자동 스크롤. 여기까지가 이 프로젝트의 절반이다.

**Phase 4 — 조회와 내보내기**
시간대 스캔 잡, 진행률 SSE, 조회 화면, 범위 선택 인터랙션, 세 가지 포맷 내보내기, 출처 헤더.

**Phase 5 — 운영**
관리자 계정 화면, 감사 로그 조회, prod 권한 분리 적용, 저장된 필터, README.

---

## 11. 미확정 사항

구현 중 마주치면 임의로 결정하지 말고 기록한 뒤 물어본다.

- **당일 로그 파일의 압축 여부** (Phase 0에서 확인). gzip이라면 대안은 두 가지다 — (a) 매 폴링마다 전체를 받아 압축 해제하고 이전과의 델타만 취한다(대역폭 손해가 크다), (b) 폴링 주기를 늘리고 마지막 N바이트만 받아 부분 해제를 시도한다. 확인 결과에 따라 결정한다.
- Cloud Manager API의 정확한 레이트 리밋 수치. 429 응답의 `Retry-After`를 존중하는 지수 백오프를 넣어두고, 실제 한도는 관측으로 파악한다.
- Additional Publish Region이 켜진 환경의 서비스 목록 형태. 리전별로 별도 항목으로 오는지 확인 후 UI에 반영한다.
- `preview` 서비스가 없는 환경의 응답 형태.

---

## 12. 수용 기준

- [ ] `.env`에 조직 2개를 등록하면 로그인 후 두 조직의 환경이 모두 보인다
- [ ] `.env` 없이 실행하면 어떤 값이 빠졌는지 알려주며 즉시 종료한다
- [ ] client secret이 HTTP 응답·프론트 번들·DB·로그 어디에도 나타나지 않는다 (grep으로 검증)
- [ ] 조직 A만 가진 계정이 조직 B의 환경 ID를 직접 호출하면 404를 받는다
- [ ] `allow_prod`가 없는 계정은 prod 환경 tail이 거부된다
- [ ] 5만 라인이 쌓인 tail 화면에서 스크롤이 끊기지 않는다
- [ ] 자동 추적 중 위로 스크롤하면 멈추고, 맨 아래로 돌아가면 재개된다
- [ ] UTC 자정을 지나도 로그가 끊기지 않는다 (모의 시계 테스트)
- [ ] 스택트레이스가 한 엔트리로 묶여 접힘/펼침이 동작한다
- [ ] 내보낸 파일에 마스킹이 적용되어 있다
- [ ] 내보낸 파일 첫머리에 조직·환경·범위·필터·요청자가 기록되어 있다
- [ ] 500MB를 넘는 내보내기 요청은 거부되고 이유를 안내한다
- [ ] 로그인·tail 시작·조회·내보내기가 `audit_log`에 남는다
- [ ] 프로세스를 재시작하면 로그 본문은 사라지고 계정·설정·감사 기록은 남는다

---

## 13. Claude Code에게

- **Phase 0을 먼저 하고 결과를 보고한 뒤 Phase 1로 넘어간다.** 특히 gzip 여부를 확인하기 전에 tail 로직을 쓰지 않는다.
- 파서와 롤오버 로직은 테스트를 먼저 쓴다. 이 두 곳에서 나는 버그는 조용해서 늦게 발견된다.
- 새 의존성을 추가할 때는 이유를 한 줄로 남긴다. 이 도구는 오래 유지보수할 개인 도구이므로 의존성이 적을수록 좋다.
- 6장의 Range 폴링 구조를 단순화하고 싶은 유혹이 생기면, 그게 이 도구가 존재하는 이유임을 기억한다. 파일 전체를 받는 코드를 쓰고 있다면 방향이 틀렸다.
