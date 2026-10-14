# AEM Cloud Log Viewer — Technical Specification

**English** · [한국어](SPEC.ko.md)

> **This was written before implementation.** It is kept as a historical record — the
> actual implementation diverged from it in several places. For how the tool behaves
> today, read [README.md](README.md).
>
> Notable differences: alerts are listed here as a non-goal but are implemented; there
> are seven parsers, not just `aemerror`; Fastify is 5, not 4; polling is every 20
> seconds, not 5; ring buffer defaults are 20,000 lines / 32MB, not 50,000 / 128MB; and
> the minimum password length is 8, not 12.

A locally run log viewer for AEM as a Cloud Service. Tail logs from several customer
organizations and environments (dev/stage/prod) live on one screen, search error logs
for a given time range, and save only the slice you need to a file.

---

## 1. Design constraints

Five constraints that define the character of this project. When a judgment call during
implementation is close, come back here.

| # | Constraint | What it means |
|---|---|---|
| 1 | **Logs are never persisted** | The DB holds config, accounts and audit records only. Log bodies exist only in an in-memory ring buffer and vanish when the process dies. The user picks a range out of the stream and exports it to a file. |
| 2 | **Local only** | No external hosting. `localhost` binding by default. The DB is a single SQLite file. |
| 3 | **Read only** | No code that writes to Cloud Manager. Pipeline execution and environment-change APIs are never called. |
| 4 | **Credentials live in `.env` only** | No client secret exists in the DB, the source, or the frontend. The browser must not even know an IMS token exists. |
| 5 | **Org boundaries are enforced server-side** | The org identifier the frontend sends is never trusted. Every request is checked against the session user's organizations. |

### Non-goals

