# Spec: Video Enhancer (ส่วนตัว) — Next.js on Vercel + Colab GPU

สถานะ: **v2.1 approved สำหรับ planning** • 2026-10-14
แทนที่ v1 ทั้งหมด `Video_Enhancer_HANDOFF_TH_Nextjs_Supabase.md` ใช้เป็น **แหล่งอ้างอิง** เท่านั้น ไม่ใช่ข้อกำหนด

## Objective

เครื่องมือส่วนตัวสำหรับทำวิดีโอให้คมขึ้นจริงด้วย GPU ของ Colab เพราะ GTX 1650 4 GB ในเครื่องไม่พอ ใช้ได้โดย **ผู้ใช้ไม่เกิน 5 คน** (เจ้าของ + เพื่อน, รายชื่อใน `ALLOWED_EMAILS`) ข้อมูลแยกตามผู้ใช้ด้วย RLS; **operator** (รายชื่อใน `OPERATOR_EMAILS`, คือเจ้าของ) เป็นคนเดียวที่ออก worker token และรัน Colab ประมวลผลคิวของทุกคน

Flow หลัก:
1. Login → เลือกไฟล์ MP4 **และเลือกโมเดล + preset ในฟอร์มเดียวกัน** (1 job = 1 โมเดล; preset ที่ไฟล์ใช้ไม่ได้/เกินงบเวลาจะถูกปิดพร้อมเหตุผล, ค่าเริ่มต้นคือ preset แรกที่ใช้ได้ โดยเลือก Fast 4x ก่อน แล้ว 2x)
2. กดปุ่มเดียว "Upload & enhance" → ไฟล์ไปที่ Cloudflare R2 ตรง → complete
3. **เข้าคิวอัตโนมัติ** (สร้าง job ต่อทันทีแล้วไปหน้า job; ถ้าสร้าง job ไม่สำเร็จ เช่น 429/422 ให้กด "Try again" ซ้ำเฉพาะขั้นสร้าง job ไม่ต้องอัปโหลดซ้ำ) → เปิด Colab notebook เอง กดรัน → notebook ทำงานที่รอคิวอยู่จนหมดแล้วจบ
4. กลับมาที่เว็บ ดูต้นฉบับ vs ผลลัพธ์ **side-by-side** (sync เวลา, wipe slider, ซูม) → ดาวน์โหลด
5. อยากลองโมเดลอื่น → สร้าง job ใหม่จาก asset เดิม ไม่ต้องอัปโหลดซ้ำ

ลำดับส่งมอบ: **Real-ESRGAN end-to-end ก่อน** → SeedVR2 เป็น spike แยก (community wrapper แบบลด VRAM: GGUF/quantized + block swap) บน **Colab ฟรี (T4 15 GB, ไม่มี fp8 native)** เป้าหมายคลิปไม่กี่วินาทีที่ ~480p; no-go เป็นผลที่ยอมรับได้

### นอก scope
ผู้ใช้เกิน 5 คน/สมัครเอง, quota พื้นที่รวม, billing, public sharing; lease/fencing/outbox/reaper/verifier แยกแบบ production; background server; RunPod/local worker; auto-dispatch หรือ notebook ที่ polling/keepalive; HDR/VFR/subtitle; face restore; retention อัตโนมัติ (ลบเองจากหน้าเว็บ); Colab Pro/A100; optimize SeedVR2 เชิงลึก

## Architecture

```text
Browser ──HTTPS──> Next.js on Vercel (UI + /api/v1 Route Handlers)
   │                    │ Supabase SSR client (RLS)      │ S3 SDK presign
   │                    v                                 v
   │               Supabase (Auth + Postgres)        Cloudflare R2 (private bucket)
   └──signed PUT/GET────────────────────────────────────^      ^
Colab notebook ──HTTPS /api/v1/worker/* (worker token)──┘      │ signed GET/PUT
               └────────────────────────────────────────────────┘
```

