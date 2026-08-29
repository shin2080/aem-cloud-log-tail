# 의존성과 그 이유

이 도구는 오래 유지보수할 개인 도구다. 의존성은 적을수록 좋다.
새로 추가할 때는 여기에 한 줄로 이유를 남긴다.

## 런타임

| 패키지 | 이유 |
|---|---|
| `fastify` | HTTP 서버. SSE 를 쓰기 때문에 스트리밍 응답을 막지 않는 프레임워크가 필요했다 |
| `@fastify/cookie` | 세션 쿠키 파싱·발급. SSE 에 쿠키가 자동으로 실리는 것이 WebSocket 대신 SSE 를 고른 이유다 |
| `@fastify/static` | Vite 빌드 산출물을 같은 프로세스에서 서빙. 별도 웹서버를 띄우지 않기 위해 |
| `better-sqlite3` | 동기 SQLite. 로컬 단일 프로세스라 비동기 드라이버의 복잡도가 필요 없다 |
| `drizzle-orm` | 타입이 붙은 쿼리 빌더. 스키마 정의가 곧 타입이 된다 |
| `zod` | `.env` 검증. 필수 값이 비면 부팅을 막기 위해 |
| `dotenv` | `.env` 로딩 |
| `@node-rs/argon2` | argon2id 비밀번호 해싱 (SPEC 지정) |

## 프론트엔드

| 패키지 | 이유 |
|---|---|
| `react`, `react-dom` | (SPEC 지정) |
| `react-router-dom` | `/tail/:sessionKey` 등 URL 로 화면 상태를 표현하기 위해 |
| `@mantine/core`, `hooks`, `dates`, `notifications` | UI (SPEC 지정). `dates` 는 시간대 조회 화면의 DateTimePicker 용 |
| `dayjs` | Mantine dates 의 필수 피어 |
| `@tanstack/react-virtual` | 5만 라인 가상 스크롤. 가변 높이(스택트레이스 펼침) 때문에 `measureElement` 가 필요하다 |
| `pretendard`, `@fontsource/jetbrains-mono` | 폰트 (SPEC 지정). 로컬 전용 도구라 CDN 대신 번들 |

## 개발

| 패키지 | 이유 |
|---|---|
| `typescript`, `@types/*` | |
| `tsx` | 서버 개발 시 TS 직접 실행 + watch |
| `vite`, `@vitejs/plugin-react` | 프론트 번들 |

## SPEC 과 다르게 간 것

- **Fastify 4 → 5.** SPEC 은 4 를 지정했지만 4.x 에는 수정판이 5 에만 있는 high 등급 권고가 셋 있다
  (`sendWebStream` 메모리, Content-Type 우회, `X-Forwarded-*` 스푸핑). Node 20+ 를 이미 요구하므로 5 로 올렸다.
  `@fastify/cookie` 11, `@fastify/static` 10 이 여기에 맞물린다. 우리가 쓰는 API 는 차이가 없다.
  `npm audit` 은 0건이다.
- **`drizzle-kit` 을 쓰지 않는다.** 취약한 esbuild 를 끌고 오는 데다, 마이그레이션이 몇 개 안 되는 규모다.
  `server/db/migrate.ts` 에 SQL 을 손으로 넣고 `_migrations` 테이블로 적용 여부를 관리한다.
  스키마 타입은 `server/db/schema.ts` 의 Drizzle 정의가 담당한다 — 두 곳이 어긋나지 않게 같이 고친다.

## Phase 3 에서 확인한 것

- `@tanstack/react-virtual` 은 실제로 값을 했다. 5만 라인에서 DOM 노드 585개(렌더 행 53개),
  점진 스크롤 프레임 중앙값 20ms(~50fps). 가상 스크롤 없이는 성립하지 않는 화면이다.
- 새 의존성은 추가하지 않았다. gzip 해제(`node:zlib`)와 SSE 는 표준 라이브러리로 충분했다.

## Phase 4

새 의존성 없음. gzip 스트리밍 해제는 `node:zlib`, 스트림 변환은 `node:stream` 으로 충분했다.
`@mantine/dates` 는 Phase 3 에서 이미 설치돼 있었고 여기서 `DateTimePicker` 로 처음 쓰였다.

## Phase 5

새 의존성 없음.
