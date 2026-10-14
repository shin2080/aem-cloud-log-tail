# Security

This tool holds two things worth protecting: **Cloud Manager client secrets** for every
organization in `.env`, and **production log lines** — with real end-user data in them —
in memory while someone is watching. Please treat reports accordingly.

## Reporting a vulnerability

Use GitHub's private reporting: **Security → Report a vulnerability** on this repository.
That keeps the details out of public issues until a fix is available. Please do not open
a public issue for anything that could expose log data or credentials.

Include what you can: the version (shown in the account menu), how to reproduce, and
what an attacker gains. A proof of concept against your own instance is welcome; please
do not test against instances you do not run.

This is a one-person project. You will get an acknowledgement as soon as I see the report
and an honest estimate after that — there is no SLA, but credential or log-data exposure
goes to the front of the line.

## Supported versions

Only the latest `1.x` release receives fixes. The server tells admins when a newer
release exists; upgrading is `git pull && npm install && npm run build` and a restart.

## In scope

- Authentication or authorization bypass — reading an organization or a prod environment
  without the grant, acting after a session was revoked, admin actions as a member
- Log data reaching disk or another user: the ring buffer, exports, the service worker
  cache, alert tables, or anything else that should hold only hashes or counters
- Masking bypass for the categories the README says are masked (IPs, emails, national
  IDs, card numbers, bearer tokens)
- Injection through log content — a crafted log line that executes in the viewer, breaks
  out of a cell in CSV export, or crashes the parser for everyone
- SSRF or credential leakage through the Cloud Manager / IMS client, including anything
  that would send a secret somewhere other than Adobe

## Out of scope

- Anything that requires a compromised host. The design assumes the machine running the
  server is trusted: `.env` is plaintext by intent, and the README says not to run the
  server on a shared display machine
- Exposure caused by binding to `0.0.0.0` or the internet without TLS. The README's
  access section explains the trade-offs; the default binding is loopback only
- The login rate limit being per process. It is documented, and the fix (a shared store)
  is out of proportion for a single-process tool
- Masking gaps the README already lists as not covered (Korean mobile numbers, names,
  addresses, unprefixed JWTs, customer-specific identifiers). Pull requests adding rules
  are welcome, but these are not vulnerabilities

## What this project does on its own

- The server contacts GitHub once a day to check for a newer release. Nothing else leaves
  the host except calls to Adobe. `UPDATE_CHECK=false` turns the check off
- Dependencies are kept minimal and `npm audit --omit=dev` is run before each release;
  see `docs/dependencies.md` for why each one is there