| ส่วน | ทำ | ไม่ทำ |
|---|---|---|
| Next.js (Vercel) | auth, presign URL, สร้าง/ดู/ยกเลิก job, รับ heartbeat/complete จาก Colab, หน้าเทียบ | ไม่รับ bytes วิดีโอ (Vercel body limit), ไม่รัน ffmpeg, ไม่มีงานเบื้องหลัง |
| Supabase | Auth (email+password, ปิด signup), ตาราง `assets`, `jobs`, `worker_tokens` + RLS owner-only, RPC `claim_job` | ไม่ใช้ Storage/Realtime |
| Cloudflare R2 | เก็บ input/output, private bucket, CORS (ตั้งที่ bucket settings) อนุญาตเฉพาะ origin ของเว็บ | ไม่เปิด public read (ไม่ใช้ `r2.dev` / custom domain สาธารณะ) |
| Colab notebook | ffprobe ตรวจ input, enhance, encode, ตรวจ output, อัปโหลด, รายงานผล | ไม่ถือ secret ของ Supabase/R2 (ได้แค่ signed URL) |

ข้อสังเกตจาก handoff ที่ยังเก็บไว้เพราะราคาถูก: ห้าม browser/Colab แตะ DB ตรง; ใช้ `attempt_id` กัน notebook เก่าส่งผลทับ (เวอร์ชันย่อของ fencing); key ของ object สร้างฝั่ง server ด้วย UUID; ไม่ log signed URL

## Data model (Supabase, schema `public`, RLS เปิดทุกตาราง)

```text
assets(id uuid pk, owner_id → auth.users, object_key, filename, size_bytes,
       state: UPLOADING|READY|DELETED, client_meta jsonb, probe jsonb, created_at)
jobs(id uuid pk, owner_id, asset_id → assets, preset_id, params jsonb,
     state: QUEUED|RUNNING|SUCCEEDED|FAILED|CANCELLED,
     attempt_id uuid, attempt_count int, cancel_requested bool,
     stage text, processed_frames int, total_frames int, heartbeat_at,
     output_key, output_meta jsonb, error_code, error_message,
     worker_info jsonb, created_at, started_at, finished_at)
worker_tokens(id, owner_id, token_sha256, created_at, revoked_at)
```

- `client_meta` = ค่าจาก `<video>` ใน browser (ใช้แค่ UX); `probe` = ffprobe จาก Colab (ค่าจริง)
- State: `QUEUED → RUNNING → SUCCEEDED | FAILED`; `QUEUED/RUNNING → CANCELLED`; `RUNNING` ที่ heartbeat เงียบ > 3 นาทีแสดงเป็น "Colab หลุด?" + ปุ่ม **Requeue** (→ `QUEUED`, attempt ใหม่ตอน claim)
- `claim_job(owner)` = RPC เดียว: `FOR UPDATE SKIP LOCKED` งาน QUEUED เก่าสุด → RUNNING, `attempt_id` ใหม่, `attempt_count+1`
- heartbeat/complete/fail ต้องตรง `attempt_id` และ state = RUNNING มิฉะนั้น 409 `STALE_ATTEMPT`

## API (`/api/v1`, JSON camelCase, error `{"error":{"code","message"}}`)

User (Supabase session, ตรวจด้วย `getClaims` + email ต้องอยู่ใน `ALLOWED_EMAILS`; route ของ operator ต้องอยู่ใน `OPERATOR_EMAILS` ด้วย — 403 ถ้าไม่ใช่):

| Route | หน้าที่ |
|---|---|
| `GET /presets` | รายการ preset + limit |
| `POST /uploads` `{filename,sizeBytes,contentType,clientMeta}` | สร้าง asset UPLOADING + signed PUT (15 นาที) |
| `POST /assets/{id}/complete` | HEAD ตรวจว่ามี object + ขนาดตรง → READY |
| `GET /assets`, `DELETE /assets/{id}` | รายการ / ลบ asset + jobs + objects (ต้องไม่มีงาน RUNNING) |
| `POST /jobs` `{assetId,presetId}` | สร้าง QUEUED (ตรวจ preset กับ `client_meta` เบื้องต้น) |
| `GET /jobs`, `GET /jobs/{id}` | สถานะ/progress |
| `POST /jobs/{id}/cancel`, `POST /jobs/{id}/requeue` | ยกเลิก / ส่งกลับคิว |
| `GET /jobs/{id}/media` | signed GET ของ input + output (1 ชม.) สำหรับหน้าเทียบ/ดาวน์โหลด |
| `POST /worker-tokens` | ออก token ใหม่ (แสดงครั้งเดียว) และ revoke ตัวเก่า |