- Long-term log retention or archiving (follow Cloud Manager's own 7-day retention)
- Alerting and threshold detection
- CDN logs and dispatcher logs (v1 centers on AEM `aemerror`. Leave the parser
  extensible but do not implement them)
- Optimizing for many concurrent users (assume five or fewer)

---

## 2. Stack

```
runtime      Node.js 20+ / TypeScript (strict)
backend      Fastify 4 + @fastify/cookie, @fastify/static
db           SQLite (better-sqlite3) + Drizzle ORM
frontend     React 18 + Vite + TypeScript
ui           Mantine v7 (+ @mantine/dates, @mantine/notifications, @mantine/hooks)
virtual list @tanstack/react-virtual
fonts        Pretendard Variable (UI) / JetBrains Mono (log bodies)
hashing      @node-rs/argon2
build/run    One process. Fastify serves the Vite build output statically.
```

**Not a monorepo.** A single package with three directories: `server/`, `web/`,
`shared/`. Not large enough to justify workspace tooling.

```
/
├── .env.example
├── server/
│   ├── index.ts              entry point
│   ├── config/env.ts         .env parsing + org registry construction
│   ├── db/schema.ts          Drizzle schema
│   ├── db/migrate.ts
│   ├── auth/                 sessions, passwords, middleware
│   ├── adobe/ims.ts          IMS token issue and cache
│   ├── adobe/cloudmanager.ts Cloud Manager API client
│   ├── tail/session.ts       TailSession (polling loop + ring buffer)
│   ├── tail/registry.ts      TailSession lifecycle
│   ├── parse/aemerror.ts     log parser
│   ├── parse/mask.ts         masking
│   ├── search/scan.ts        time-range search (streaming scan)
│   ├── export/               file export
│   └── routes/
├── web/
│   ├── src/theme.ts          Mantine theme
│   ├── src/pages/
│   ├── src/components/
│   └── src/api/
└── shared/types.ts           types shared by server and client
```

---

## 3. System flow

```
[Cloud Manager API] ──302──> [signed Blob URL]
        │                            │
        │ (only on token refresh)    │ Range: bytes=<offset>-  (every 5s)
        ▼                            ▼
   ┌─────────────────────────────────────────────────┐
   │  TailSession (one per environment×service×log)  │
   │   offset · parser · masking · ring buffer       │
   └─────────────────────────────────────────────────┘
        │ SSE (after the level filter)
        ▼
   [browser] ── export selection ──> [.log / .zip download]

   [SQLite]  users · user_orgs · sessions · env_cache · audit_log · saved_filters
             (no log bodies)
```

---

## 4. `.env` specification

Always ship a `.env.example` alongside. The real `.env` goes in `.gitignore`.

```dotenv
# ── server ────────────────────────────────────────
PORT=7300
HOST=127.0.0.1
DATABASE_PATH=./data/app.db
SESSION_SECRET=                    # openssl rand -hex 32
SESSION_TTL_HOURS=12

# ── first administrator (first boot only) ─────────
ADMIN_EMAIL=admin@example.com
ADMIN_INITIAL_PASSWORD=            # change forced after first sign-in

# ── buffers / safety limits ───────────────────────
TAIL_POLL_INTERVAL_MS=5000
TAIL_BUFFER_MAX_LINES=50000        # ring buffer lines per session
TAIL_BUFFER_MAX_BYTES=134217728    # 128MB per session
TAIL_IDLE_TIMEOUT_MS=300000        # end the session 5 minutes after the last subscriber
SEARCH_MAX_RESULT_LINES=200000
EXPORT_MAX_BYTES=524288000         # 500MB
MASKING_ENABLED=true

# ── organization registry ─────────────────────────
# Scanned by the ORG_{n}_ prefix, starting at 1.
# Scanning stops at the first missing ORG_{n}_LABEL.
ORG_1_KEY=acme                     # stable identifier used in URLs and the DB (lowercase, alphanumeric/hyphen)
ORG_1_LABEL=ACME Corporation
ORG_1_IMS_ORG_ID=XXXXXXXXXXXX@AdobeOrg
ORG_1_CLIENT_ID=
ORG_1_CLIENT_SECRET=
ORG_1_SCOPES=                      # copy the scope string exactly as shown in the Developer Console

ORG_2_KEY=globex
ORG_2_LABEL=Globex
ORG_2_IMS_ORG_ID=
ORG_2_CLIENT_ID=
ORG_2_CLIENT_SECRET=
ORG_2_SCOPES=
```

### Loading rules

- Validate with zod at boot. If a required value is empty, **exit immediately with a
  clear message.** Do not come up half-configured and blow up at runtime.
- `ORG_n_KEY` joins against `user_orgs.org_key` in the DB. Leave a comment in
  `.env.example` saying **once chosen, never change it**.
- Program and environment lists do not go in `.env`. Fetch them from the Cloud Manager
  API and cache them in the DB, so `.env` stays untouched as a customer's environments grow.
- Org configuration lives in process memory only. The `/api/orgs` response carries `key`
  and `label` and nothing else; the remaining fields are never serialized.

---

## 5. Data model

There is no table for log bodies. There must not be one.

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

user_orgs                        -- organization access
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
  org_key       TEXT NOT NULL    -- ORG_n_KEY from .env
  allow_prod    INTEGER NOT NULL DEFAULT 0   -- prod access is controlled separately
  PRIMARY KEY (user_id, org_key)

sessions
  id            TEXT PK          -- random 256-bit, carried in the cookie
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
  created_at    INTEGER NOT NULL
  expires_at    INTEGER NOT NULL
  user_agent    TEXT

env_cache                        -- cached Cloud Manager lookups
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
  user_email    TEXT NOT NULL    -- denormalized so the record survives account deletion
  action        TEXT NOT NULL    -- 'login' | 'login_failed' | 'tail_open' | 'search' | 'export' | 'admin_user_create' ...
  org_key       TEXT
  environment_id TEXT
  environment_type TEXT
  detail        TEXT             -- JSON: range, filters, line count, byte count
  ip            TEXT

saved_filters                    -- frequently used filters (convenience)
  id            TEXT PK
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
  name          TEXT NOT NULL
  payload       TEXT NOT NULL    -- JSON
  created_at    INTEGER NOT NULL
```

`audit_log` gets no delete API. It is read-only.

---

## 6. Cloud Manager integration

### 6.1 IMS tokens

OAuth Server-to-Server (`client_credentials`). JWT is retired, so it is not used.

```
POST https://ims-na1.adobelogin.com/ims/token/v3
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
client_id={ORG_n_CLIENT_ID}
client_secret={ORG_n_CLIENT_SECRET}
scope={ORG_n_SCOPES}
```

- Cached in memory per organization. Refreshed proactively at 90% of `expires_in`.
- Refresh failures are isolated per organization. If org A's credentials expire, org B's
  tabs must keep working.
- **The token value is never written to any log.** Not even to debug output.

### 6.2 API calls

```
Base: https://cloudmanager.adobe.io
Headers:
  Authorization:   Bearer {access_token}
  x-gw-ims-org-id: {ORG_n_IMS_ORG_ID}
  x-api-key:       {ORG_n_CLIENT_ID}
  Accept:          application/json
```

| Purpose | Endpoint |
|---|---|
| Program list | `GET /api/programs` |
| Environment list | `GET /api/program/{programId}/environments` |
| Available log options | `GET /api/program/{p}/environment/{e}/logs?days=1` |
| Log download | `GET /api/program/{p}/environment/{e}/logs/download?service={service}&name={name}&date=YYYY-MM-DD` |

The last one **returns a signed storage URL via a 302.** Turn off the HTTP client's
automatic redirect following and read the `Location` header directly.

### 6.3 The tail algorithm — the core of this project

```
1. Call the download endpoint → take the signed URL from the 302 Location, record its expiry
2. HEAD or Range: bytes=0-0 against the signed URL → read the total size from Content-Range
3. First entry: read only the last TAIL_INITIAL_BYTES (default 256KB) to find a starting point
   (never download the whole file — this is the reason the tool exists)
4. offset = file size
5. Loop (TAIL_POLL_INTERVAL_MS):
     a. Range: bytes={offset}- against the signed URL
     b. 416 → no new data, next iteration
     c. 200/206 → hand the chunk to the parser, offset += chunk length
     d. If the signed URL is close to expiring, redo from step 1 (keep the offset)
     e. Past UTC midnight → update the date parameter, switch files, offset = 0
```

**Range requests go directly to storage, not to the Cloud Manager API.** That is why
polling as often as you like does not consume the Cloud Manager rate limit. Keeping this
structure matters. Do not write it so that every poll fetches a new 302.

**UTC midnight rollover** is where bugs are most likely in this tool. It happens at 09:00
Korean time. Write dedicated tests for it. At the switch, read the remaining tail of the
previous file once more, or logs go missing.

**Session sharing:** register `TailSession` in a registry keyed by
`(orgKey, environmentId, service, logName)` and ref-count subscribers. Two people
watching the same environment share one polling loop. When subscribers reach zero and
`TAIL_IDLE_TIMEOUT_MS` passes, stop the loop and clear the buffer.

### 6.4 Log parsing

`aemerror` line format:

```
25.09.2023 15:34:56.428 [cm-p12345-e987654-aem-author-54c7ddc56c-vf8vb] *INFO* [sling-oak-observation-5] com.adobe.cq.Foo message body
```

```ts
const LINE = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2}:\d{2}\.\d{3}) \[([^\]]+)\] \*(\w+)\* \[([^\]]*)\] (.*)$/;

