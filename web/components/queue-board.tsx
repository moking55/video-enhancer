'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  formatDateTime,
  formatFrames,
  jobStateText,
  stageText,
  stateBadgeClass,
} from '@/components/job-format';
import { usePolling } from '@/components/use-polling';
import { apiErrorText } from '@/lib/error-messages';
import type { QueueItem, QueueResponse } from '@/lib/contracts/queue';

const QUEUE_POLL_MS = 5000;

/** Operator view of everyone's jobs. Polls every 5 s while the tab is visible. */
export function QueueBoard() {
  const [jobs, setJobs] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/operator/queue', { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(apiErrorText(body, `โหลดคิวไม่สำเร็จ (${res.status})`));
        return;
      }
      setJobs((body as QueueResponse).jobs);
      setError(null);
    } catch {
      setError('เชื่อมต่อไม่ได้ขณะโหลดคิว');
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  usePolling(load, true, QUEUE_POLL_MS);

  if (error && !jobs) {
    return (
      <p role="alert" className="text-red-700 dark:text-red-400">
        {error}
      </p>
    );
  }
  if (!jobs) return <p className="text-zinc-600 dark:text-zinc-400">กำลังโหลดคิว...</p>;

  const waiting = jobs.filter((j) => j.state === 'QUEUED').length;

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <p role="status" className="rounded-md border border-zinc-300 p-3 text-sm dark:border-zinc-700">
        {waiting > 0
          ? `มีงานรออยู่ในคิว ${waiting} งาน เปิด Colab notebook แล้วกดรัน`
          : 'ไม่มีงานที่รออยู่'}
      </p>
      {jobs.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          ไม่มีงานที่รอคิว กำลังทำงาน หรือเพิ่งเสร็จ
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {jobs.map((job) => {
            const frames =
              job.state === 'RUNNING' ? formatFrames(job.processedFrames, job.totalFrames) : null;
            const stage = job.state === 'RUNNING' ? stageText(job.stage) : null;
            return (
              <li key={job.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {job.filename ?? `งาน ${job.id.slice(0, 8)}`}
                  </p>
                  <p className="truncate text-sm text-zinc-600 dark:text-zinc-400">
                    {job.ownerEmail ?? 'ไม่ทราบผู้ใช้'}
                  </p>
                </div>
                <span className="text-sm text-zinc-600 dark:text-zinc-400">{job.presetId}</span>
                <span
                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${stateBadgeClass(job.state)}`}
                >
                  {jobStateText({ ...job, cancelRequested: false })}
                </span>
                {stage || frames ? (
                  <span className="text-sm tabular-nums text-zinc-600 dark:text-zinc-400">
                    {[stage, frames].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
                <time dateTime={job.createdAt} className="text-sm text-zinc-600 dark:text-zinc-400">
                  {formatDateTime(job.createdAt)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