Worker (`Authorization: Bearer <worker token>`, เก็บใน Colab Secrets):

| Route | หน้าที่ |
|---|---|
| `POST /worker/claim` `{models, gpu}` | 200 `{jobId, attemptId, preset, inputUrl}` หรือ 204 ไม่มีงาน |
| `POST /worker/jobs/{id}/heartbeat` | `{attemptId, stage, processedFrames, totalFrames, probe?}` → `{cancelRequested}` |
| `POST /worker/jobs/{id}/output-url` | signed PUT ไปที่ `outputs/{jobId}/{attemptId}.mp4` (ขอตอนจะอัปโหลด) |
| `POST /worker/jobs/{id}/complete` | `{attemptId, outputMeta}` → server HEAD output แล้ว SUCCEEDED |
| `POST /worker/jobs/{id}/fail` | `{attemptId, code, message}` |

Route Handlers รันบน Node.js runtime (ค่า default; ห้ามประกาศ `export const runtime` เพราะชนกับ `cacheComponents` ของ Next 16.4), response มี `Cache-Control: private, no-store`

## Presets และ limits (ค่าเริ่มต้น ปรับได้หลังวัดจริง)

| presetId | โมเดล | Input ที่รับ | วินาที/เฟรม/ล้านพิกเซล input (T4) |
|---|---|---|---|
| `realesrgan-x2` | **RealESRGAN_x2plus** (native 2×; เปลี่ยน 2026-10-14 เพราะ x4→ย่อ คำนวณหนักเท่า 4×) | ≤ 1920×1080 | 1.42 (ประมาณการ) |
| `realesrgan-x4` | RealESRGAN_x4plus | ≤ 960×540 (output ≤ 4K) | 5.69 (วัดจริง) |
| `realesrgan-anime-x4` | realesr-animevideov3 | ≤ 960×540 | 0.69 (วัดจริง) |
| `realesrgan-fast-x4` | realesr-general-x4v3 (SRVGGNetCompact, num_conv=32; เร็วกว่า ละเอียดน้อยกว่าเล็กน้อย) | ≤ 960×540 | 0.69 (ประมาณการ ใช้ค่าเดียวกับ anime) |
| `seedvr2-*` | กำหนดหลัง spike | กำหนดหลัง spike |

**งบเวลา GPU (2026-10-14):** แทนเพดาน 120 s อย่างเดียว เว็บประมาณเวลา = 60 s (ติดตั้ง/โหลดโมเดล/โอนไฟล์) + จำนวนเฟรม × (ล้านพิกเซล input × ค่าสัมประสิทธิ์ของ preset) และปฏิเสธ (422 `PRESET_TOO_SLOW`, พร้อมแนะนำ preset ที่เร็วกว่าถ้าเข้างบ) เมื่อเกิน `MAX_ESTIMATED_SEC` = 30 นาที; `GET /presets` ส่งค่าสัมประสิทธิ์ให้ UI แสดง "≈ N นาที บน Colab T4" เพดานเดิม (≤ 500 MiB, ≤ 120 s, ขนาดภาพต่อ preset) ยังอยู่

**Measured on T4 (Colab ฟรี, fp16, 2026-10-14, spike T3):** x4plus 640×360 → 1.31 s/เฟรม (tile 0, โมเดล ≈ 95% ของเวลา; decode/encode เล็กน้อย); x4plus 1280×720 (เส้นทาง x2 เดิม) → 6.8 s/เฟรม คิดตามจำนวนพิกเซล input; realesr-animevideov3 → 0.16 s/เฟรม (640×360 → 2560×1440); encoder: h264_nvenc 21 fps ที่ 1440p, libx264 6.9 fps ค่า x2plus และ fast เป็นการประมาณการจนกว่าจะวัดจริง ดู `docs/spikes/realesrgan.md`

