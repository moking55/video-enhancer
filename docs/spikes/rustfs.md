# Spike T2: RustFS presign / CORS (real endpoint)

Date: 2026-10-14. Endpoint host `<rustfs-host>`, bucket `video-enhancer`, prefix `spike/` only (all test objects deleted).
Script: `web/scripts/rustfs-smoke.ts`. Run from `web/`:

```
npx -y tsx --conditions=react-server --env-file=.env.local scripts/rustfs-smoke.ts
```

`--conditions=react-server` turns the `server-only` import in `lib/storage.ts` into a no-op, so the script reuses `presignPut/presignGet/headObject/deleteObjects` unchanged. Only the cleanup listing (`ListObjectsV2`) uses an extra S3Client with identical options. No secrets or signed URLs are printed.

## Server identification

The `Server` response header is `cloudflare`; there is no `x-amz-request-id` and no RustFS version header. The endpoint is a Cloudflare-proxied hostname (HTTP/2, `connection: close` on some responses, `x-served-by: <rustfs-host>`). The RustFS version is not observable from outside; the user must report it (RustFS console, About).

## Results (two runs, same outcome)

| # | Step | Expected | Actual | Result |
|---|---|---|---|---|
| 1 | presign PUT (video/mp4) + upload 1 MiB | 200 | 200 | PASS |
| 2 | PUT with wrong content-type | 403 | 403 `SignatureDoesNotMatch` | PASS (deny works) |
| 3 | `headObject` size | 1048576 | `UnknownError` (HTTP 403) on first HEAD after PUT | FAIL (flaky) |
| 4a | presign GET, sha256 equal | 200 + hash | `terminated` (connection closed mid-body) | FAIL |
| 4b | GET with `ResponseContentDisposition` | header present | `terminated` | FAIL (not verified) |
| 5 | `Range: bytes=0-1023` | 206 | 206, 1024 bytes, `Content-Range` ok; no `Accept-Ranges` header | PASS |
| 6a | preflight PUT, Origin localhost:3000 | ACAO/ACAM/ACAH | HTTP 200 but **no** `Access-Control-*` headers | FAIL |
| 6b | preflight GET + Range | ACAO/ACAM/ACAH | HTTP 200 but no `Access-Control-*` headers | FAIL |
| 6c | preflight from `https://evil.example` | denied | no CORS headers (denied, but only because CORS is absent entirely) | PASS (vacuous) |
| 6d | actual GET carries ACAO | ACAO present | absent | FAIL |
| 6e | actual GET from evil origin | no ACAO | request itself `terminated` (no body) | inconclusive |
| 7 | expired URL (1 s, wait 3 s) | 403 | 403 | PASS |
| 8 | cleanup + HEAD null | null | deleted, HEAD -> null, list empty | PASS |

## Findings

### Blocker A: GET bodies are truncated (about 64-120 KB)

Investigated with Node fetch, curl (HTTP/1.1 and HTTP/2), and SDK `GetObject`; all behave the same. Headers arrive correctly (`200`, correct `Content-Length`), then the connection closes after roughly 100 KB:

- Whole-object GET: 64 KiB object OK, 128 KiB OK (once a 502), 256 KiB / 512 KiB / 1 MiB always fail (`curl: (18) transfer closed with N bytes remaining`).
- Range GET: 32 KiB and 64 KiB ranges OK; 96 KiB, 128 KiB, 192 KiB and 256 KiB ranges fail the same way (so Range is not a workaround for chunks over about 64 KiB).
- PUT of 1 MiB works. Presigned and SDK-authenticated GETs fail identically, so this is not signing.

This points to the Cloudflare tunnel/proxy or the RustFS origin dropping streamed responses, not our code. Playback and download of a video would be impossible as-is.

### Blocker B: HEAD intermittently returns 403

Right after a PUT, `HeadObject` via SDK returned 403 once and then 200 four times. A presigned HEAD fetched four times returned `403 200 403 200`. The signing is identical each time, so some origin replica or edge rule sometimes rejects valid requests (for example two tunnel connectors or origins with different credentials or clock, or a WAF/bot rule). T6 `complete` (HEAD to verify size) would be flaky.

### Blocker C: CORS not configured (or stripped)

Preflight returns HTTP 200 with no `Access-Control-*` headers for both allowed and evil origins, and actual responses carry no ACAO. A browser PUT from `http://localhost:3000` would be blocked.

### Works

- Presigned PUT with signed `content-type` (SDK option `requestChecksumCalculation: 'WHEN_REQUIRED'` plus `signableHeaders: content-type`, `forcePathStyle: true`) uploads fine, and a mismatched content-type is rejected with 403.
- Expiry is enforced; Range returns 206 with `Content-Range`.
- `Accept-Ranges` is absent from GET/206 responses (HEAD does return `accept-ranges: bytes`).

## What the user must change

1. **Fix the response truncation** (blocker A) on the Cloudflare tunnel/proxy or RustFS side. Things to check: `cloudflared` logs and version (try `--protocol http2` or `quic`, `noChunkedEncoding`, `disableChunkedEncoding`), origin response timeout/buffer limits, Cloudflare Rocket Loader/compression/Polish rules on this hostname, any WAF/rate limit on responses, and RustFS logs for the request around the failing GET (does RustFS log a client disconnect or a panic?). Test from the server host directly (`curl` to RustFS port, bypassing Cloudflare) to see which layer is at fault. Cloudflare's free/pro plans also disallow proxying video-like content on some setups, but this fails for `video/mp4` and is a connection drop, so check the origin first.
2. **Fix intermittent 403 on HEAD** (blocker B): make sure only one origin/tunnel connector serves the hostname (or all share identical keys and clock via NTP) and check the RustFS log for the rejected HEAD.
3. **Apply CORS to the bucket** (blocker C) in the RustFS console (Bucket -> CORS), or with the S3 API using the admin credentials:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["http://localhost:3000", "https://<your-vercel-domain>"],
      "AllowedMethods": ["GET", "PUT", "HEAD"],
      "AllowedHeaders": ["content-type", "range"],
      "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges", "Content-Disposition"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

   Ensure Cloudflare does not strip or override `Access-Control-*` headers (no Transform Rule or Worker removing them).
4. Tell us the RustFS version so it can be pinned in `SPEC.md`.

After the changes, re-run the script; every non-informational step should pass. T2 and Checkpoint 0 stay open until then.
