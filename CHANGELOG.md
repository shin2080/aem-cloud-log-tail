# Changelog

Release notes are taken from this file by the release workflow: the section whose
heading matches the tag (`## 1.1.0` for `v1.1.0`). A version without a section gets
GitHub's generated notes instead.

## 1.0.0

First public release.

### What it does

- Live tail of AEM as a Cloud Service logs — author, publish, dispatcher and CDN — through
  the Cloud Manager API, read with HTTP Range requests so a 180MB day file is never
  downloaded whole
- Time-range search over a day's log, streaming gzip, with a 200,000-line stop
- Up to four panes side by side; the URL is the view state, filters included, so a link
  or a refresh reopens the same thing
- Click a line's pod or thread to follow one request; Shift+click the distribution to
  move every pane to the same moment
- Range selection with copy and export (log, JSONL, CSV), with provenance headers
- Masking of IPs, emails, national IDs, card numbers and bearer tokens before anything
  reaches the browser
- Grouping of repeated events, bookmarks that survive buffer eviction, time distribution
- Log-pattern alerts with desktop notifications; the watcher keeps polling when nobody
  is watching, within a fixed target cap
- Installable PWA meant to stay on a monitor, with a hand-written service worker that
  never caches log data and reconnects on its own when a stream drops
- Accounts with argon2id, sliding sessions, per-request authorization, audit log
- Korean and English UI

### Operational notes

- Logs live in memory only. The SQLite file holds accounts, sessions, audit and alert
  rules, nothing from the logs themselves
- The server checks GitHub once a day for a newer release and tells admins in the
  account menu. `UPDATE_CHECK=false` turns it off
