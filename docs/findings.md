# Phase 0 verification results

**English** · [한국어](findings.ko.md)

- Run at: 2026-08-28T14:53:41.844Z
- Organization: `acme` (ACME Corporation)
- Samples: 8, polling interval: 5000ms

## 0. IMS token

- OK. Issued in 285ms (the token value is never recorded)
- 1 program: 12345(Example-Program)
- 4 environments: 987654(example-dev/dev), 987655(example-rde/rde), 987656(example-stage/stage), 987657(example-prod/prod)
- Target: program=12345 environment=987654 (dev)

## 5. Real response schema of `logs?days=1`

```json
{
  "_links": {
    "http://ns.adobe.com/adobecloud/rel/program": {
      "href": "string",
      "templated": "boolean"
    },
    "self": {
      "href": "string",
      "templated": "boolean"
    }
  },
  "_embedded": {
    "downloads": [
      {
        "_links": {
          "http://ns.adobe.com/adobecloud/rel/logs/download": "…",
          "http://ns.adobe.com/adobecloud/rel/logs/tail": "…"
        },
        "service": "string",
        "name": "string",
        "date": "string",
        "programId": "number",
        "environmentId": "number"
      },
      "…(32 entries)"
    ]
  },
  "service": [],
  "name": [],
  "days": "number"
}
```

Parsed options:
```
  service=author name=aemaccess date=2026-08-28
  service=author name=aemaccess date=2026-08-27
  service=author name=aemerror date=2026-08-28
  service=author name=aemerror date=2026-08-27
  service=author name=aemrequest date=2026-08-28
  service=author name=aemrequest date=2026-08-27
  service=author name=cdn date=2026-08-28
  service=author name=cdn date=2026-08-27
  service=dispatcher name=aemdispatcher date=2026-08-28
  service=dispatcher name=aemdispatcher date=2026-08-27
  service=dispatcher name=httpdaccess date=2026-08-28
  service=dispatcher name=httpdaccess date=2026-08-27
  service=dispatcher name=httpderror date=2026-08-28
  service=dispatcher name=httpderror date=2026-08-27
  service=preview_dispatcher name=aemdispatcher date=2026-08-28
  service=preview_dispatcher name=aemdispatcher date=2026-08-27
  service=preview_dispatcher name=httpdaccess date=2026-08-28
  service=preview_dispatcher name=httpdaccess date=2026-08-27
  service=preview_dispatcher name=httpderror date=2026-08-28
  service=preview_dispatcher name=httpderror date=2026-08-27
  service=preview_publish name=aemaccess date=2026-08-28
  service=preview_publish name=aemaccess date=2026-08-27
  service=preview_publish name=aemerror date=2026-08-28
  service=preview_publish name=aemerror date=2026-08-27
  service=preview_publish name=aemrequest date=2026-08-28
  service=preview_publish name=aemrequest date=2026-08-27
  service=publish name=aemaccess date=2026-08-28
  service=publish name=aemaccess date=2026-08-27
  service=publish name=aemerror date=2026-08-28
  service=publish name=aemerror date=2026-08-27
  service=publish name=aemrequest date=2026-08-28
  service=publish name=aemrequest date=2026-08-27
```

Selected: service=`author` name=`aemerror` date=`2026-08-28`

## 1. Expiry of the 302 Location signed URL

- URL shape: `https://sa012345logshared0a1b2c3d.blob.core.windows.net/log-12345-987654/logs/gzip/author_aemerror_2026-08-28.log.gz?<api-version, se, sig, sp, sr, sv>`
- Expires: 2026-08-29T14:53:50.000Z → **about 86400s (1440.0 min)** from issue
- → Use 80% of that as the refresh threshold.

## 2. Is the current day's file gzipped or plaintext ← the key question

The `logs?days=N` response has two links pointing at different files. Check both.

- download: `https://sa012345logshared0a1b2c3d.blob.core.windows.net/log-12345-987654/logs/gzip/author_aemerror_2026-08-28.log.gz?<api-version, se, sig, sp, sr, sv>`
- tail:     `https://sa012345logshared0a1b2c3d.blob.core.windows.net/log-12345-987654/logs/author_aemerror_2026-08-28.log?<api-version, se, sig, sp, sr, sv>`

- HTTP 206
- `Content-Type`: application/octet-stream
- `Content-Encoding`: (none)
- `Content-Range`: bytes 0-1023/8584150  → total size 8,584,150 bytes
- First 2 bytes: 1f 8b ← gzip magic (1f 8b)

### The download link is **gzipped**

Range requests cannot partially decode this file, so it is not used for live tail.
It is only for Phase 4's time-range search, which streams a whole day.
Live tail uses the plaintext file in 2b below.

## 2b. The tail link — the file live tail actually uses

- HTTP 206, `Accept-Ranges`: bytes
- First 3 bytes: 32 38 2e 
- Total size: **183,247,656 bytes** (21.3× the 8,584,150-byte compressed copy)

### It is plaintext ✅ SPEC 6.3 applies as written

## 3. Range support on the signed URL

