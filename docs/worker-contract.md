# Worker contract (`/api/v1/worker/*`)

Source of truth for types: `web/lib/contracts/worker.ts` (zod). JSON camelCase. Every response has `Cache-Control: private, no-store`. Never log URLs or the token.

## Auth

`Authorization: Bearer ve_<43 base64url chars>` on every call. Token comes from Settings in the web app (Colab Secrets `ENHANCER_TOKEN`). Generating a new token revokes the old one.
Missing / malformed / revoked token -> `401 {"error":{"code":"INVALID_WORKER_TOKEN","message":...}}`.

Errors: `{"error":{"code","message","details?"}}`. `400 VALIDATION | INVALID_JSON`, `409 STALE_ATTEMPT | OUTPUT_MISSING | OUTPUT_SIZE_MISMATCH | CANCELLED | ASSET_MISSING`, `404 NOT_FOUND`, `500 INTERNAL`.

## Lifecycle

```
claim -> [download -> probe -> enhance -> encode -> upload] -> complete | fail
            heartbeat every ~15 s throughout; output-url requested right before upload
```

The worker processes the queue until `claim` returns 204, then exits (no polling, no keepalive).

## POST /worker/claim

Request: `{ "presets"?: string[], "gpu"?: { "name": string, "vramMb": int } }`. Empty body is allowed. `presets` = preset ids the worker can run; the server intersects it with the presets it offers (`mock-x2` only when enabled). Unknown ids are ignored.

- `204` (no body): nothing claimable (including: no requested preset is offered).
- `200`:
```json
{
  "jobId": "uuid", "attemptId": "uuid",
  "preset": { "id": "realesrgan-x2", "model": "RealESRGAN_x2plus", "scale": 2, "params": { "model": "...", "scale": 2, "maxInput": {"width":1920,"height":1080}, "limits": {"maxDurationSec":120,"maxSizeBytes":524288000} } },
  "inputUrl": "https://... (signed GET, valid 2 h)",
  "input": { "assetId": "uuid", "sizeBytes": 123, "filename": "clip.mp4" }
}
```
The claim picks the oldest QUEUED job of any user (FIFO by creation time; the token owner is an operator and serves everyone), marks it RUNNING with a fresh `attemptId`. Send that `attemptId` in every later call.
`409 ASSET_MISSING`: the input asset vanished; the job was failed; just claim again.

## POST /worker/jobs/{jobId}/heartbeat

`{ "attemptId", "stage": "download"|"probe"|"enhance"|"encode"|"upload", "processedFrames"?: int, "totalFrames"?: int, "probe"?: object }` -> `200 { "cancelRequested": boolean }`.
`probe` = ffprobe summary of the input, send once after the probe stage. If `cancelRequested` is true: stop, then call `fail` with code `CANCELLED`.

## POST /worker/jobs/{jobId}/output-url

`{ "attemptId" }` -> `{ "putUrl": "https://...", "headers": { "Content-Type": "video/mp4" }, "expiresAt": ISO-8601 }`.
PUT the file to `putUrl` with exactly those headers (they are signed). Key is `outputs/{jobId}/{attemptId}.mp4`.

## POST /worker/jobs/{jobId}/complete

```json
{ "attemptId": "uuid",
  "outputMeta": { "width": int, "height": int, "frames": int, "fps": number, "durationSec": number, "hasAudio": boolean, "sizeBytes": int } }
```
Server HEADs the output object; missing -> `409 OUTPUT_MISSING`; size differs from `outputMeta.sizeBytes` -> `409 OUTPUT_SIZE_MISMATCH`. If cancel was requested the output is not published: job becomes CANCELLED and the call returns `409 CANCELLED` (treat as done). Otherwise job becomes SUCCEEDED and `200 { "state": "SUCCEEDED" }`. A repeated `complete` for an already-SUCCEEDED attempt also returns `200`.

## POST /worker/jobs/{jobId}/fail

`{ "attemptId", "code": string (1-100), "message": string (<= 2000) }` -> job FAILED, `200 { "state": "FAILED" }`. Special code `CANCELLED` (after `cancelRequested`) -> job CANCELLED (`200 { "state": "CANCELLED" }`). A repeated `fail` for the same attempt returns `200` with the current terminal state. Suggested codes: `INPUT_UNSUPPORTED`, `DOWNLOAD_FAILED`, `OOM`, `ENCODE_FAILED`, `UPLOAD_FAILED`, `VERIFY_FAILED`, `INTERNAL`.

## Attempt fencing (T10)

heartbeat / output-url / complete / fail require `attemptId` equal to the job's current attempt and state RUNNING, else `409 STALE_ATTEMPT` (a restarted or requeued job rejects the old notebook). On `STALE_ATTEMPT` the worker must stop that job and move on without reporting.
