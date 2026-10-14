# Phase 0b — investigating the gzip tail strategy

**English** · [한국어](findings-0b.ko.md)

- Run at: 2026-08-28T14:10:18.248Z
- Organization: `acme`
- Target: program=12345 environment=987654 (dev)
- Selected: service=`author` name=`aemerror` date=`2026-08-28`

## A. Investigating the `logs/tail` link ← if this works, neither (a) nor (b) is needed

- tail href: `https://sa012345logshared0a1b2c3d.blob.core.windows.net/log-12345-987654/logs/author_aemerror_2026-08-28.log?<api-version, se, sig, sp, sr, sv>`
- ~~Calling the tail link failed: could not obtain the signed URL (404)~~ ← **this was a probe bug.** See the correction below.

### Correction (2026-08-28, verified by hand)

The 404 was not a permission problem. `resolveSignedUrl()` mistook the tail href for a Cloud Manager path
and requested it against `cloudmanager.adobe.io`. **The tail href is already a signed storage URL.**

Putting the two link paths side by side makes it obvious:

```
download → /log-12345-987654/logs/gzip/author_aemerror_2026-08-28.log.gz   (gzip)
tail     → /log-12345-987654/logs/author_aemerror_2026-08-28.log           (plaintext)
```

Checking that same signed URL directly:

```
HTTP/1.1 206 Partial Content
Content-Type:  application/octet-stream
Content-Range: bytes 0-2047/182820103
Accept-Ranges: bytes
first 3 bytes: 32 38 2e   ("28." — plaintext starting with a date)
aemerror line format matches ✅   level tokens (*INFO* etc.) present ✅
```

### Conclusion: the tail link is **plaintext** ✅

- Plaintext size **182,820,103 bytes (182MB)** vs gzip 8,581,483 bytes. Ratio about 21:1
- In other words, **downloading a whole day is 182MB.** SPEC 6.3 — reading only the last 256KB —
  was designed for exactly this
- The gzip problem is gone. Neither option (a) nor (b) from SPEC section 11 is needed

The bug was fixed in `resolveSignedUrl()` in `server/adobe/cloudmanager.ts`,
with a regression test that distinguishes the two link shapes.

## B. Is the `.gz` multi-member ← if so, SPEC 6.3 survives nearly intact

- File size: 8,581,483 bytes
- Fetch the last 524,288 bytes and look for member boundaries.
- Verified member start offsets: 0 

### Conclusion: **it is a single-stream gzip** ⚠️

No member boundary was found in the tail. A delta fetched by Range cannot be decompressed on its own.
Had the tail link in A not been plaintext, we would have had to pick between (a) and (b) in SPEC section 11.

## C. Growth rate — the cost if option (a), full re-download, were chosen

Wait 60 seconds and measure again.
```
  before: 8,581,483 bytes
  after:  8,581,483 bytes
  growth: 0 bytes / 60s
```
- The file did not grow during the measurement. Rerun during a busier window or environment.
- `--wait 300000` lengthens the wait.

## Decisions

- [x] **A is plaintext → go with the tail link.** SPEC 6.3 applies as written
- [ ] ~~B is multi-member → decompress per member~~ (single stream, but no longer relevant)
- [ ] ~~Choose between (a) and (b) in SPEC section 11~~ (not applicable)

### Rules Phase 3 follows

```
tail link (plaintext) → live tail. Range polling. SPEC 6.3 as written
download link (.gz) → time-range search (Phase 4). Only for streaming a whole day.
                      Pipe it through gunzip; no partial decompression needed
```

Things to watch:

- The tail signed URL is **inside** the `logs?days=N` response. Refreshing it means calling
  that endpoint again, which consumes the Cloud Manager rate limit.
  The TTL is 24 hours though, so once a day is enough. **Never call it on every poll.**
- Range polling itself goes straight to Azure Blob and is unrelated to the rate limit. Keep this structure.
- At UTC midnight rollover a tail URL for the new date is needed, so call `logs?days=1` again then.
- The file is 182MB. On first entry, always honor the rule of reading only `TAIL_INITIAL_BYTES` (256KB).

## Re-measuring C

Being a dev environment, the file did not grow in 60 seconds. The propagation delay (item 4 of SPEC Phase 0)
is still unmeasured. Now that the tail URL is plaintext, the Phase 0 probe can measure it —
rerun it during a busier window. The 5-second poll interval stays the default until then.