interface LogEntry {
  seq: number;          // monotonic within a session. Key for client dedupe and range selection
  ts: number;           // epoch ms (the source is UTC)
  level: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE' | 'UNKNOWN';
  pod: string;          // cm-p12345-e987654-aem-author-...
  thread: string;
  logger: string;       // first token of the message
  message: string;
  continuation: string[]; // stack traces and other follow-on lines
  raw: string;
}
```

What the parser must get right:

- **Lines that do not match the regex are not discarded.** They attach to the previous
  entry's `continuation` — this is where stack traces go. With no previous entry, make a
  standalone entry with `level: 'UNKNOWN'`.
- **Lines get cut at chunk boundaries.** Carry the bytes after the last newline and
  prepend them to the next chunk.
- **Timestamps are UTC.** Handle everything internally as epoch ms and convert to KST
  only for display. Put a time zone toggle in the UI.
- Define the parser behind a `LogParser` interface and register only the `aemerror`
  implementation. `request.log` and others come later.

### 6.5 Masking

When `MASKING_ENABLED=true`, apply it **right after parsing, before the buffer.**
Redacting at render time is forbidden — that would put the original text in exported files.

Default rules (an extensible array in `parse/mask.ts`):

| Target | Example pattern | Replacement |
|---|---|---|
| Bearer token | `Bearer\s+[A-Za-z0-9._\-]{20,}` | `Bearer ***` |
| Basic auth | `Basic\s+[A-Za-z0-9+/=]{16,}` | `Basic ***` |
| Email | standard email pattern | `a***@example.com` (domain kept) |
| Korean national ID shape | `\d{6}[-\s]?[1-4]\d{6}` | `******-*******` |
| Sensitive query keys | `(password\|token\|secret\|apikey\|api_key)=[^&\s]+` | `$1=***` |
| Card number shape | 13–19 digits passing Luhn | `****-****-****-1234` |

Flag masked entries with `masked: true` and show a small badge in the UI. The user needs
to know something was redacted.

---

## 7. Backend API

All responses are JSON. Errors are `{ error: { code, message } }`. Stack traces never go
in a response.

### Authentication

```
POST   /api/auth/login          { email, password } → issues a session cookie
POST   /api/auth/logout
GET    /api/auth/me             → { id, email, displayName, role, mustChangePassword, orgs: [{key,label,allowProd}] }
POST   /api/auth/password       { currentPassword, newPassword }
```

### Organizations and environments

```
GET    /api/orgs                                        → only organizations the session user may see
GET    /api/orgs/:orgKey/environments?refresh=true      → returns env_cache (refresh=true refetches from Cloud Manager)
GET    /api/orgs/:orgKey/environments/:envId/log-options
```

### Tail (SSE)

```
GET /api/tail?org={key}&env={id}&service={author|publish|preview}&name={aemerror}&levels=ERROR,WARN
```

Responds as `text/event-stream`. Event types:

```
event: ready     data: { sessionId, bufferedCount, oldestSeq, newestSeq }
event: entries   data: { entries: LogEntry[] }        // batched. 100ms debounce or every 500
event: rollover  data: { newDate: "2026-08-29" }
event: error     data: { code, message, recoverable }
event: ping                                            // every 15s, to defeat proxy timeouts
```

- The level filter is applied **on the server.** There is no reason to push tens of
  thousands of INFO lines to a browser that is only showing ERROR.
- When the ring buffer overflows and old entries are pushed out, say so with
  `event: truncated`. They must not disappear silently.

### Time-range search

Does not respond immediately. Create a job and stream progress.

```
POST   /api/search
       { org, envId, service, name, from, to, levels[], query?, regex? }
       → { jobId }

