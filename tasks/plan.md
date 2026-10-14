# Implementation Plan: Video Enhancer (ส่วนตัว)

อ้างอิง: `SPEC.md` v2.1 • รายละเอียด task + acceptance อยู่ใน `tasks/todo.md`

## Overview

Next.js บน Vercel (UI + `/api/v1`) + Supabase (Auth/Postgres) + R2 (ไฟล์) + Colab ฟรี (GPU, กดรันเอง) สำหรับผู้ใช้คนเดียว ส่งมอบ Real-ESRGAN end-to-end พร้อมหน้าเทียบ side-by-side ก่อน แล้วค่อย spike SeedVR2

## Architecture Decisions

- **Spike ความเสี่ยงสูงก่อนเขียน feature**: R2 presign/CORS (T2) และการติดตั้ง Real-ESRGAN บน Colab T4 (T3) ถ้าพังต้องรู้ก่อนวางโค้ดทับ
- **Mock runner ก่อน GPU จริง**: worker Python มี `--runner mock` (ffmpeg scale) เพื่อพิสูจน์ API/state ทั้งหมดในเครื่องโดยไม่ใช้ Colab
- **`claim_job` เป็น RPC ตัวเดียวที่ใช้ SQL function** ที่เหลือเป็น `update ... where attempt_id = ? and state = 'RUNNING'` คำสั่งเดียว (atomic พออยู่แล้ว)
- **User routes ใช้ SSR client + RLS**; worker routes ใช้ admin client หลังตรวจ worker token hash (worker ไม่มี Supabase session)
- **Deploy/push ช้าที่สุดเท่าที่ทำได้**: ทุกอย่างถึง Checkpoint 3 ทำบน `localhost` + Supabase dev + R2; Colab ต้องใช้ URL สาธารณะ จึงขึ้น Vercel + GitHub public ที่ Phase 4 (ถามก่อน)

## Dependency graph

```
T1 scaffold ─┬─ T4 DB schema ─ T5 auth ─ T6 upload API ─ T7 upload UI
T2 R2 ──────┘                    │
T3 ESRGAN spike (Colab, ขนานได้)   ├─ T8 jobs API ─┬─ T12 jobs UI ─ T13 delete asset
                                  └─ T9 worker auth+claim ─ T10 worker lifecycle ─ T11 Python worker+mock
                                                   T14 sync hook ─ T15 compare viewer (ต้องมี T12)
T3 + T11 ─ T16 ESRGAN runner ─ T17 notebook + deploy ─ T18 SeedVR2 spike ─ T19 SeedVR2 preset (ถ้า go)
```

## Task List

### Phase 0: Foundation + spikes
- [ ] T1 Scaffold repo + Next.js
- [ ] T2 Spike: R2 presign/CORS (RustFS attempt failed: `docs/spikes/rustfs.md`)
- [ ] T3 Spike: Real-ESRGAN บน Colab T4

**Checkpoint 0** — build ผ่าน, R2 พร้อม, รู้สูตรติดตั้ง Real-ESRGAN → review กับผู้ใช้

### Phase 1: Auth + upload
- [ ] T4 Supabase schema + RLS + `claim_job`
- [ ] T5 Login + owner guard
- [ ] T6 Storage lib + upload API
- [ ] T7 Upload UI + asset list

**Checkpoint 1** — login แล้วอัปโหลดคลิปได้จริง เห็นใน R2 และในรายการ

### Phase 2: Job lifecycle (mock)
- [ ] T8 Presets + jobs API (create/list/get/cancel/requeue)
- [ ] T9 Worker token + worker auth + claim
- [ ] T10 Worker heartbeat/output-url/complete/fail
- [ ] T11 Python worker package + mock runner
- [ ] T12 Jobs UI (list, detail, polling, stale, download)
- [ ] T13 Delete asset

**Checkpoint 2** — E2E mock ในเครื่อง: upload → job → `run --runner mock` → SUCCEEDED → download; kill กลางงาน → stale → requeue; attempt เก่าได้ 409

### Phase 3: Compare viewer
- [ ] T14 `useSyncedVideos` + unit tests
- [ ] T15 CompareViewer (wipe/side-by-side, zoom/pan, keyboard)

**Checkpoint 3** — Success criterion 2 ผ่านด้วยผลจาก mock

### Phase 4: GPU จริง + deploy
- [ ] T16 Real-ESRGAN runner
- [ ] T17 Colab notebook + GitHub public + Vercel deploy

**Checkpoint 4** — Success criteria 1–5 บน Vercel + Colab T4

### Phase 5: SeedVR2
- [ ] T18 Spike SeedVR2 บน T4 → go/no-go
- [ ] T19 SeedVR2 runner + preset (เฉพาะถ้า go)

**Checkpoint 5** — Success criterion 6

## Parallelization

- T3 (Colab, ผู้ใช้รันเอง) ขนานกับ T1/T2/T4–T7 ได้
- T14 (logic ล้วน) ขนานกับ Phase 2 ได้
- T9–T10 กับ T11 ต้องตกลง contract ใน `lib/contracts/worker.ts` ก่อน (ทำใน T9)

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| R2 presign/CORS ไม่เข้ากับ AWS SDK | High | T2 ก่อนอย่างอื่น; ทางสำรอง: proxy CORS ที่ reverse proxy |
| `basicsr` import พังกับ torchvision ใหม่บน Colab | High | T3 หา pin/patch ที่ใช้ได้ บันทึกใน `docs/spikes/realesrgan.md` |
| Colab ฟรีไม่ได้ GPU / หลุด | Med | คลิปทดสอบสั้น; requeue; ใช้ mock ทดสอบ flow |
| Encode 4K บน CPU Colab ช้า | Med | วัดใน T3; ใช้ `h264_nvenc` ถ้า T4 รองรับใน ffmpeg ของ Colab |
| Secret หลุดเมื่อ repo เป็น public | High | `.gitignore`/`.env.example` ใน T1; ตรวจก่อน push ใน T17 |
| SeedVR2 ไม่ fit T4 | Low (ยอมรับ no-go) | T18 timebox; T19 ทำเฉพาะถ้า go |

## ต้องการจากผู้ใช้ (ตามลำดับเวลา)

1. T2: R2 endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, bucket `video-enhancer`, access key/secret ของแอป, CORS ตาม SPEC
2. T3: รัน spike notebook บน Colab แล้วส่งผล output cell กลับมา
3. T4: Supabase dev project URL + publishable key + secret key, ปิด signup, สร้าง user ของคุณ; อนุมัติ `db push`
4. T17: อนุมัติสร้าง GitHub public repo + push และ deploy Vercel; ใส่ env บน Vercel
