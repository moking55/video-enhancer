'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type DragEvent } from 'react';

import { PresetOptions, usePresets } from '@/components/preset-options';
import { Button, buttonClass } from '@/components/ui/button';
import {
  ASSETS_CHANGED_EVENT,
  checkClientLimits,
  readVideoMeta,
  type VideoMeta,
} from '@/lib/client-meta';
import { MIB } from '@/lib/contracts/presets';
import type { CreateUploadResponse } from '@/lib/contracts/uploads';
import { apiErrorText } from '@/lib/error-messages';
import { buildPresetRows, compatReasonTh, resolveChosenPresetId } from '@/lib/preset-options';

/** User-facing strings of this component (kept together for translation). */
const TEXT = {
  networkError: 'เชื่อมต่อไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง',
  requestFailed: (status: number) => `ส่งคำขอไม่สำเร็จ (${status})`,
  uploadFailed: (status: number) => `อัปโหลดไม่สำเร็จ (${status})`,
  linkExpired: ' ลิงก์อัปโหลดอาจหมดอายุแล้ว',
  networkUploading: 'เชื่อมต่อไม่ได้ขณะอัปโหลด',
  uploadCancelled: 'ยกเลิกการอัปโหลดแล้ว',
  resolutionUnknown: ' (อ่านความละเอียดและความยาวไม่ได้)',
  fileLabel: '1. ไฟล์วิดีโอ (MP4)',
  fileHint: 'รองรับเฉพาะ MP4 ขนาดไม่เกิน 500 MiB ยาวไม่เกิน 120 วินาที และความละเอียดไม่เกิน 1920×1080',
  reading: 'กำลังอ่านข้อมูลวิดีโอ...',
  cannotUpload: 'ไม่สามารถอัปโหลดไฟล์นี้ได้:',
  loadingPresets: 'กำลังโหลดรายการ preset...',
  presetLegend: '2. เลือก preset สำหรับปรับปรุงคุณภาพ',
  progressLabel: 'ความคืบหน้าการอัปโหลด',
  queuing: 'อัปโหลดเสร็จแล้ว กำลังเพิ่มเข้าคิว...',
  queuedPrefix: 'เข้าคิวแล้ว:',
  viewJob: 'ดูสถานะงาน',
  jobFailedPrefix: 'อัปโหลดวิดีโอแล้ว แต่เพิ่มเข้าคิวไม่สำเร็จ: ',
  somethingWrong: 'เกิดข้อผิดพลาดบางอย่าง',
  tryAgain: 'ลองอีกครั้ง',
  alreadyUploaded: 'อัปโหลดไฟล์เรียบร้อยแล้ว การลองอีกครั้งจะไม่อัปโหลดซ้ำ',
  btnUploading: 'กำลังอัปโหลด...',
  btnQueuing: 'กำลังเข้าคิว...',
  btnIdle: 'อัปโหลดและเริ่มประมวลผล',
  pickFile: 'เลือกไฟล์วิดีโอ',
  changeFile: 'เปลี่ยนไฟล์',
  dropHint: 'หรือลากไฟล์ MP4 มาวางที่นี่',
  dropActive: 'ปล่อยเมาส์เพื่อเลือกไฟล์นี้',
  hintNoFile: 'เลือกไฟล์และ preset ก่อน',
  hintBlocked: 'ไฟล์นี้อัปโหลดไม่ได้ ดูเหตุผลด้านบน',
  hintNoPreset: 'ไม่มี preset ที่ใช้กับไฟล์นี้ได้ ลองเลือกไฟล์อื่น',
  hintFailed: 'กดปุ่ม “ลองอีกครั้ง” ด้านบน หรือเลือกไฟล์ใหม่',
} as const;

type Phase = 'idle' | 'reading' | 'ready' | 'uploading' | 'queuing' | 'error';
/** Which step failed, so the error text and "Try again" make sense. */
type Stage = 'upload' | 'job';
type QueuedNotice = { jobId: string; filename: string; presetLabel: string };