Input ทุก preset: MP4, H.264, SDR 8-bit, ≤ 120 s, ≤ 500 MiB, เสียง AAC หรือไม่มี (browser ต้องเล่นต้นฉบับได้เพื่อเทียบ)
VFR → Colab normalize เป็น CFR อัตโนมัติก่อนประมวลผล (เฟรมอาจถูกทำซ้ำ/ตัดทิ้ง): fps เป้าหมาย = ค่ามาตรฐานที่ใกล้ `avg_fps` สุดจาก {24000/1001, 24, 25, 30000/1001, 30, 50, 60000/1001, 60} จำกัดไม่เกิน 30; intermediate H.264 CRF 12 เสียง copy; output เทียบกับไฟล์ที่ normalize แล้ว (จำนวนเฟรม/FPS ของ output = ของ CFR ไม่ใช่ของต้นฉบับ); heartbeat `probe.normalized = {fromAvgFps, toFps}`
Output: MP4 H.264 yuv420p (h264_nvenc ถ้าใช้ได้ มิฉะนั้น libx264 CRF 18 preset medium), bt709, เสียง copy, จำนวนเฟรมและ FPS เท่าต้นฉบับ ไม่มี fallback เปลี่ยนโมเดล/scale เอง (OOM → ลด tile ตามที่ preset อนุญาต แล้วบันทึกค่า)

## หน้าเทียบ (หัวใจของโปรเจกต์)

- 2 `<video>` ซ้อนกัน: ต้นฉบับ scale ขึ้นให้ขนาดเท่าผลลัพธ์ (CSS, `image-rendering` ปรับได้: smooth / pixelated)
- Wipe slider ลากแบ่งซ้าย/ขวา + โหมดวางคู่กัน
- ซูม 1×–8× + pan (wheel/drag), ซูมพร้อมกันทั้งสองฝั่ง
- Sync: วิดีโอ output เป็น master; play/pause/seek สั่งทั้งคู่; ระหว่างเล่นแก้ drift เมื่อห่าง > 1 เฟรม; ปุ่มเลื่อนทีละเฟรม (←/→) ตอน pause
- คีย์บอร์ดใช้ได้ครบ, ไม่ autoplay เสียง, ปิดเสียงฝั่งต้นฉบับ

**Runner performance (2026-10-14):** decode / GPU / encode แยก thread ต่อด้วยคิวจำกัดขนาด; tile ใหญ่สุดที่ไม่ OOM (เริ่มจาก 0 → 512 → 256 → 128 ตาม VRAM); batch หลายเฟรมเมื่อ tile=0; NVENC เมื่อ feature-test ผ่าน

**CPU fallback (2026-10-14):** ถ้า session Colab ไม่มี GPU (โควตาหมด/GPU ไม่ว่าง) notebook ตัวเลือก `CPU_FALLBACK` (เปิดเป็นค่าเริ่มต้น) ให้ worker รันบน CPU แทนการหยุด (`--device auto|cuda|cpu`, auto = cuda ถ้ามี ไม่งั้น cpu): fp32, ทั้งเฟรม batch 1 (ล้นแรมค่อยลดเป็น tile 512 → 256 → 128), encode ด้วย libx264; **รับเฉพาะ preset Anime 4× (`realesrgan-anime-x4`)** โดยส่ง `presets` ใน claim ตามนั้น (ค่าคงที่เดียว `CPU_PRESETS` ใน runner เพิ่ม preset ได้ภายหลัง) และไม่ส่ง `gpu`; งาน preset อื่นยังเป็น `QUEUED` รอ session ที่มี GPU. ช้ากว่า GPU มาก (ประมาณการ 15–30× ยังไม่ได้วัดจริง) จึง**ประมาณเวลาและงบเวลาฝั่งเว็บยังคิดแบบ GPU (T4) เหมือนเดิม** (เว็บแค่แสดงหมายเหตุ "รันบน CPU ได้เมื่อ GPU ไม่ว่าง (ช้ากว่ามาก)" ที่ preset Anime 4×); worker log ความเร็วจริงต่อ job (`N frames in Xs (Y s/frame, device=cpu|cuda)`) ไว้ใช้ปรับค่าประมาณภายหลัง