GET    /api/search/:jobId/stream   (SSE)
       event: progress  { scannedBytes, totalBytes, matched }
       event: entries   { entries: LogEntry[] }
       event: done      { matched, truncated }

DELETE /api/search/:jobId          cancel in progress
```

Scan implementation: walk the per-date files covering the requested range in order,
streaming, parsing and filtering as you go. **Never load the whole thing into memory.**
On reaching `SEARCH_MAX_RESULT_LINES`, stop and report `truncated: true`.

Be careful with date boundaries. When the user asks for "8/28 14:00–15:00" in KST that is
8/28 05:00–06:00 UTC, and the 00:00–09:00 KST window has to read **the previous day's UTC
file**.

### Export

```
POST   /api/export
       {
         source: 'tail' | 'search',
         sessionId | jobId,
         seqFrom?, seqTo?,          // tail: the selected range
         levels?[], query?,          // extra filters
         format: 'log' | 'json' | 'csv',
         includeContinuation: boolean
       }
       → { exportId, estimatedBytes }

GET    /api/export/:exportId/download   → streamed response, discarded immediately after
```

- No temporary file is written to server disk. Stream straight out of the buffer.
- Over `EXPORT_MAX_BYTES`, return 400 with a "narrow the range" message.
- `format: 'log'` is raw lines. `json` is an array of `LogEntry` (JSONL). `csv` is
  `ts,level,pod,thread,logger,message`.

**Every exported file starts with a provenance header** (a comment line for `log`/`csv`,
the first object for `json`):

```
# AEM Cloud Log Viewer export
# org=acme  program=12345  environment=67890 (prod)  service=publish  log=aemerror
# range=2026-08-28T14:00:00+09:00 ~ 2026-08-28T14:30:00+09:00 (KST)
# filters=level:ERROR  query:"NullPointer"
# masked=true  lines=1284
# exported by shin@example.com at 2026-08-28T15:02:11+09:00
```

The point is that nobody is confused days later about where the file came from. The
filename follows a fixed rule too:

```
{orgKey}-p{programId}-e{envId}-{service}-{logName}-{fromYYYYMMDDTHHmm}_{toHHmm}.log
```

### Administration

```
GET    /api/admin/users
POST   /api/admin/users          { email, displayName, role, orgs: [{key, allowProd}] }
                                 → returns a temporary password once, in the response. Never stored.
