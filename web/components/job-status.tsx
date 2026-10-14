'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  formatDateTime,
  formatFrames,
  isActiveState,
  jobStateText,
  progressPercent,
  stageText,
  stateBadgeClass,
} from '@/components/job-format';
import { usePolling } from '@/components/use-polling';
import { apiErrorText, jobFailureText } from '@/lib/error-messages';
import type { JobDto } from '@/lib/contracts/jobs';
import type { JobMediaResponse } from '@/lib/media-info';

const BUTTON =
  'rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800';

type Props = {
  jobId: string;
  assetName?: string;
  /** Called with every fresh job snapshot (initial load, polls, actions). */
  onJobChange?: (job: JobDto) => void;
};

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return apiErrorText(body, `${fallback} (${res.status})`);
}

/**
 * Live status of one job. Polls every 3 s while QUEUED/RUNNING; polling stops
 * when the job is finished or the tab is hidden and resumes when it is shown.
 */
export function JobStatus({ jobId, assetName, onJobChange }: Props) {
  const [job, setJob] = useState<JobDto | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<'cancel' | 'requeue' | 'download' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const onChangeRef = useRef(onJobChange);

  useEffect(() => {
    onChangeRef.current = onJobChange;
  }, [onJobChange]);

  const apply = useCallback((next: JobDto) => {
    setJob(next);
    setError(null);
    onChangeRef.current?.(next);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/jobs/${jobId}`, { cache: 'no-store' });
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        setError(await errorMessage(res, 'รีเฟรชข้อมูลงานไม่สำเร็จ'));
        return;
      }
      apply((await res.json()) as JobDto);
    } catch {
      setError('เชื่อมต่อไม่ได้ขณะรีเฟรช ระบบจะลองใหม่เองตราบที่เปิดหน้านี้ไว้');
    }
  }, [jobId, apply]);

  useEffect(() => {
    // Deferred so the first fetch's setState is not synchronous in the effect.
    const initial = setTimeout(() => void load(), 0);
    return () => clearTimeout(initial);
  }, [load]);

  // Poll while active (also keeps polling if the very first load failed).
  usePolling(load, !notFound && (job === null || isActiveState(job.state)));

  async function act(action: 'cancel' | 'requeue') {
    if (!job || actionBusy) return;
    if (
      action === 'cancel' &&
      !window.confirm('ต้องการยกเลิกงานนี้หรือไม่? งานที่กำลังทำอยู่จะหยุดเมื่อถึงจุดตรวจสอบความคืบหน้าถัดไป')
    ) {
      return;
    }
    setActionBusy(action);
    setNotice(null);
    try {
      const res = await fetch(`/api/v1/jobs/${job.id}/${action}`, { method: 'POST' });
      if (!res.ok) {
        setError(await errorMessage(res, action === 'cancel' ? 'ยกเลิกไม่สำเร็จ' : 'ส่งกลับเข้าคิวไม่สำเร็จ'));
        // The job may have moved on (finished, claimed); show the truth.
        await load();
        return;
      }
      apply((await res.json()) as JobDto);
      setNotice(action === 'cancel' ? 'ส่งคำขอยกเลิกแล้ว' : 'ส่งงานกลับเข้าคิวแล้ว');
    } catch {
      setError('เชื่อมต่อไม่ได้ กรุณาลองอีกครั้ง');
    } finally {
      setActionBusy(null);
    }
  }

  async function download() {
    if (!job || actionBusy) return;
    setActionBusy('download');
    setError(null);
    try {
      // Signed URLs expire; always ask for a fresh one on click.
      const res = await fetch(`/api/v1/jobs/${job.id}/media`, { cache: 'no-store' });
      if (!res.ok) {
        setError(await errorMessage(res, 'เตรียมดาวน์โหลดไม่สำเร็จ'));
        return;
      }
      const media = (await res.json()) as JobMediaResponse;
      if (!media.output) {
        setError('ยังไม่มีไฟล์ผลลัพธ์');
        return;
      }
      const link = document.createElement('a');
      link.href = media.output.downloadUrl;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch {
      setError('เชื่อมต่อไม่ได้ กรุณาลองอีกครั้ง');
    } finally {
      setActionBusy(null);
    }
  }

  if (notFound) {
    return (
      <p role="alert" className="text-red-700 dark:text-red-400">
        ไม่พบงานนี้
      </p>
    );
  }
  if (!job) {
    return (
      <div>
        {error ? (
          <p role="alert" className="text-red-700 dark:text-red-400">
            {error}
          </p>
        ) : (
          <p className="text-zinc-600 dark:text-zinc-400">กำลังโหลดข้อมูลงาน...</p>
        )}
      </div>
    );
  }

  const active = isActiveState(job.state);
  const percent = progressPercent(job.processedFrames, job.totalFrames);
  const frames = formatFrames(job.processedFrames, job.totalFrames);
  const stage = stageText(job.stage);
  const showStale = job.state === 'RUNNING' && job.stale;

  return (
    <section aria-label="สถานะงาน" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`inline-flex items-center rounded-full border px-3 py-0.5 text-sm font-medium ${stateBadgeClass(job.state)}`}
        >
          {jobStateText(job)}
        </span>
        <span className="text-sm text-zinc-600 dark:text-zinc-400">
          {assetName ? `${assetName} · ` : ''}
          {job.presetId}
        </span>
      </div>

      {/* Announce state changes to assistive tech without announcing every frame count. */}
      <p className="sr-only" role="status" aria-live="polite">
        สถานะงาน: {jobStateText(job)}
        {stage ? `, ${stage}` : ''}
      </p>

      {job.state === 'QUEUED' && !job.cancelRequested ? (
        <p className="rounded-md border border-zinc-300 p-3 text-sm dark:border-zinc-700">
          งานอยู่ในคิว: เปิด Colab notebook แล้วกดรันเพื่อให้ worker รับงานนี้ (หน้านี้จะอัปเดตอัตโนมัติ)
        </p>
      ) : null}

      {showStale ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-md border border-amber-600 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-500 dark:bg-amber-950 dark:text-amber-100"
        >
          <span>
            Colab อาจขาดการเชื่อมต่อ? ไม่ได้รับสัญญาณจาก worker เกิน 3 นาที (heartbeat ล่าสุด:{' '}
            {formatDateTime(job.heartbeatAt)})
          </span>
          <button
            type="button"
            onClick={() => void act('requeue')}
            disabled={actionBusy !== null}
            className={BUTTON}
          >
            {actionBusy === 'requeue' ? 'กำลังส่งกลับเข้าคิว...' : 'ส่งกลับเข้าคิว'}
          </button>
        </div>
      ) : null}

      {job.state === 'RUNNING' || job.state === 'SUCCEEDED' || frames ? (
        <div className="flex flex-col gap-1">
          {stage && job.state === 'RUNNING' ? <p className="text-sm">ขั้นตอน: {stage}</p> : null}
          {percent !== null ? (
            <progress
              className="h-3 w-full"
              max={job.totalFrames ?? 0}
              value={job.processedFrames ?? 0}
              aria-label="เฟรมที่ประมวลผลแล้ว"
            />
          ) : null}
          {frames ? <p className="text-sm tabular-nums">{frames}</p> : null}
        </div>
      ) : null}

      {job.state === 'FAILED' || (job.state === 'CANCELLED' && job.errorCode) ? (
        <div role="alert" className="text-sm text-red-700 dark:text-red-400">
          <p>
            {job.state === 'FAILED' ? 'งานล้มเหลว' : 'งานถูกยกเลิก'}
            {job.errorCode ? ` (${job.errorCode})` : ''}
          </p>
          {job.errorCode ? (
            job.errorCode === 'CANCELLED' ? null : (
              <p>{jobFailureText(job.errorCode, job.errorMessage)}</p>
            )
          ) : job.errorMessage ? (
            <p>{job.errorMessage}</p>
          ) : null}
        </div>
      ) : null}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-zinc-600 dark:text-zinc-400">จำนวนครั้งที่ลอง</dt>
        <dd>{job.attemptCount}</dd>
        <dt className="text-zinc-600 dark:text-zinc-400">สร้างเมื่อ</dt>
        <dd>{formatDateTime(job.createdAt)}</dd>
        <dt className="text-zinc-600 dark:text-zinc-400">เริ่มเมื่อ</dt>
        <dd>{formatDateTime(job.startedAt)}</dd>
        <dt className="text-zinc-600 dark:text-zinc-400">Heartbeat ล่าสุด</dt>
        <dd>{formatDateTime(job.heartbeatAt)}</dd>
        <dt className="text-zinc-600 dark:text-zinc-400">เสร็จเมื่อ</dt>
        <dd>{formatDateTime(job.finishedAt)}</dd>
      </dl>

      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-zinc-700 dark:text-zinc-300">
          {notice}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {active ? (
          <button
            type="button"
            onClick={() => void act('cancel')}
            disabled={job.cancelRequested || actionBusy !== null}
            className={BUTTON}
          >
            {job.cancelRequested || actionBusy === 'cancel' ? 'กำลังยกเลิก…' : 'ยกเลิก'}
          </button>
        ) : null}
        {job.state === 'FAILED' ? (
          <button
            type="button"
            onClick={() => void act('requeue')}
            disabled={actionBusy !== null}
            className={BUTTON}
          >
            {actionBusy === 'requeue' ? 'กำลังส่งกลับเข้าคิว...' : 'ส่งกลับเข้าคิว'}
          </button>
        ) : null}
        {job.state === 'SUCCEEDED' ? (
          <button
            type="button"
            onClick={() => void download()}
            disabled={actionBusy !== null}
            className={BUTTON}
          >
            {actionBusy === 'download' ? 'กำลังเตรียมดาวน์โหลด...' : 'ดาวน์โหลดวิดีโอที่ปรับปรุงแล้ว'}
          </button>
        ) : null}
      </div>
    </section>
  );
}