## Tech Stack (pin version จริงตอน scaffold แล้วบันทึกที่นี่)

- Web: Node 24, pnpm, TypeScript strict, Next.js App Router (stable ล่าสุด), `@supabase/ssr`, `@supabase/supabase-js`, `zod`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (`forcePathStyle: true`, region `auto` สำหรับ Cloudflare R2), Tailwind
- DB: Supabase CLI ผ่าน `pnpm dlx supabase` (migrations + gen types)
- Colab: Python 3 ของ Colab, `requests`, ffmpeg/ffprobe ของ Colab, Real-ESRGAN official repo pin commit + weight SHA-256; SeedVR2 wrapper เลือกใน spike แล้ว pin commit
- Weights cache ใน Google Drive (mount) เพื่อไม่ต้องโหลดใหม่ทุก session
- Repo: **public บน GitHub** — notebook ติดตั้งด้วย `pip install git+https://github.com/<owner>/<repo>#subdirectory=worker`; Vercel deploy จาก repo เดียวกัน

**Pinned (T1)** (resolved versions in `web/pnpm-lock.yaml`):
- Node v24.19.0; pnpm 10.34.7 (เครื่องมี pnpm 8.5.1 ซึ่งเก่าเกินไป: resolve เป็นเวอร์ชันต่ำสุด; ใช้ `npx pnpm@10.34.7` หรือ `packageManager` ใน `web/package.json`)
- next 16.4.0, react / react-dom 19.3.0, typescript 5.9.3 (strict)
- tailwindcss 4.3.3 + `@tailwindcss/turbopack` 4.3.3 (ตาม template create-next-app 16.4.0; ไม่มี `tailwind.config`)
- eslint 9.39.5 + eslint-config-next 16.4.0 (flat config)
- vitest 5.0.4 (`web/vitest.config.mts`, `tests/**/*.test.ts`)
- `next.config.ts` จาก template เปิด `cacheComponents` + `partialPrefetching` ไว้ (ยังไม่ตัดสินใจเก็บ/ปิด)

## Commands

```
cd web
pnpm install
pnpm dev                      # http://localhost:3000 (ใช้ Supabase dev + R2 bucket dev)
pnpm typecheck && pnpm lint
pnpm test                     # vitest
pnpm db:push                  # supabase db push → project
pnpm db:types                 # supabase gen types → lib/supabase/database.types.ts
vercel deploy                 # preview; vercel deploy --prod
cd ../worker && python -m pytest
python -m enhancer_worker run --api http://localhost:3000 --runner mock   # ทดสอบในเครื่องไม่ใช้ GPU
```

## Project Structure

```
web/                          Next.js app
  app/login/  app/(app)/page.tsx (upload + list)  app/(app)/jobs/[id]/page.tsx (เทียบ)  app/(app)/settings/
  app/api/v1/**/route.ts
  components/compare/         CompareViewer, useSyncedVideos, ZoomPan
  lib/contracts/              zod schemas (request/response, presets)
  lib/supabase/               server.ts, admin.ts (server-only), database.types.ts
  lib/storage.ts lib/auth.ts lib/http.ts lib/jobs.ts
  tests/
supabase/migrations/
worker/                       Python package ที่ notebook ติดตั้ง
  enhancer_worker/            api.py, probe.py, encode.py, runners/{mock,realesrgan,seedvr2}.py, cli.py
  tests/
  colab_runner.ipynb          ไม่มี secret; อ่าน token จาก Colab Secrets
docs/spikes/                  rustfs.md (ประวัติ, ล้มเหลว), r2.md, seedvr2.md (ผลวัดจริง)
```

## Code Style

