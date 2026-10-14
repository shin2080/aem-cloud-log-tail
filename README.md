# AEM Cloud Log Viewer

**English** · [한국어](README.ko.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)

A locally run log viewer for AEM as a Cloud Service.

Follow logs from several organizations and environments (dev/stage/prod) live on one
screen, dig through past time ranges, and save just the slice you need to a file.

Reading logs in the Adobe Cloud Manager web UI means clicking a download link, getting
a `.gz`, unpacking it, and opening it in an editor — over and over. This tool removes
that round trip: watch the log stream in the browser and take only what you picked out
by eye.

> **This is not an official Adobe tool.** It is a personal project, unaffiliated with
> Adobe. It only **reads** from the Cloud Manager API.

## What it does

- **Live tail** — streams logs per environment and service over SSE. Level filter, search, pause
- **Time-range search** — scans a past window (up to 7 days, Adobe's retention limit) and collects only the matching lines
- **Split panes** — up to four side by side: author, publish, dispatcher of the same environment
- **Grouping** — folds hundreds of identical exceptions into one line
- **Export** — only the range you selected, as log/json/csv, with provenance stamped at the top of the file
- **Alerts** — register a pattern and it keeps watching even when nobody is looking
- **Masking** — emails, tokens, card numbers, national ID numbers and public IPs are redacted before they reach the buffer
- **Accounts and an audit log** — org and prod access are granted per account, and who looked at what is recorded
- **Installable (PWA)** — open it without browser chrome and leave it on a monitor
- **Korean / English**

### Rules this is built on

This tool handles **client secrets for several organizations** and **real end-user data
in prod logs**. The design follows from that, and these are what we come back to when a
judgment call is close.

1. **Logs are never persisted** — the DB holds config, accounts and audit records only. Log bodies live in an in-memory ring buffer
2. **Local first** — binds `127.0.0.1` by default, and the DB is a single SQLite file
3. **Read only** — no code that calls a Cloud Manager write API goes in here
4. **Credentials live in `.env` only** — exactly two files touch `clientSecret`: `server/config/env.ts` and `server/adobe/ims.ts`
5. **Org boundaries are enforced server-side** — the org identifier the frontend sends is never trusted

Design background is in [SPEC.md](SPEC.md) (Korean), and measurements against a real
environment are in [docs/findings.md](docs/findings.md).

---

## Requirements

- **Node.js 20 or newer**
- **Adobe Cloud Manager access** — see [Creating Adobe credentials](#creating-adobe-credentials) below
- macOS / Linux / Windows. Native modules (`better-sqlite3`, `@node-rs/argon2`) are in
  the dependency tree, so `npm install` may need build tooling

## Quick start

```bash
git clone <this repository>
cd aem-cloud-log-tail
npm install
cp .env.example .env
```

Open `.env` and fill in at least three things.

```bash
openssl rand -hex 32     # put the result in SESSION_SECRET
```

| Setting | Value |
|---|---|
| `SESSION_SECRET` | output of the command above |
| `ADMIN_EMAIL`, `ADMIN_INITIAL_PASSWORD` | the first administrator (password at least 8 characters) |
| `ORG_1_*` | at least one organization — created in the next section |

Then:

```bash
npm run build
npm start
```

http://127.0.0.1:7300 opens. On first boot the administrator account is created and the
console tells you so. Signing in with `ADMIN_EMAIL` and `ADMIN_INITIAL_PASSWORD`
**forces a password change.** After that, delete `ADMIN_INITIAL_PASSWORD` from `.env` —
it is only ever used on first boot.

If a value is missing or malformed, the server **says what is wrong and why, then exits
immediately.** It will not come up half-configured and fail later.

---

## Creating Adobe credentials

This is where people get stuck most often, so it gets its own section. Do it once per
organization.

### 1. Create a project in the Developer Console

1. Sign in at [developer.adobe.com/console](https://developer.adobe.com/console).
   **Check the organization in the top right** — if you belong to several, this is where
   it usually goes wrong.
2. **Create new project**
3. **Add API** → pick **Cloud Manager**
4. For authentication pick **OAuth Server-to-Server**
   (JWT was retired in 2025; this tool does not support it)

### 2. Pick a product profile

After adding the API you are asked to pick a product profile. **Cloud Manager -
Developer** or anything above it (Deployment Manager, Business Owner) works. Reading
logs needs only these three calls, and the Developer profile has all of them.

```
GET /api/programs                                          list programs
GET /api/program/{id}/environments                         list environments
GET /api/program/{id}/environment/{id}/logs?days=N         log files and links
```

**No write permission is needed.** There is no code in this repository that touches
deployments or pipelines.

### 3. Copy four values into `.env`

They are on the project's **Credentials → OAuth Server-to-Server** screen.

```dotenv
ORG_1_KEY=acme                      # an identifier you choose. Read the warning below
ORG_1_LABEL=ACME Corporation        # the name shown in the UI
ORG_1_IMS_ORG_ID=XXXXXXXX@AdobeOrg  # Organization ID from Credential details
ORG_1_CLIENT_ID=...                 # Client ID
ORG_1_CLIENT_SECRET=...             # Client Secret (Retrieve client secret)
ORG_1_SCOPES=openid,AdobeID,...     # the scope string shown on screen
```

Copy `ORG_n_SCOPES` **exactly as displayed.** The Developer Console shows it as
`openid, AdobeID, read_organizations, ...` with a space after each comma, and IMS
rejects those spaces. This tool strips them while reading, so pasting as-is is fine.

To add more organizations, continue with `ORG_2_*`, `ORG_3_*`. Scanning stops at the
first empty `ORG_n_LABEL`.

> **Once you pick `ORG_n_KEY`, do not change it.** It joins against `user_orgs.org_key`
> in the DB. Changing it severs every existing account's access to that organization.
> Swapping only the credentials is risky too — the cached environment list still belongs
> to the old organization while calls go out with the new credentials, and Adobe answers
> 403. (A fingerprint is recorded so the cache refetches itself, but change the key as
> well if you can.)

### 4. Verify the connection

```bash
npm run phase0 -- --org acme
```

`--org` takes an `ORG_n_KEY` value from `.env`; omit it to use the first organization.
It fetches a token, walks programs and environments, checks the log links, and
overwrites `docs/findings.md` with the result. If this fails, the UI will fail too.

---

## Using it

### Picking a log

After signing in you get the **environment list**. If you have several organizations,
switch between them with the buttons at the top.

If the list is empty, press **Refresh from Cloud Manager**. The environment list is
cached for 30 minutes — fetching it every time costs dozens of calls just to open one
organization, which runs into rate limits.

**Check services** on an environment row shows which logs that environment actually has.
The log name button opens a **live tail**; the `⌕` next to it opens a **time-range
search**.

### Live tail

- Set the **level** (ERROR / WARN+ / all / pick your own) and a **search term** in the
  header. Turn on `.*` to read the term as a regex
- **Pause** freezes the view and counts what arrived on the button. Polling keeps running
- While you are at the bottom it follows new lines; scroll up and it stops and shows a
  "N new lines" button
- The number on the right of the header is lines in the buffer; next to it is the **age
  of the newest log**. Past three minutes it changes color — either there is no traffic
  or the pipeline is behind

Logs live **in memory only**. The ring buffer holds 20,000 lines / 32MB per session, and
anything beyond that is pushed out oldest-first. The UI tells you when that happens.
Bookmark a line to hold on to it.

### Time-range search

Pick a range at the top and press **Search**. Presets are 5min / 10min / 30min / 1h / 6h / 24h.

**Picking 10 minutes or less warns you that "the last 2 minutes may still be empty."**
Logs take about two minutes to reach storage, measured. Over a short range most of the
window is time that has not arrived yet, and an empty result is easy to mistake for a
broken tool.

- Adobe **keeps only seven days.** If your range falls outside that, it says so
- Results stop at 200,000 lines. Narrow the range
- Between midnight and 09:00 KST you need **the previous UTC file**. This is handled for you

### Exporting a selection

Click a line to set the start, then **Shift + click** to set the end and select a range.
This is the core interaction of the tool — instead of downloading a whole file, you look
and take only what you need.

A bar appears below the selection. **Copy** goes to the clipboard (for Slack or an
issue); **Export selection** writes a file.

| Format | Contents |
|---|---|
| `log` | raw lines, as they came |
| `json` | JSONL — one `LogEntry` per line |
| `csv` | ts, level, pod, thread, logger, message |

The top of the file records **organization, environment, range, filters and requester**,
so whoever receives it days later can tell where it came from. Masking is already applied.

Export pulls from the **server ring buffer**, not from the screen. The screen only
accumulates what passed the level filter, so lines the server has already dropped can
linger on screen for a long time. When fewer lines will be written than you selected,
the dialog **tells you how many before you download** — a file that silently disagrees
with the screen is a problem days later, when you are using that file as evidence.

---

## Supported logs

Only logs with a parser can be opened, and only those appear in the list.

| Service | Logs |
|---|---|
| author / publish | `aemerror` `aemaccess` `aemrequest` |
| dispatcher | `aemdispatcher` `httpdaccess` `httpderror` |
| cdn | `cdn` |

`aemerror` and `httpderror` **fold stack traces into a single entry.** For the rest, one
line is one entry. The access logs have no level, so one is **derived from the HTTP
status** — 5xx is ERROR, 4xx is WARN.

## Masking

Applied **before the buffer**. Nothing unredacted reaches the screen, an export or the
clipboard. You can turn it off with `MASKING_ENABLED=false`, but leave it on if you are
looking at prod.

Emails · Bearer tokens · Basic auth · password-ish query parameters · card numbers ·
Korean national ID numbers · public IPs (private ranges are left alone).

Several false-positive guards came out of real logs — 13-digit epoch milliseconds read
as a national ID, a JSON decimal read as a card number, and a browser version like
`Chrome/152.0.0.0` read as an IP. That last one put a `masked` badge on nearly every
access line, because access logs carry a user agent on every line — and once the badge
is meaningless, you stop noticing the lines where something real was redacted.

If you touch the rules, read `server/parse/mask.test.ts` alongside them. The boundary
between `Word/1.2.3.4` (a version) and `http://1.2.3.4` (a real address) is the subtle part.

---

## Watching several environments at once

Both `/tail` and `/search` take up to four panes via **+ Add pane**.

**A new pane is picked from within the environment you are already looking at** —
publish next to author, dispatcher next to that. The reason to split panes is to follow
one request across tiers of the same environment, so listing other environments here
would only add noise (one real organization has 24 of them). Open a different
environment from the environment list instead.

In time-range search **all panes share the range** — the point of the comparison is "the
same window in a different log," so a per-pane range would defeat it. Level and search
term stay per pane. Pressing `Search` runs every pane together.

- **Level, search and pause are per pane.** Only font size and time zone are shared
- Left/right vs top/bottom is chosen from the window width, and your own choice is remembered
- **The URL is the view state.** `?p=org:env:service:log` maps to one pane, so a refresh
  or a shared link reopens the same combination
- The limit of four exists because browsers pool roughly six connections per host. Each
  pane holds one SSE connection open, so more panes would starve the other API calls

## In the viewer

- **Grouping** — folds identical events into one line with `×N`. Differing numbers and
  UUIDs still count as the same event. It gives the screen back when one exception
  repeats hundreds of times
- **★ Bookmark** — a marked line survives being pushed out of the ring buffer. Since logs
  live only in memory, this is how you hold on to something
- **Time histogram** — level distribution across the whole buffer. Click a bar to jump to
  that moment; it finds "when did it break" far faster than scrolling
- **Saved filters** — name a level/search combination you use often. Works in both tail
  and search

Grouping, bookmarks and the histogram live in the `⋯` menu of the pane header; the header
is narrow, so only the frequently used controls stay outside. Bookmarks persist in the
browser across refreshes — but `seq` restarts at 0 for each server session, so restarting
the server does not light the stars back up. The saved lines themselves remain visible
under "bookmarked only".

## Alerts

Register a pattern and the server keeps reading that log **even when nobody is watching**,
and tells you when it matches.

`⋯` → **Create an alert from this** in a pane header opens the rules screen with the
current target, search term and levels already filled in, so you do not pick the same
conditions twice.

| | |
|---|---|
| **Look for** | a plain substring by default; regex is opt-in |
| **Levels** | only the levels you pick. Empty means all |
| **Re-alert the same event after** | within this window a repeat bumps the count instead of creating a new alert |

Alerts arrive in two places: the **bell** in the header (unread count as a badge, click
for the inbox), and **desktop notifications** (OS toasts) which you enable inside the
bell. Toasts exist for when the window is behind something else — if the screen on your
monitor is covered, a changing badge reaches nobody.

Clicking an alert takes you to **that spot** in that log pane.

### Things to know

**Alerts are 2–3 minutes late.** AEM takes about two minutes to flush logs to storage,
and polling is every 20 seconds. This is not the kind of thing that can be fixed, so the
inbox says it too.

**There is a cap on targets** (`ALERT_MAX_TARGETS`, default 3). One
environment × service × log with a rule on it is a polling loop plus a ring buffer that
runs whether or not anyone is looking. That value × `TAIL_BUFFER_MAX_BYTES` is the memory
alerts hold permanently. Going over the cap is refused when you create the rule — better
than a rule that exists but quietly never runs.

**When a rule turns itself off, it says why.** Access was revoked (rechecked every
minute), the target cap was exceeded, or the pattern is unsafe. The reason shows as a
badge on the rules screen. A rule that goes quiet without explanation means you cannot
even tell that alerts stopped.

**Regexes run on the server.** On the client a bad pattern froze only your own tab; here
one can block polling for every session. So the default is a plain substring, and regexes
are rejected at registration if they have shapes like the nested quantifier `(a+)+`. The
scanned line length is capped too.

**Alert records contain no log text.** `alert_hits` holds the rule, time, count and `seq`.
Even the fingerprint used to tell events apart is hashed — storing it raw would leave a
normalized log message readable in the DB. OS toasts carry only the rule name, which log,
and how many. Toasts persist on lock screens and in notification centers, and show up
during screen sharing.

If the line a `seq` points at has already been pushed out, find it with time-range search.

---

## Korean / English

Switch in the account menu at the top right, and on the sign-in screen. It is in both
places because you must be able to switch before signing in — someone who cannot read
the screen cannot get into the menu.

The first visit follows the browser setting (English unless the browser is Korean), and
your choice is remembered in that browser. `<html lang>` changes with it.

**Server error messages are translated too.** Every request carries `X-Lang` and the
server builds the message in that language. Without the header it answers in Korean, so
poking at it with curl behaves as it always has. The server console and the audit log are
not translated — those are read by whoever runs the server, and there is no reason to mix
languages there.

Log content itself is never translated. That text was written by AEM.

---

## Running accounts

Accounts are issued by an administrator. **There is no sign-up endpoint.**

- Account menu, top right → **Users** / **Audit log** (visible to admins only)
- Issuing an account shows a **temporary password once, on screen**. It is not stored on
  the server, so hand it over right then. If it is lost, issue a new one with "reset password"
- Org access and **prod access are granted separately.** Prod logs carry real end-user
  data. Without prod access, prod environments disappear from the list entirely, and
  passing the ID directly returns 404
- Reducing someone's access **terminates their existing sessions immediately**

The server blocks mistakes you cannot undo — deactivating, demoting or deleting your own
account, and removing the last administrator.

The audit log is **read-only.** No delete API was written. It is not left to grow without
bound either: records older than `AUDIT_RETENTION_DAYS` (default 365) are cleaned up at
boot and once a day. Set it to 0 to keep them forever. The point is that nobody can erase
their traces, so the only path that removes anything goes purely by age.

## Adding an organization

Putting `ORG_n_*` in `.env` is not enough for it to appear. Two more things are needed.

1. **Restart the server.** `tsx watch` only watches `server/`, not `.env`. Confirm with
   `N organizations loaded` in the boot log
2. **Grant it to an account.** `/api/orgs` answers from account access, not from `.env`.
   The initial admin seeding attaches organizations once, when the account is created, so
   an organization added later **has to be checked on in Users**

The environment list surfaces both of these states — organizations that are in `.env` but
not granted, and organizations that are granted but have disappeared from `.env`, each
get their own banner.

---

## Access from outside

The default `127.0.0.1` binding means it only opens on this machine. To reach it from
elsewhere, pick one of three.

Think first about what this tool is holding — **client secrets** for several
organizations, and **real end-user data** in prod logs. Wherever the sign-in screen is
reachable is the exposure of that data.

### 1. Your own devices only (recommended)

Use a mesh VPN like Tailscale. No public IP, no port forwarding, no certificates, nothing
exposed to the internet, and encryption at the network layer.

```bash
tailscale ip -4          # find the 100.x.x.x address
```

```dotenv
HOST=100.x.x.x
```

Reach it from a phone or laptop at `http://100.x.x.x:7300`. Nothing else to do.

### 2. The same office or home network

```dotenv
HOST=0.0.0.0
```

**Every device** on that network can see the sign-in screen. It is plaintext HTTP, so
anyone watching packets on that network sees passwords and session cookies. Use it only
on a network you trust.

### 3. The internet (sharing with a team)

Put a TLS-terminating reverse proxy (Caddy/nginx) in front, and:

```dotenv
HOST=127.0.0.1
SESSION_COOKIE_SECURE=true
TRUST_PROXY=true
```

Keep `127.0.0.1` so only the proxy reaches the app. Turn on `TRUST_PROXY=true` only if
the proxy **overwrites** `X-Forwarded-For` — otherwise the header can be forged and the
audit log's IP lies.

In that case, also consider:

- The login rate limit lives in process memory. It works for a single process, but
  scaling to several instances defeats it
- The minimum password length is 8 (`server/auth/password.ts`). Raise it if this is on
  the internet
- Whether the customer agreed to their prod logs leaving by this route

If the binding is not loopback, the boot log prints what is open and what is missing.

---

## Leaving it on a monitor (PWA)

This was built with leaving it installed on an always-on monitor in mind.

When it is not installed, **a strip appears at the top of the screen** — press `Install`
and it installs. Dismiss it and that is remembered; once installed it disappears on its
own. It does not appear at all where installation is impossible (plaintext HTTP, a
browser with no install path). Better quiet than telling you to do something that cannot
work.

**https is required.** Service workers only run in a secure context, so outside
`localhost` plaintext HTTP cannot install it (everything still works; it just will not
open as an installed app). With Tailscale:

```bash
tailscale cert $(tailscale status --json | jq -r .Self.DNSName | sed 's/\.$//')
```

Then set `SESSION_COOKIE_SECURE=true`.

### What ends up in the cache

The service worker ([`web/public/sw.js`](web/public/sw.js)) caches **the app shell only** —
HTML and content-hashed JS/CSS. It never intercepts `/api/*`.

This is not a convenience, it is what keeps the tool's premise intact. Log bodies are
supposed to live only in memory; if the service worker cached API responses, a customer's
prod logs would sit in plaintext on disk, survive sign-out, and be readable by the next
person on that machine. Workbox's common `runtimeCaching` recipe does exactly that, which
is why this one is hand-written. Signing out clears even the shell cache.

### What changes when it runs continuously

| | Default | Why |
|---|---|---|
| `SESSION_TTL_HOURS` | 12 | An **idle** window. The screen pings the server every 10 minutes and keeps extending it |
| `SESSION_MAX_HOURS` | 168 | The ceiling on extension. At this interval a human has to sign in again |
| `TAIL_BUFFER_MAX_LINES` | 20000 | **Per session.** Four panes each hold this much |
| `TAIL_BUFFER_MAX_BYTES` | 32MB | Same. Left on for a day, this is permanently occupied memory |
| `ALERT_MAX_TARGETS` | 3 | Targets with a rule on them. This many keep running with nobody watching |
| `ALERT_HIT_RETENTION_DAYS` | 30 | How long alert records are kept |

If you want a login that never expires, rather than raising `SESSION_MAX_HOURS`, issue a
**dedicated kiosk account** and do not give it prod access. A permanently signed-in
browser is a permanently valid credential.

### What it survives on its own

- When the server restarts or a session is cleaned up for being idle, log `seq` restarts
  at 0. The screen notices the generation changed, drops what it had and refills — without
  this it sits there saying "connected" while new logs quietly never arrive
- If the view throws while rendering, it shows what happened and refreshes itself
  (backing off if it keeps happening)
- When a new build is deployed the service worker notices and refreshes once. The panes
  you were watching are in the URL, so they come back
- Signed URLs are refetched before they expire, and an error response from an expired URL
  is not mistaken for log content
- Open streams recheck authorization every 15 seconds. Disabling an account or revoking
  org access cuts off panes that are already open. Alert rules recheck the same thing
  every minute
- To have something watched while nobody is looking, set up an [alert](#alerts). To see it
  even when the window is covered, turn on desktop notifications in the bell

### What remains

Everyone walking past the screen is an audience. Masking catches IPs, emails, national ID
numbers, card numbers and Bearer tokens — but there are no rules for Korean mobile numbers,
Korean names and addresses, JWTs without a prefix, or a customer's own identifiers. If
this is going to stay up, fill in [`server/parse/mask.ts`](server/parse/mask.ts) for that
particular log first.

Better not to run the server on the display machine — `.env` holds every organization's
client secret in plaintext.

---

## When something goes wrong

**"Email or password is not correct" on the sign-in screen**
`ADMIN_INITIAL_PASSWORD` is used **on first boot only.** Editing `.env` after the account
exists changes nothing. Deleting `data/app.db` reseeds from scratch, but accounts and
audit records go with it.

**Could not reach the server**
The server is not running. Start it with `npm start` — the app shell is served from the
service worker cache, so the screen looks fine even when the server is down.

**The environment list is empty**
Press **Refresh from Cloud Manager**. If it is still empty, check the credentials first
with `npm run phase0 -- --org <key>`.

**Adobe returns 403**
One of two things. (1) That credential has no access to the environment — check the
product profile in the Developer Console. (2) You kept `ORG_n_KEY` and swapped only the
credentials, so the cached environment list belongs to the old organization — a refresh
clears it.

**I added an organization and it does not show up**
See [Adding an organization](#adding-an-organization). Both a server restart and an
account grant are required.

**The tail opened but nothing arrives**
Either there is no traffic, or no lines match the level you picked. Look at the age of
the newest log in the header. Past three minutes, that environment is getting no requests
at all. Widen the level to "all" to check.

**I created an alert rule and nothing comes**
Check [the delay](#things-to-know) first — 2–3 minutes is normal. If it still does not
come, look at whether the rule is **off** on the rules screen. If it turned itself off,
the reason is on a badge (access revoked / target cap / pattern problem). If it is on and
silent, the levels are usually too narrow — access logs are all INFO, so a rule set to
ERROR/WARN will never match.

**Desktop notifications do not appear**
Open the bell and look at the `Desktop notifications` state. `Blocked` means you have to
allow notifications for this site in browser settings — once refused, the app cannot ask
again. `Off` just needs a click. The in-app bell badge works regardless.

**The search came back empty**
Over a short range the last two minutes may not have arrived yet. Adobe's retention is
seven days, so anything older cannot be read, and the UI names those dates separately.

**Dates look off by a day**
Logs accumulate in UTC. Between midnight and 09:00 KST they are in the previous UTC file.
The UI toggles KST/UTC, and search handles this boundary for you.

**`npm install` fails on a native module**
It builds `better-sqlite3` and `@node-rs/argon2`. macOS may need the Xcode Command Line
Tools, Linux `build-essential`, Windows the Visual Studio Build Tools.

---

## Development

```bash
npm run dev       # server (7300)
npm run dev:web   # Vite (7301, proxies /api to 7300)
```

Open http://127.0.0.1:7301 in the browser.

```bash
npm run typecheck   # server + web
npm test            # unit tests
npm run build       # build into dist/
```

If you edited `.env`, **restart the server.** `tsx watch` only watches `server/`.

### Layout

Source comments are in Korean.

```
server/
  config/env.ts          .env parsing + zod validation + org registry (memory only)
  db/                    Drizzle schema · hand-written migrations
  auth/                  passwords (argon2id) · sessions · rate limit · audit · guards
  auth/adminops.ts       account operations + lockout guards
  auth/session.ts        session issue/resolve + sliding renewal (ceiling: SESSION_MAX_HOURS)
  adobe/ims.ts           IMS token issue and cache (isolated per organization)
  adobe/cloudmanager.ts  read-only API client; reads the 302 Location itself
  adobe/envcache.ts      environment list cache + credential fingerprint
  parse/                 seven log parsers · masking
  alerts/matcher.ts      rule compilation. Regexes run on the server, so they are vetted here
  alerts/watch.ts        follows targets with rules even when nobody looks · noise control
  tail/session.ts        polling loop + ring buffer + UTC rollover + signed-URL refresh
  tail/buffer.ts         ring buffer. Caps on both lines and bytes, evicted in batches
  tail/registry.ts       session ref-counting · idle cleanup
  search/range.ts        search range → UTC date files (early KST hours are the previous day)
  search/scan.ts         streaming .gz scan; never loads the whole file into memory
  export/format.ts       provenance header · filename rules · log/json/csv rendering
  i18n/messages.ts       server error messages (ko/en)
  routes/                HTTP · SSE
web/src/
  components/LogViewer.tsx      virtual scrolling + follow mode
  components/LogLine.tsx        level badge · stack folding · highlighting
  components/TailPane.tsx       one pane = one stream
  components/SearchPane.tsx     one pane = one search job
  components/ErrorBoundary.tsx  shows what broke and refreshes itself
  components/AlertBell.tsx      alert inbox + desktop notification toggle
  components/InstallBanner.tsx  shown only when not installed
  lib/desktopNotify.ts          OS toasts. No log text is included
  lib/logbuffer.ts              client-side caps (lines + size). Counterpart to the server ring buffer
  pwa.ts                        service worker registration · new-deploy detection
  i18n/strings.ts               UI strings (ko/en)
  api/                          SSE subscriptions · REST
  pages/
web/public/
  sw.js                         service worker. Caches the shell only, never touches /api
  manifest.webmanifest          installable app definition
shared/types.ts                 types shared by server and client
shared/signature.ts             "same event" fingerprint. Grouping and alerts use one rule
scripts/phase0-probe.ts         probe against a real environment
scripts/make-icons.ts           PWA icon generation (`npm run icons`)
```

### Editing strings

Two places: `web/src/i18n/strings.ts` and `server/i18n/messages.ts`. `en` is a
`Record<StringKey, string>`, so a missing key fails the type check, and mismatched
placeholders or unused keys are caught by tests.

Numbers like the minimum password length come from the server (`minPasswordLength` in
`/api/auth/me`). Hard-coding them in the UI makes the guidance and the validation drift
apart when the policy changes. There is exactly one place that decides:
`server/auth/password.ts`.

---

## License

[MIT](LICENSE). Use, modify and distribute it freely. No warranty.

A personal project, unaffiliated with Adobe. AEM, Cloud Manager and Adobe are trademarks
of Adobe.

`.env` and `data/` are never committed; they are in `.gitignore`. The program and
environment IDs and the storage account name in `docs/findings*.md` are pseudonyms —
the same shape as real values, but not real.
