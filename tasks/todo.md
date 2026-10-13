# Tasks — Video Enhancer

แผน: `tasks/plan.md` • spec: `SPEC.md` v2.1
**ห้ามรัน Docker ทุกกรณี** (คำสั่งผู้ใช้)
Definition of Done ทุก task: `pnpm typecheck && pnpm lint && pnpm test` ผ่าน (และ `python -m pytest` เมื่อแตะ `worker/`), ไม่มี secret ใน diff, ทดสอบ runtime ตามที่ระบุ

---

## Phase 0: Foundation + spikes

### T1: Scaffold repo + Next.js — S/M ✅ reviewed 2026-10-14 (Next 16.4, pnpm 10.34.7 via npx/corepack; dev verified on :3001 because :3000 was in use)
สร้าง monorepo ตาม SPEC: `git init`, `.gitignore` (`.env*`, `node_modules`, `.next`, `__pycache__`, `*.mp4`), `.env.example`, Next.js App Router ใน `web/` (TS strict, Tailwind, ESLint), Vitest, scripts `typecheck/lint/test`; pin version ลง SPEC Tech Stack
- [ ] `pnpm dev` เปิดหน้าแรกได้
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` ผ่าน (มี test ตัวอย่าง 1 ตัว)
- [ ] `git status` ไม่เห็นไฟล์ `.env`
- Verify: รันคำสั่งข้างบน
- Deps: —
- Files: `.gitignore`, `.env.example`, `web/*` (create-next-app), `web/vitest.config.ts`, `SPEC.md`

### T2: Spike — RustFS presign/CORS — S ❌ blocked on real endpoint (GET truncation, HEAD 403 flake, no CORS; see docs/spikes/rustfs.md)
script ที่ใช้ `@aws-sdk/client-s3` (`forcePathStyle`) presign PUT → อัปโหลดไฟล์ทดสอบ → HEAD → presign GET → ดาวน์โหลดเทียบ hash; ตรวจ CORS preflight ด้วย `curl -X OPTIONS -H "Origin: http://localhost:3000"`
- [ ] PUT/GET ผ่าน presigned URL สำเร็จ hash ตรง
- [ ] Preflight จาก origin ที่อนุญาตได้ header ถูก; origin อื่นถูกปฏิเสธ
- [ ] บันทึกผล + เวอร์ชัน RustFS ใน `docs/spikes/rustfs.md` (บันทึกผลแล้ว; เวอร์ชันยังสังเกตไม่ได้ / Server: cloudflare)
- Verify: `pnpm tsx scripts/rustfs-smoke.ts`
- Deps: T1; ผู้ใช้ให้ endpoint/key/bucket/CORS
- Files: `web/scripts/rustfs-smoke.ts`, `docs/spikes/rustfs.md`

### T3: Spike — Real-ESRGAN บน Colab T4 — S ⏳ notebook reviewed; waiting for user Colab run
notebook ทดลอง (`worker/spikes/realesrgan_spike.ipynb`): ติดตั้ง Real-ESRGAN pin commit, แก้ปัญหา `basicsr`/torchvision, รัน x4plus กับคลิป 5 s 720p แบบ decode→enhance→encode (pipe), วัดเวลา/VRAM, ลอง `h264_nvenc`
- [ ] ได้ output ที่ frame count เท่าต้นฉบับและมีเสียง
- [ ] สูตรติดตั้งที่ทำซ้ำได้ + weight SHA-256 + เวลา/เฟรม + peak VRAM บันทึกใน `docs/spikes/realesrgan.md`
- Verify: ผู้ใช้รันบน Colab แล้วส่งผล cell สรุปกลับมา
- Deps: — (ขนานได้)
- Files: `worker/spikes/realesrgan_spike.ipynb`, `docs/spikes/realesrgan.md`

### Checkpoint 0
- [ ] T1–T3 ผ่าน; ถ้า T2 หรือ T3 ล้มเหลว → ทบทวน SPEC กับผู้ใช้ก่อนไปต่อ

---

## Phase 1: Auth + upload

### T4: Supabase schema + RLS + `claim_job` — M ✅ reviewed (PGlite 8 tests; concurrency passed once on embedded Postgres; `db push` done 2026-10-14 to dev project; types regenerated from cloud; concurrency test vs cloud still pending DB URL)
migration แรก: `assets`, `jobs`, `worker_tokens` ตาม SPEC, enum/check ของ state, index `(state, created_at)`, RLS owner-only (select/insert/update/delete ด้วย `auth.uid() = owner_id`), function `claim_job(p_owner uuid, p_presets text[])` returning setof แบบ `SECURITY DEFINER SET search_path = ''` + `FOR UPDATE SKIP LOCKED` grant เฉพาะ `service_role`; `lib/supabase/{server,admin}.ts`, gen types
- [ ] `db push` สำเร็จ (ถามก่อน) และ `db:types` สร้างไฟล์ได้
- [ ] anon key อ่าน `jobs` ไม่ได้; `claim_job` เรียกด้วย anon/authenticated ไม่ได้
- [ ] PGlite test: migration apply ได้, RLS/grants/claim logic ถูก (ไม่ใช้ Docker)
- [ ] concurrency SKIP LOCKED: opt-in `db.integration.test.ts` รันกับ Supabase dev project ภายหลัง (ต้องได้รับอนุมัติ)
- Verify: `pnpm test tests/db.pglite.test.ts`
- Deps: T1; ผู้ใช้ให้ Supabase keys
- Files: `supabase/migrations/0001_init.sql`, `web/lib/supabase/server.ts`, `web/lib/supabase/admin.ts`, `web/lib/supabase/database.types.ts`, `web/tests/db.pglite.test.ts`, `web/tests/db.integration.test.ts`

### T5: Login + owner guard — M ✅ reviewed (proxy.ts, withOwner; real login untested until Supabase creds)
หน้า `/login` (email+password), session refresh ผ่าน proxy/middleware ตามเวอร์ชัน Next.js, `requireOwner()` ใช้ `getClaims` + `OWNER_EMAIL`, layout `(app)` redirect ถ้าไม่ login, ปุ่ม logout
- [ ] ไม่ login → redirect `/login`; API คืน 401
- [ ] login ด้วย email อื่น → 403
- [ ] unit test ของ `requireOwner` ครอบคลุม 3 กรณี
- Verify: `pnpm test`; manual login/logout
- Deps: T4
- Files: `web/app/login/page.tsx`, `web/middleware.ts` (หรือ `proxy.ts`), `web/lib/auth.ts`, `web/lib/http.ts`, `web/app/(app)/layout.tsx`

### T6: Storage lib + upload API — M ✅ reviewed (mocks; live RustFS check pending T2)
`lib/storage.ts` (presign PUT/GET, HEAD, delete; key = `inputs/{assetId}.mp4`), zod contracts, `POST /uploads` (ตรวจ size ≤ 500 MiB, contentType `video/mp4`), `POST /assets/{id}/complete` (HEAD ขนาดตรง → READY), `GET /assets`
- [ ] upload ผ่าน presigned URL แล้ว complete → asset READY
- [ ] complete โดยยังไม่อัปโหลด → 409; ขนาดไม่ตรง → 409
- [ ] ทุก response มี `Cache-Control: private, no-store`
- Verify: `pnpm test tests/uploads.integration.test.ts`
- Deps: T2, T5
- Files: `web/lib/storage.ts`, `web/lib/contracts/uploads.ts`, `web/app/api/v1/uploads/route.ts`, `web/app/api/v1/assets/[id]/complete/route.ts`, `web/app/api/v1/assets/route.ts`

### T7: Upload UI + asset list — M ✅ reviewed (browser test pending creds)
หน้าแรก: เลือกไฟล์ → อ่าน `client_meta` จาก `<video>` (w/h/duration) → เตือนเมื่อเกิน limit → XHR PUT พร้อม progress bar → complete; แสดงรายการ assets
- [ ] อัปโหลดคลิป 10 s เห็น progress และขึ้น READY ในรายการ
- [ ] ไฟล์ไม่ใช่ MP4 หรือ > 500 MiB ถูกบล็อกพร้อมข้อความ
- [ ] field มี label, ใช้คีย์บอร์ดได้
- Verify: manual ใน browser + `pnpm test` (unit ของ limit check)
- Deps: T6
- Files: `web/app/(app)/page.tsx`, `web/components/upload-form.tsx`, `web/components/asset-list.tsx`, `web/lib/client-meta.ts`

### Checkpoint 1
- [ ] login + upload ทำงานจริงกับ Supabase dev + RustFS; review กับผู้ใช้

---

## Phase 2: Job lifecycle (mock)

### T8: Presets + jobs API — M ✅ reviewed (zod 4.6.7; conditional updates; tested with fake client only)
`lib/contracts/presets.ts` (realesrgan-x2/x4/anime-x4 + `mock-x2` เฉพาะ dev), `POST /jobs` (ตรวจ preset กับ `client_meta`), `GET /jobs`, `GET /jobs/{id}`, `POST /jobs/{id}/cancel`, `POST /jobs/{id}/requeue` (เฉพาะ RUNNING ที่ stale > 3 นาที หรือ FAILED), `GET /presets`
- [ ] preset 4× กับ input 1080p → 422
- [ ] cancel งาน SUCCEEDED → 409; cancel QUEUED → CANCELLED ทันที; RUNNING → `cancelRequested`
- [ ] unit test ของ state guard ครบทุก transition ใน SPEC
- Verify: `pnpm test`
- Deps: T6
- Files: `web/lib/contracts/presets.ts`, `web/lib/jobs.ts`, `web/app/api/v1/jobs/route.ts`, `web/app/api/v1/jobs/[id]/route.ts`, `web/app/api/v1/jobs/[id]/[action]/route.ts`

### T9: Worker token + worker auth + claim — M ✅ reviewed (also built lib/storage.ts presign for T6; contract in docs/worker-contract.md)
`POST /worker-tokens` (สุ่ม 32 bytes, เก็บ SHA-256, revoke ตัวเก่า, แสดงครั้งเดียว), หน้า settings, `requireWorker()`, `lib/contracts/worker.ts` (contract ทั้งหมดของ worker), `POST /worker/claim` → `claim_job` + signed GET input
- [ ] token ผิด/revoke → 401
- [ ] claim เมื่อไม่มีงาน → 204; มีงาน → 200 พร้อม `attemptId`, `inputUrl`
- Verify: `pnpm test tests/worker.integration.test.ts`
- Deps: T4, T8
- Files: `web/lib/worker-auth.ts`, `web/lib/contracts/worker.ts`, `web/app/api/v1/worker-tokens/route.ts`, `web/app/api/v1/worker/claim/route.ts`, `web/app/(app)/settings/page.tsx`

### T10: Worker heartbeat/output-url/complete/fail — M ✅ reviewed (fenced updates, idempotent complete/fail, cancel race re-read; mocks only)
routes ใต้ `/worker/jobs/{id}/…` ทั้ง 4 ตัว ตรวจ `attemptId` + state RUNNING; complete ตรวจ HEAD output ก่อน SUCCEEDED; heartbeat คืน `cancelRequested` และถ้า cancel แล้ว worker ack ด้วย fail code `CANCELLED` → CANCELLED
- [ ] heartbeat/complete จาก attempt เก่า → 409 `STALE_ATTEMPT`
- [ ] complete โดยไม่มี object output → 409 `OUTPUT_MISSING`
- [ ] heartbeat อัปเดต progress และ `heartbeat_at`
- Verify: `pnpm test tests/worker.integration.test.ts`
- Deps: T9
- Files: `web/app/api/v1/worker/jobs/[id]/[action]/route.ts`, `web/lib/worker-jobs.ts`, `web/tests/worker.integration.test.ts`

### T11: Python worker package + mock runner — M ✅ reviewed (42 pytest incl. E2E vs fake API; bt709 in media.py; real web E2E pending creds)
`worker/enhancer_worker/`: `api.py` (requests + timeout + retry), `probe.py` (ffprobe → limits), `encode.py`, `heartbeat.py` (thread ทุก 15 s), `runners/mock.py` (ffmpeg scale 2×), `cli.py` (`run` = claim จนหมดคิวแล้วจบ); `pyproject.toml`
- [ ] `python -m enhancer_worker run --api http://localhost:3000 --runner mock` ทำงานคิวจนหมดและได้ SUCCEEDED
- [ ] input เกิน limit → fail `INPUT_UNSUPPORTED` โดยไม่ประมวลผล
- [ ] pytest ครอบ probe/limits/frame-count check
- Verify: `cd worker && python -m pytest` + รัน E2E กับ `pnpm dev`
- Deps: T10
- Files: `worker/pyproject.toml`, `worker/enhancer_worker/{api,probe,encode,heartbeat,cli}.py`, `worker/enhancer_worker/runners/mock.py`, `worker/tests/`

### T12: Jobs UI — M ✅ reviewed (real Supabase/RustFS flow pending creds)
ปุ่ม "Enhance" บน asset → เลือก preset (ปิดตัวที่ไม่รองรับพร้อมเหตุผล) → สร้าง job; รายการ jobs; หน้า `/jobs/[id]` แสดง state/stage/frames/attempts, poll 3 s ตอน active หยุดเมื่อ terminal หรือ tab ซ่อน, แบนเนอร์ "Colab หลุด?" + Requeue, Cancel, Download
- [ ] เห็น progress เปลี่ยนระหว่าง mock รัน
- [ ] state ไม่ได้สื่อด้วยสีอย่างเดียว (มีข้อความ)
- Verify: manual กับ mock worker
- Deps: T8, T11
- Files: `web/components/preset-picker.tsx`, `web/components/job-list.tsx`, `web/app/(app)/jobs/[id]/page.tsx`, `web/components/job-status.tsx`, `web/app/api/v1/jobs/[id]/media/route.ts`

### T13: Delete asset — S ✅ reviewed (known small race: claim between busy-check and delete)
`DELETE /assets/{id}` ลบ objects input/outputs + rows (บล็อกถ้ามีงาน RUNNING) + ปุ่มในรายการพร้อม confirm
- [ ] ลบแล้ว object หายจาก RustFS และ jobs หายจากรายการ
- [ ] มีงาน RUNNING → 409
- Verify: `pnpm test` + manual
- Deps: T12
- Files: `web/app/api/v1/assets/[id]/route.ts`, `web/components/asset-list.tsx`

### Checkpoint 2
- [ ] E2E mock: success criteria 3 และ 4 ผ่านในเครื่อง; review กับผู้ใช้

---

## Phase 3: Compare viewer

### T14: `useSyncedVideos` — S ✅ reviewed (drift: nudge rate ≤0.15 s, hard seek + 500 ms cooldown; tests in sync-math.test.ts; hook not browser-tested yet → T15)
hook ที่ผูก 2 video: output เป็น master, play/pause/seek ตามกัน, แก้ drift > 1 เฟรม, step ทีละเฟรมจาก FPS ใน `probe`
- [ ] unit test: drift correction, frame step, seek ขอบคลิป
- Verify: `pnpm test`
- Deps: T1 (ขนานกับ Phase 2 ได้)
- Files: `web/components/compare/use-synced-videos.ts`, `web/components/compare/use-synced-videos.test.ts`

### T15: CompareViewer — M ✅ reviewed (headless Chrome verified on /dev/compare; Firefox untested)
wipe slider + side-by-side, zoom 1×–8× + pan (wheel/drag/คีย์ `+ - 0`), smooth/pixelated, ปุ่มเฟรม `← →`, space play/pause, ต้นฉบับปิดเสียง; ใส่ในหน้า job ที่ SUCCEEDED
- [ ] Success criterion 2 ผ่านด้วยผลจาก mock
- [ ] ใช้งานได้ด้วยคีย์บอร์ดอย่างเดียว
- Verify: manual ใน Chrome + Firefox
- Deps: T12, T14
- Files: `web/components/compare/compare-viewer.tsx`, `web/components/compare/zoom-pan.tsx`, `web/app/(app)/jobs/[id]/page.tsx`

### Checkpoint 3
- [ ] หน้าเทียบใช้งานจริงได้; review UX กับผู้ใช้

---

## Phase 3b: Multi-user (เพิ่ม 2026-10-14)

### T20: Allowlist + operator role — M ✅ reviewed (216 tests)
แทน `OWNER_EMAIL` ด้วย `ALLOWED_EMAILS` (comma-separated) และ `OPERATOR_EMAILS`; `requireUser()` (ทุก user route) + `requireOperator()`; `POST/GET /worker-tokens` และหน้า Settings เฉพาะ operator; `requireWorker` ตรวจว่าเจ้าของ token ยังเป็น operator; header แสดงลิงก์ Settings/คิว เฉพาะ operator; `.env.example`
- [ ] อีเมลนอก allowlist → 403; ผู้ใช้ทั่วไปเรียก worker-tokens → 403; token ของคนที่ถูกถอดจาก operator → 401
- [ ] ผู้ใช้ A มองไม่เห็น asset/job ของ B (RLS + query)
- Verify: `pnpm test`
- Deps: T5, T9
- Files: `web/lib/auth.ts`, `web/lib/worker-auth.ts`, `web/app/api/v1/worker-tokens/route.ts`, `web/app/(app)/layout.tsx`, `web/app/(app)/settings/page.tsx`, `.env.example`, tests

### T21: Operator claims across owners + queue page — M ✅ reviewed (223 tests; migration still unpushed)
`claim_job(p_presets)` ไม่กรอง owner (แก้ init migration ได้เพราะยังไม่ push), claim/worker-jobs routes หา job ด้วย id + attempt (ไม่กรอง owner), probe อัปเดต asset ของ job นั้น; `GET /api/v1/operator/queue` + หน้า `/queue` (operator เท่านั้น): งาน QUEUED/RUNNING ของทุกคน (อีเมลเจ้าของ, ชื่อไฟล์, preset, state, stale)
- [ ] Colab ของ operator claim งานของผู้ใช้อื่นได้และ complete สำเร็จ; ผู้ใช้เจ้าของงานเห็นผลในหน้าตัวเอง
- [ ] PGlite test: claim ข้าม owner, FIFO ข้ามผู้ใช้
- Verify: `pnpm test`
- Deps: T20, T10
- Files: `supabase/migrations/20261014000000_init.sql`, `web/app/api/v1/worker/claim/route.ts`, `web/lib/worker-jobs.ts`, `web/app/api/v1/operator/queue/route.ts`, `web/app/(app)/queue/page.tsx`, tests

## Phase 4: GPU จริง + deploy

### T16: Real-ESRGAN runner — M ✅ reviewed (72 pytest; GPU path unverified → T17)
**อัปเดต 2026-10-14:** x2 ใช้ RealESRGAN_x2plus; pipeline 3-thread; NVENC; auto tile/batch — ดู SPEC "Runner performance"
`runners/realesrgan.py` จากสูตร T3: stream decode→enhance→encode, tile ตาม preset และ OOM fallback ลด tile 1 ครั้ง (บันทึก effective config), ส่ง progress, verify output (frame count, duration, audio); weights ใน Drive ตรวจ SHA-256
- [ ] pytest ของ logic (ไม่ต้องใช้ GPU: mock model)
- [ ] รันบน GTX 1650 ในเครื่องกับคลิป 3 s ได้ (ถ้าติดตั้ง CUDA ได้; ถ้าไม่ได้ข้ามไปทดสอบที่ T17)
- Verify: `python -m pytest`
- Deps: T3, T11
- Files: `worker/enhancer_worker/runners/realesrgan.py`, `worker/enhancer_worker/weights.py`, `worker/tests/test_realesrgan.py`, `worker/pyproject.toml`

### T17: Colab notebook + GitHub public + Vercel — M
`worker/colab_runner.ipynb`: เช็ก GPU → mount Drive → อ่าน `ENHANCER_TOKEN`/`ENHANCER_API` จาก Colab Secrets → `pip install git+…#subdirectory=worker` → `run` แล้วจบ; ไม่มี output ที่เผย URL/token. ตรวจ secret ใน repo → **ถามก่อน** สร้าง GitHub public repo + push → **ถามก่อน** deploy Vercel + env + เพิ่ม origin ใน CORS ของ RustFS
- [ ] Success criterion 1 บน Colab T4 ผ่าน Vercel
- [ ] Success criterion 5: grep `.next/static` และ notebook ไม่พบ secret
- [ ] Success criteria 3–4 ผ่านบน deployment
- Verify: รัน notebook จริง + script grep
- Deps: T15, T16
- Files: `worker/colab_runner.ipynb`, `scripts/check-secrets.sh`, `README.md`

### Checkpoint 4
- [ ] Success criteria 1–5 ผ่าน; review กับผู้ใช้

---

## Phase 5: SeedVR2

### T18: Spike — SeedVR2 บน T4 — S (timebox)
เลือก community wrapper ที่รองรับ GGUF + block swap, pin commit, รัน 3B กับคลิป 2–3 s ที่ ~480p บน Colab ฟรี วัด peak VRAM, วินาที/เฟรม, ตรวจ license ของ wrapper/checkpoint
- [ ] `docs/spikes/seedvr2.md` มี GPU, VRAM, เวลา, คลิปยาว/ความละเอียดสูงสุดที่รันได้, คุณภาพเทียบ Real-ESRGAN (ดูผ่าน CompareViewer), สรุป **go/no-go**
- Verify: ผู้ใช้รัน spike บน Colab
- Deps: T17
- Files: `worker/spikes/seedvr2_spike.ipynb`, `docs/spikes/seedvr2.md`

### T19: SeedVR2 runner + preset — M (เฉพาะถ้า T18 = go)
`runners/seedvr2.py` ตามสูตร T18, preset `seedvr2-3b-*` พร้อม limit จากผลวัด, เตือนใน UI ว่าช้าและอาจสร้างรายละเอียดที่ไม่มีจริง
- [ ] job SeedVR2 ผ่าน flow เดิมจนดูในหน้าเทียบได้
- [ ] input เกิน limit ของ preset → 422
- Verify: รันบน Colab + `pnpm test`
- Deps: T18
- Files: `worker/enhancer_worker/runners/seedvr2.py`, `web/lib/contracts/presets.ts`, `worker/tests/test_seedvr2.py`

### Checkpoint 5
- [ ] Success criterion 6 ผ่าน; ปิด MVP