```ts
// app/api/v1/jobs/[id]/cancel/route.ts
export const runtime = 'nodejs';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { supabase } = await requireOwner();               // 401/403 ถ้าไม่ใช่เจ้าของ
  const { id } = await ctx.params;
  const { data, error } = await supabase
    .from('jobs').update({ cancel_requested: true })
    .eq('id', id).in('state', ['QUEUED', 'RUNNING']).select().maybeSingle();
  if (error) return apiError(500, 'INTERNAL', error.message);
  if (!data) return apiError(409, 'NOT_CANCELLABLE', 'งานนี้จบแล้ว');
  return json(toJobDto(data));
}
```

- Route Handler บาง ตรรกะอยู่ใน `lib/`; schema zod เป็นแหล่งเดียวของ type
- ไฟล์ kebab-case, component PascalCase, DB snake_case, JSON camelCase
- Python: type hints, ทุก request มี timeout, ffmpeg เรียกด้วย argument list, ไม่ print URL/token

## Testing Strategy

| ระดับ | เครื่องมือ | ครอบคลุม |
|---|---|---|
| Unit (web) | Vitest | zod contracts, การเลือก preset ตาม dims, state guards, sync-drift logic ของหน้าเทียบ |
| DB (local) | Vitest + PGlite (Postgres WASM) + stub `auth`/roles | migration ใช้ได้, RLS owner-only, grants ของ `claim_job`, logic ของ claim |
| Integration (web) | Vitest กับ Supabase dev + R2 bucket `dev` (opt-in ด้วย env, รันเมื่อผู้ใช้อนุมัติ) | upload→complete, claim พร้อมกันไม่ซ้ำ (SKIP LOCKED), stale attempt ได้ 409 |

**ห้ามใช้ Docker** ในการ dev/test ทุกกรณี (คำสั่งผู้ใช้ 2026-10-14) — รวม `supabase start/db start/db reset/stop`; types ของ DB สร้างจาก cloud dev project
| Unit (worker) | pytest | parse ffprobe, ตรวจ limit, เทียบ frame count/duration, retry HTTP |
| E2E mock | `pnpm dev` + worker `--runner mock` (ffmpeg scale ธรรมดา) | flow ครบโดยไม่ใช้ GPU |
| GPU จริง | รัน notebook บน Colab | คลิปทดสอบ 5–10 s, บันทึก GPU/เวลา/VRAM |
| UI | ตรวจเองใน browser | หน้าเทียบ sync/zoom/keyboard |

## Boundaries

- **Always**: ตรวจ session + `ALLOWED_EMAILS` ทุก user route (และ `OPERATOR_EMAILS` สำหรับ worker token/คิวรวม); ผู้ใช้เห็นเฉพาะข้อมูลตัวเอง; ตรวจ worker token (hash) ทุก worker route; ตรวจ `attempt_id`; รัน typecheck + test ก่อนบอกว่าเสร็จ; regenerate DB types หลังเปลี่ยน schema
- **Ask first**: เพิ่ม dependency นอกรายการ; `db:push` ไป Supabase; deploy Vercel prod; แก้ CORS/bucket policy ของ R2; เปลี่ยน API contract
- **Never**: commit `.env`/token; ใส่ secret ใน `NEXT_PUBLIC_*` หรือ notebook; ส่ง Supabase secret key หรือ R2 key ไป Colab; notebook ที่วน polling/keepalive; ส่ง bytes วิดีโอผ่าน Vercel

## Success Criteria

1. คลิป 10 s 720p H.264+AAC → upload → `realesrgan-x2` → รัน notebook บน Colab T4 → SUCCEEDED; output เฟรมเท่าต้นฉบับ, duration ต่าง ≤ 1 เฟรม + 50 ms, มีเสียง
2. หน้าเทียบ: หลัง pause/seek ทั้งสองฝั่งอยู่เฟรมเดียวกัน; wipe + ซูม 4× ใช้ได้ทั้งเมาส์และคีย์บอร์ด
3. ไม่ login / email อื่น → 401/403; worker token ผิดหรือถูก revoke → 401
4. ปิด Colab runtime กลางงาน → เว็บแสดง "Colab หลุด?" ภายใน 3 นาที → Requeue → รันใหม่สำเร็จ; complete จาก attempt เก่า → 409
5. Client bundle และ notebook ไม่มี secret (grep ใน build output)
6. SeedVR2 spike มีรายงาน `docs/spikes/seedvr2.md`: GPU, peak VRAM, วินาที/เฟรม, คลิปยาว/ความละเอียดสูงสุดที่รันไหว → ตัดสิน go/no-go; ถ้า go มี preset ใน UI