class UploadError extends Error {
  /** API `error.code`, when the failure came from an API response. */
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

async function apiJson<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new UploadError(TEXT.networkError);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const code = typeof body?.error?.code === 'string' ? body.error.code : undefined;
    throw new UploadError(apiErrorText(body, TEXT.requestFailed(res.status)), code);
  }
  return body as T;
}

function putFile(
  target: CreateUploadResponse,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', target.putUrl);
    for (const [name, value] of Object.entries(target.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      const expired =
        xhr.status === 403 || Date.now() > Date.parse(target.expiresAt) ? TEXT.linkExpired : '';
      reject(new UploadError(`${TEXT.uploadFailed(xhr.status)}${expired}`));
    };
    xhr.onerror = () => reject(new UploadError(TEXT.networkUploading));
    xhr.onabort = () => reject(new UploadError(TEXT.uploadCancelled));
    xhr.send(file);
  });
}

function describeMeta(file: File, meta: VideoMeta): string {
  const parts = [`${(file.size / MIB).toFixed(1)} MiB`];
  if (meta.width && meta.height) parts.push(`${meta.width}×${meta.height}`);
  if (meta.durationSec) parts.push(`${meta.durationSec.toFixed(1)} วินาที`);
  return parts.join(', ');
}

/**
 * Pick a file, pick a preset, one click: upload, complete and create the job.
 * Afterwards the form resets to its initial state and shows a "Queued" notice
 * with a link to the job (no automatic navigation). The job API has no
 * idempotency key, so double submits are blocked with a synchronous in-flight
 * flag that every code path clears in `finally`.
 */