PATCH  /api/admin/users/:id      { displayName?, role?, isActive?, orgs? }
POST   /api/admin/users/:id/reset-password  → returns a new temporary password once
DELETE /api/admin/users/:id
GET    /api/admin/audit?from&to&userId&action&orgKey&limit&offset
```

---

## 8. Authentication and authorization

### Sign-in

- Administrator-issued accounts only. **No sign-up endpoint is built.**
- On first boot, if `users` is empty, create one administrator from `.env`'s
  `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` with `must_change_password = 1`, and print a
  notice to the console. Later boots never take this path.
- Passwords are argon2id, minimum 12 characters.
- While `must_change_password` is 1, every API except the password change returns 403.
- Failed sign-ins are rate limited per email: 5 attempts per 5 minutes. Both success and
  failure go in `audit_log`.

### Sessions

- `httpOnly`, `SameSite=Strict`, `Path=/`. Since running over local HTTP is the default,
  `secure` is toggled by an environment variable.
- Cookies ride along on SSE automatically. That is why WebSocket is not used.
- Sessions survive a server restart (stored in SQLite). Expired ones are cleaned at boot
  and hourly.

### Authorization checks (on every data route)

```
1. Is the session valid
2. Is the request's orgKey in user_orgs          → if not, 404 (not 403; do not leak existence)
3. Is the target environment prod                → if so, check user_orgs.allow_prod
4. Does (orgKey, envId) match in env_cache       → blocks passing another org's environment ID
5. Record in audit_log
```

Step 3 is separate because customer prod logs carry real end-user data. Organization
access and prod access have to be distinct.

---

## 9. Frontend

### Screens

```
/login                sign-in
/                     environment picker (org → program → environment → service/log)
/tail/:sessionKey     live tail
/search               time-range search
/admin/users          user management (admin only)
/admin/audit          audit log (admin only)
```

**AppShell structure**

- Header: current organization and environment on the left, account menu on the right.
  **Distinguish environment type by color** — dev neutral gray, stage blue, **prod in
  reds**. Seeing at a glance that you are looking at prod reduces mistakes.
- Navbar: organization → environment tree. Mark prod once more with an icon.
- Main: the log view.

### The log viewer component

The most important component. Put the effort here.

- **Virtual scrolling is mandatory.** Painting 50k lines into the DOM kills the browser.
  Use `@tanstack/react-virtual`. Row height varies (expanded stack traces), so use
  `measureElement`.
- **Follow and pin.** While pinned to the bottom, follow new logs; when the user scrolls
  up, stop following and show a "N new lines — jump to bottom" button. Basic manners for
  a log viewer.
- **Line rendering:** time (monospace, dimmed) / level badge / logger (abbreviated, full
  on hover) / message. Stack traces collapsed, expanded on click.
- **Level colors:** one strong accent, for ERROR only. WARN in between. INFO/DEBUG almost
  the same tone as the background. If every line in a log viewer is colorful, nothing
  stands out. Spend the emphasis on ERROR alone.
- **Range selection:** click the first line, Shift+click the last. The range highlights
  and an action bar appears below: "N lines selected · Export". **This is the signature
  interaction of the tool.** Not downloading a whole file, but looking and taking exactly
  what you need.
- **Highlight search:** instant filtering within the buffer. Regex toggle.
- **Pause:** freeze the view. Server polling continues, so resuming brings in the backlog.

### Time-range search screen

- Two `DateTimePicker`s from `@mantine/dates`. Offer preset buttons ("last hour", "last 6
  hours", "yesterday").
- **The default level selection is ERROR.** That is what this screen is for.
- During a scan, show a `Progress` bar while results fill in progressively. Keep a cancel
  button visible at all times.
- Results reuse the same component as the tail viewer. Range selection and export behave
  identically.

### Mantine v7 + Pretendard setup

Mantine v7 does not use Emotion. Import `@mantine/core/styles.css` **at the very top**.

```bash
npm i @mantine/core @mantine/hooks @mantine/dates @mantine/notifications dayjs
npm i pretendard @fontsource/jetbrains-mono
```

```ts
// web/src/main.tsx — import order matters
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

const slate: MantineColorsTuple = [/* 10 steps */];

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

**Dark mode is the default.** This is a tool you stare at logs in for a long time. Light
mode should work, but the default is dark.

### Design direction

The character of this tool is "an instrument panel that replaces a terminal". No decoration.