## Risks

| Risk | รับมือ |
|---|---|
| R2 presign/CORS ไม่เข้ากับ AWS SDK | spike แรก (T2, ดู `docs/spikes/r2.md`) ก่อนเขียน upload |
| `realesrgan`/`basicsr` pip ไม่เข้ากับ torchvision ใหม่บน Colab | pin version หรือ patch import ใน notebook; ทดสอบใน spike Real-ESRGAN |
| Colab ตัด session / ไม่ได้ GPU | Requeue; คลิปสั้น; weights ใน Drive |
| Colab policy | ใช้แบบกดรันเองครั้งต่อครั้ง ประมวลผลคิวแล้วจบ ไม่มี daemon/keepalive |
| SeedVR2 ไม่ fit VRAM หรือช้าเกิน | no-go เป็นผลลัพธ์ที่ยอมรับได้ |
| Encode 4K บน CPU ของ Colab ช้า | วัดใน spike; พิจารณา NVENC ถ้ามีบน GPU นั้น |
| Secret หลุดใน public repo | `.gitignore` + `.env.example` ตั้งแต่ commit แรก; ตรวจ `git diff --cached` หา key ก่อน commit; notebook ไม่มี output cell ที่มี URL/token |

## Decisions (จาก interview 2026-10-14)

- Colab: ฟรี (T4) — Real-ESRGAN เป็นเส้นทางหลัก, SeedVR2 spike ตามข้างบน
- Repo: public GitHub; `git init` ในเครื่องได้ แต่สร้าง remote/push ครั้งแรกต้องถามก่อน
- **Storage = Cloudflare R2** (แทน self-hosted RustFS): เหตุผล "self-hosted RustFS behind Cloudflare proxy truncated GETs, HEAD 403s, no CORS (T2 2026-10-14)" (ผล T2 ที่ล้มเหลวอยู่ที่ `docs/spikes/rustfs.md`)
  - Endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, region `auto`, path-style (`forcePathStyle: true`), bucket `video-enhancer`
  - R2 API token สิทธิ์ Object Read & Write เฉพาะ bucket นี้
  - CORS ตั้งที่ **R2 bucket settings** อนุญาต origin ของ Vercel + `http://localhost:3000` สำหรับ `PUT, GET, HEAD` (ผู้ใช้ตั้งได้เอง; JSON ที่ใช้อยู่ใน `docs/spikes/r2.md`)
  - R2 single PUT limit 5 GiB เพียงพอสำหรับ input 500 MiB; retention ในอนาคตใช้ R2 lifecycle rules ได้

- **Multi-user (2026-10-14)**: ≤ 5 คน, limit เดิมต่อคน (2 งานค้าง, 500 MiB/ไฟล์), ไม่มี quota พื้นที่ ผู้ใช้สร้างโดยเจ้าของใน Supabase (signup ปิด) Operator รัน Colab ให้ทุกคน: worker token ออกได้เฉพาะ operator, `claim_job` เลือกงาน QUEUED เก่าสุดของ **ทุก owner**, worker routes ไม่กรอง owner แต่ยังตรวจ `attempt_id` operator มีหน้า "คิว" เห็นงานค้างของทุกคน (อีเมล, ชื่อไฟล์, preset, state) แต่ไม่เห็น/ดาวน์โหลดวิดีโอของคนอื่นผ่านเว็บ
- ความเสี่ยงที่ยอมรับ: Colab ของ operator ประมวลผลวิดีโอของเพื่อน (privacy ระหว่างเพื่อน) และมีลักษณะคล้ายบริการมากขึ้นต่อ policy Colab — ยังกดรันเองทีละครั้ง ไม่มี daemon

## Open Questions

- ไม่มี blocker เหลือ ชื่อ domain ของ R2/Vercel ใส่ใน env ตอน setup