export function UploadForm() {
  const inputId = useId();
  const hintId = useId();
  const labelId = useId();
  const submitHintId = useId();
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState<VideoMeta>({});
  const [phase, setPhase] = useState<Phase>('idle');
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errorStage, setErrorStage] = useState<Stage>('upload');
  const [percent, setPercent] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [queued, setQueued] = useState<QueuedNotice | null>(null);
  const { presets, loadError } = usePresets();
  const inputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  /** Set once the bytes are stored, so a retry only needs to call complete. */
  const uploadedAssetId = useRef<string | null>(null);
  /** Set once the asset is READY, so a retry only needs to create the job. */
  const readyAssetId = useRef<string | null>(null);
  /** Synchronous guard against a double click before React re-renders. */
  const inFlight = useRef(false);
  /** Guards stale metadata reads when the user picks another file quickly. */
  const selection = useRef(0);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const rows = buildPresetRows(presets ?? [], {
    width: meta.width,
    height: meta.height,
    durationSec: meta.durationSec,
    sizeBytes: file?.size,
  });
  const chosen = resolveChosenPresetId(rows, selected);
  const working = phase === 'uploading' || phase === 'queuing';
  const blocked = problems.length > 0;
  const failed = phase === 'error';
  const canSubmit = !!file && !blocked && !!chosen && phase === 'ready';
  /** Why the main button is disabled (shown next to it); null when enabled or busy. */
  const submitHint =
    canSubmit || working
      ? null
      : !file
        ? TEXT.hintNoFile
        : phase === 'reading'
          ? TEXT.reading
          : blocked
            ? TEXT.hintBlocked
            : !presets
              ? TEXT.loadingPresets
              : !chosen
                ? TEXT.hintNoPreset
                : failed
                  ? TEXT.hintFailed
                  : null;

  async function handleFile(picked: File | null) {
    const token = ++selection.current;
    uploadedAssetId.current = null;
    readyAssetId.current = null;
    setError(null);
    setQueued(null);
    setPercent(0);
    setFile(picked);
    setMeta({});
    setProblems([]);
    if (!picked) {
      setPhase('idle');
      return;
    }
    setPhase('reading');
    const read = await readVideoMeta(picked);
    if (token !== selection.current) return;
    setMeta(read);
    setProblems(checkClientLimits(picked, read));
    setPhase('ready');
  }

  function onDragOver(e: DragEvent<HTMLElement>) {
    if (working) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  }

  function onDragLeave(e: DragEvent<HTMLElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
  }

  function onDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files?.[0];
    if (working || !dropped) return;
    // Keep the real <input> in sync so "choose again" and the reset behave.
    if (inputRef.current) inputRef.current.files = e.dataTransfer.files;
    void handleFile(dropped);
  }

  /** Back to the initial state once a job was created. */
  function resetForm() {
    selection.current++; // drop any in-flight metadata read
    uploadedAssetId.current = null;
    readyAssetId.current = null;
    if (inputRef.current) inputRef.current.value = '';
    setFile(null);
    setMeta({});
    setProblems([]);
    setError(null);
    setErrorStage('upload');
    setPercent(0);
    setSelected(null);
    setPhase('idle');
  }

  async function submit() {
    if (!file || problems.length > 0 || !chosen || inFlight.current) return;
    inFlight.current = true;
    let stage: Stage = 'upload';
    setError(null);
    setQueued(null);
    try {
      if (!readyAssetId.current) {
        setPercent(0);
        setPhase('uploading');
        let assetId = uploadedAssetId.current;
        if (!assetId) {
          const target = await apiJson<CreateUploadResponse>('/api/v1/uploads', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filename: file.name,
              sizeBytes: file.size,
              contentType: 'video/mp4',
              clientMeta: meta,
            }),
          });
          await putFile(target, file, (f) => setPercent(Math.round(f * 100)));
          assetId = target.assetId;
          uploadedAssetId.current = assetId;
        }
        setPercent(100);
        await apiJson(`/api/v1/assets/${assetId}/complete`, { method: 'POST' });
        uploadedAssetId.current = null;
        readyAssetId.current = assetId;
        window.dispatchEvent(new Event(ASSETS_CHANGED_EVENT));
      }

      stage = 'job';
      setPhase('queuing');
      const job = await apiJson<{ id: string }>('/api/v1/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: readyAssetId.current, presetId: chosen }),
      });
      const presetLabel = presets?.find((p) => p.id === chosen)?.label ?? chosen;
      const filename = file.name;
      resetForm();
      setQueued({ jobId: job.id, filename, presetLabel });
      window.dispatchEvent(new Event(ASSETS_CHANGED_EVENT));
    } catch (err) {
      let message = err instanceof Error ? err.message : TEXT.somethingWrong;
      if (err instanceof UploadError && (err.code === 'PRESET_INCOMPATIBLE' || err.code === 'PRESET_TOO_SLOW')) {
        // Precise Thai reason from the same pure check the preset list uses.
        const row = rows.find((r) => r.preset.id === chosen);
        const reason = row ? compatReasonTh(row.compat, row.preset.label) : null;
        if (reason) message = reason;
      }
      setErrorStage(stage);
      setError(stage === 'job' ? `${TEXT.jobFailedPrefix}${message}` : message);
      setPhase('error');
      // An abandoned UPLOADING asset may exist; make it visible for cleanup.
      window.dispatchEvent(new Event(ASSETS_CHANGED_EVENT));
    } finally {
      inFlight.current = false;
    }
  }


  return (
    <form
      className="flex flex-col gap-4 rounded-lg border border-zinc-300 p-4 sm:p-6 dark:border-zinc-700"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-col gap-2">
        <span id={labelId} className="text-sm font-medium">
          {TEXT.fileLabel}
        </span>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept="video/mp4,.mp4"
          onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
          disabled={working}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          className="peer sr-only"
        />
        {/* The label is the dropzone: clicking it opens the picker, dropping a file selects it. */}
        <label
          htmlFor={inputId}
          onDragEnter={onDragOver}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={`flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-4 py-6 text-center peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-blue-600 ${
            working
              ? 'cursor-not-allowed border-zinc-300 opacity-60 dark:border-zinc-700'
              : dragOver
                ? 'cursor-copy border-blue-600 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/40'
                : 'cursor-pointer border-zinc-400 hover:border-blue-600 hover:bg-zinc-50 dark:border-zinc-600 dark:hover:border-blue-400 dark:hover:bg-zinc-900'
          }`}
        >
          <span
            className={buttonClass({
              variant: 'secondary',
              size: 'md',
              className: 'pointer-events-none w-full sm:w-auto',
            })}
          >
            {file ? TEXT.changeFile : TEXT.pickFile}
          </span>
          <span className="hidden text-sm text-zinc-600 sm:block dark:text-zinc-400">
            {dragOver ? TEXT.dropActive : TEXT.dropHint}
          </span>
        </label>
        <p id={hintId} className="text-sm text-zinc-600 dark:text-zinc-400">
          {TEXT.fileHint}
        </p>
      </div>

      {phase === 'reading' ? <p role="status">{TEXT.reading}</p> : null}

      {file && phase !== 'reading' ? (
        <p className="break-all rounded-lg bg-zinc-100 p-3 text-sm dark:bg-zinc-900">
          <strong>{file.name}</strong>: {describeMeta(file, meta)}
          {meta.width ? '' : TEXT.resolutionUnknown}
        </p>
      ) : null}

      {blocked ? (
        <div role="alert" className="text-sm">
          <p className="font-medium">{TEXT.cannotUpload}</p>
          <ul className="list-disc pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {loadError ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {loadError}
        </p>
      ) : !presets ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{TEXT.loadingPresets}</p>
      ) : (
        <PresetOptions
          rows={rows}
          chosen={chosen}
          onChange={setSelected}
          disabled={working}
          legend={TEXT.presetLegend}
          hideIncompatible={!!file && phase !== 'reading'}
        />
      )}

      {working || (failed && percent > 0) ? (
        <div className="flex items-center gap-2">
          <progress
            value={percent}
            max={100}
            aria-label={TEXT.progressLabel}
            className="h-3 flex-1"
          />
          <span className="w-12 text-right text-sm tabular-nums">{percent}%</span>
        </div>
      ) : null}

      {phase === 'queuing' ? <p role="status">{TEXT.queuing}</p> : null}

      {queued ? (
        <p
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-green-700 p-3 text-sm text-green-900 dark:border-green-500 dark:text-green-200"
        >
          <span>
            {TEXT.queuedPrefix} {queued.filename} — {queued.presetLabel}
          </span>
          <Link
            href={`/jobs/${queued.jobId}`}
            className={buttonClass({ variant: 'secondary', size: 'sm' })}
          >
            {TEXT.viewJob}
          </Link>
        </p>
      ) : null}

      {error ? (
        <div
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="flex flex-wrap items-center gap-3 text-sm text-red-700 dark:text-red-400"
        >
          <span>{error}</span>
          <Button variant="secondary" size="sm" onClick={() => void submit()} disabled={!chosen}>
            {TEXT.tryAgain}
          </Button>
          {errorStage === 'job' ? (
            <span className="text-zinc-600 dark:text-zinc-400">{TEXT.alreadyUploaded}</span>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <Button
          type="submit"
          variant="primary"
          size="lg"
          fullWidth
          disabled={!canSubmit}
          aria-describedby={submitHint ? submitHintId : undefined}
          className="sm:w-auto sm:min-w-72 sm:self-start"
        >
          {phase === 'uploading'
            ? TEXT.btnUploading
            : phase === 'queuing'
              ? TEXT.btnQueuing
              : TEXT.btnIdle}
        </Button>
        {submitHint ? (
          <p id={submitHintId} className="text-sm text-zinc-600 dark:text-zinc-400">
            {submitHint}
          </p>
        ) : null}
      </div>
    </form>
  );
}