- `Range: bytes=0-1023` → HTTP **206** (206 Partial Content — supported)
- `Accept-Ranges`: bytes
- Tail `Range: bytes=8580054-` → HTTP **206**, 4096 bytes received
- Past end of file `Range: bytes=8584150-` → HTTP **416** (usable as the "no new data" signal)

## 4. Delay before new logs appear

Read the end of the plaintext tail file 8 times at 5000ms intervals and measure the gap between the newest line's timestamp and the observation time.

```
  sample 1: no new lines
  sample 2: no new lines
  sample 3: no new lines
  sample 4: no new lines
  sample 5: 122.2s
  sample 6: no new lines
  sample 7: no new lines
  sample 8: no new lines
```
- **Median 122.2s** (1 of 8 samples)
- → A 5000ms poll interval is excessive relative to that delay. It can be raised.

## Decisions needed


- [x] Tail strategy: Range polling against the plaintext file from `logs/tail` (settled in Phase 0b)
- [ ] Tune `TAIL_POLL_INTERVAL_MS` to the median delay from section 4

---

# Measurements under real traffic (2026-08-28, dev / author / aemerror)

Measured while traffic was flowing. These three settled `TAIL_POLL_INTERVAL_MS`.

## 1. Does the parser hold against reality → **yes**

Fed the last 177 lines to the SPEC regex.

```
SPEC regex matches: 177/177 (100.0%)
Parser level distribution: { INFO: 148, WARN: 28, ERROR: 1 }
UNKNOWN ratio: 0.0%
```

The regex in SPEC 6.4 matches reality exactly. Nothing to fix in the parser.

## 2. Flush interval → **about 60s**

Watched the file size every 3 seconds for 4 minutes.

```
  + 12s    3,116 bytes
  + 70s   42,386 bytes
  +131s      232 bytes

Data arrived on 3 of 79 polls (4%)
Flush interval: min 58s / median 61s / max 61s
Average 15,245 bytes per flush
```

Logs do not flow continuously. **They are written to the blob in bursts, roughly every 60 seconds.**
The interval is very regular at 58–61s.

## 3. Propagation delay → **about 120s**

Gap between the newest entry in the file and the observation time:

```
Newest entry:      2026-08-28T14:53:14.107Z
Observed at:       2026-08-28T14:55:20.714Z
Difference: 126.6s
```

The probe's sampled measurement also gave 122.2s. The two methods agree.

**This is Adobe-side pipeline delay; polling more often does not reduce it.**

## Decision: `TAIL_POLL_INTERVAL_MS` 5000 → **20000**

- With a 60s flush cycle, 11 of every 12 five-second polls return 416
- At 20s we check three times per flush. Detection latency grows by about 10s on average,
  but adding 10s to something already 120s behind is not perceptible
- Request count drops to a quarter

Polling goes straight to Azure Blob, so it is unrelated to the Cloud Manager rate limit.
Still, no reason to make twelve times as many wasted trips.

## What this changed in the UI

With a two-minute pipeline delay, an error you just triggered is legitimately absent from the screen.
Without knowing that, it looks like the tool is broken. The toolbar shows **"newest N seconds ago"**,
turning yellow past three minutes to signal that traffic stopped or the pipeline is behind.

## Not yet examined

- `preview_publish` and `publish` had no traffic during this window (zero growth).
  Whether they behave differently from author is unconfirmed.
- Additional Publish Region environments remain unexamined.

## 4. Running TailSession against the real environment

The production code path, unmodified.

```
start() 4533ms — read only 256KB out of a 183MB file (offset 183,749,357)
buffer: 754 entries
levels: { INFO: 646, WARN: 103, ERROR: 4, UNKNOWN: 1 }
UNKNOWN: 1 (0.1%)    ← first line truncated by starting mid-file. Expected
entries with folded stack traces: 2 (longest 7 lines)
masked entries: 11
newest entry: 173s ago

poll 1 (+20s): +0 entries, offset unchanged  ← between flushes
poll 2 (+20s): +3 entries, +759 bytes        ← a flush landed
buffer after stop(): 0 entries
```

The 60-second flush cycle shows up directly in the polling results.

## 5. A masking false positive — found in real data

Ran the rules over 1,134 lines.

| Rule | Hits | Verdict |
|---|---|---|
| `email` | 11 lines (1.0%) | Correct. `y***@example.com` — a real email |
| `credit-card` | 1 line (0.1%) | **false positive** |

The false positive:

```
"type":"KEY_PHRASE","confidence":0.****-****-****-3973
```

In `"confidence":0.1234567890139730`, **the fractional part passed Luhn** and was redacted as a card number.
`\b` sets a boundary after the decimal point, so the fraction is caught as a standalone digit run.

The synthetic tests had no JSON decimals, so this only surfaced against real data.

**Fix**: both the card and national-ID rules now skip when a digit, decimal point or comma is adjacent
(`(?<![\d.,])` / `(?![\d.,])`). Three regression tests were added; after the fix the false positive is gone and
only the 11 email hits remain.