- Tight spacing, high information density. As many lines on screen as possible.
- Color only carries state. Environment type (dev/stage/prod) and log level (ERROR) —
  everything else is achromatic.
- Animation only for scroll following and collapse/expand. No effort into loading skeletons.
- Empty states say what to do next. Not "no logs" but "no ERROR in this environment in
  the last hour. Widen the level or change the time range."
- Button text says what actually happens. Not "Submit" but "Export selection".

---

## 10. Build order

Each phase has to work on its own. Building everything and wiring it up at the end is
forbidden.

**Phase 0 — verification (before writing code)**
Check the following against one real environment and record the result in
`docs/findings.md`. What comes out of this can change the design that follows.
1. The expiry of the 302 Location URL returned by `logs/download`
2. **Does the current day's file come gzipped or plaintext** — if gzipped, Range byte
   offsets cannot be partially decoded and the tail strategy has to be rethought. This is
   the most important item
3. Does the signed URL answer a `Range` header with `206 Partial Content`
4. How long until a new log actually shows up (measure several times, take the median)
5. The real response schema of `logs?days=N`

**Phase 1 — skeleton**
`.env` loader + zod validation, SQLite schema and migrations, Fastify boot, first-admin
seeding, sign-in/sign-out/sessions, a minimal sign-in screen. At this point you can sign
in and see an empty screen.

**Phase 2 — Adobe integration**
IMS token cache, Cloud Manager client, program and environment lookup into `env_cache`,
the environment picker. At this point the per-organization environment tree is visible.

**Phase 3 — tail**
Parser + masking + unit tests (multiline stacks, chunk boundaries, **UTC rollover**), the
`TailSession` polling loop, the SSE route, the virtual-scrolling viewer, follow mode.
This is half the project.

**Phase 4 — search and export**
Time-range scan jobs, progress over SSE, the search screen, the range-selection
interaction, export in three formats, the provenance header.

**Phase 5 — operations**
User management screen, audit log view, prod access separation, saved filters, README.

---

## 11. Open questions

If you hit one of these during implementation, record it and ask rather than deciding
unilaterally.

- **Whether the current day's log file is compressed** (checked in Phase 0). If gzipped
  there are two options — (a) download the whole thing each poll, decompress, and take
  the delta (expensive in bandwidth), or (b) lengthen the poll interval, fetch only the
  last N bytes, and attempt partial decompression. Decide based on the finding.
- The exact Cloud Manager API rate limits. Put in exponential backoff that honors
  `Retry-After` on 429, and learn the real limit by observation.
- The shape of the service list for environments with Additional Publish Region enabled.
  Check whether regions arrive as separate entries and reflect that in the UI.
- The response shape for environments with no `preview` service.

---

## 12. Acceptance criteria

- [ ] Registering two organizations in `.env` shows both organizations' environments after sign-in
- [ ] Running without `.env` exits immediately, naming the missing value
- [ ] No client secret appears in an HTTP response, the frontend bundle, the DB or any log (verified by grep)
- [ ] An account holding only org A gets a 404 when calling org B's environment ID directly
- [ ] An account without `allow_prod` is refused a prod environment tail
- [ ] Scrolling stays smooth on a tail screen holding 50k lines
- [ ] Scrolling up during follow mode stops it; returning to the bottom resumes
- [ ] Logs do not break across UTC midnight (tested with a mock clock)
- [ ] Stack traces fold into one entry with working collapse/expand
- [ ] Masking is applied in exported files
- [ ] Exported files record organization, environment, range, filters and requester at the top
- [ ] Export requests over 500MB are refused with an explanation
- [ ] Sign-in, tail start, search and export all land in `audit_log`
- [ ] Restarting the process loses log bodies but keeps accounts, config and audit records

---

## 13. Notes to the implementer

This section was originally addressed to Claude Code, which wrote the implementation.

- **Do Phase 0 first and report the result before moving to Phase 1.** In particular, do
  not write the tail logic before confirming whether files are gzipped.
- Write tests for the parser and the rollover logic first. Bugs in those two places are
  quiet and get found late.
- When adding a dependency, leave a one-line reason. This is a personal tool to be
  maintained for a long time, so fewer dependencies is better.
- If you feel tempted to simplify the Range polling structure in section 6, remember that
  it is the reason this tool exists. If you are writing code that downloads a whole file,
  you have gone the wrong way.
