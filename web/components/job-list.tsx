'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import {
  formatDateTime,
  formatFrames,
  isActiveState,
  jobStateText,
  stageText,
  stateBadgeClass,
} from '@/components/job-format';
import { usePolling } from '@/components/use-polling';
import { apiErrorText } from '@/lib/error-messages';
import type { JobDto } from '@/lib/contracts/jobs';
import type { AssetDto } from '@/lib/contracts/uploads';

const LIST_LIMIT = 30;

/** Recent jobs, newest first. Refreshes every 3 s while any job is active. */
export function JobList() {
  const [jobs, setJobs] = useState<JobDto[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/jobs?limit=${LIST_LIMIT}`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(apiErrorText(body, `โหลดรายการงานไม่สำเร็จ (${res.status})`));
        return;
      }
      setJobs(body.jobs as JobDto[]);
      setError(null);
    } catch {
      setError('เชื่อมต่อไม่ได้ขณะโหลดรายการงาน');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      void load();
      try {
        const res = await fetch('/api/v1/assets', { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { assets: AssetDto[] };
        if (cancelled) return;
        setNames(Object.fromEntries(body.assets.map((a) => [a.id, a.filename])));
      } catch {
        // File names are cosmetic; rows fall back to a short id.
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [load]);

  usePolling(load, jobs === null || jobs.some((j) => isActiveState(j.state)));

  if (error && !jobs) {
    return (
      <p role="alert" className="text-red-700 dark:text-red-400">
        {error}
      </p>
    );
  }
  if (!jobs) return <p className="text-zinc-600 dark:text-zinc-400">กำลังโหลดรายการงาน...</p>;
  if (jobs.length === 0) {
    return (
      <p className="text-zinc-600 dark:text-zinc-400">
        ยังไม่มีงาน อัปโหลดวิดีโอที่{' '}
        <Link href="/" className="underline underline-offset-2">
          หน้าแรก
        </Link>{' '}
        แล้วกด &quot;ปรับปรุงคุณภาพ&quot;
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <ul className="flex flex-col divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {jobs.map((job) => {
          const frames = job.state === 'RUNNING' ? formatFrames(job.processedFrames, job.totalFrames) : null;
          const stage = job.state === 'RUNNING' ? stageText(job.stage) : null;
          const name = names[job.assetId] ?? `วิดีโอ ${job.assetId.slice(0, 8)}`;
          return (
            <li key={job.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3">
              <Link
                href={`/jobs/${job.id}`}
                className="min-w-0 flex-1 truncate font-medium underline underline-offset-2"
              >
                {name}
                <span className="sr-only"> ({job.presetId} เปิดดูรายละเอียดงาน)</span>
              </Link>
              <span className="text-sm text-zinc-600 dark:text-zinc-400">{job.presetId}</span>
              <span
                className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${stateBadgeClass(job.state)}`}
              >
                {jobStateText(job)}
              </span>
              {stage || frames ? (
                <span className="text-sm tabular-nums text-zinc-600 dark:text-zinc-400">
                  {[stage, frames].filter(Boolean).join(' · ')}
                </span>
              ) : null}
              <time
                dateTime={job.createdAt}
                className="text-sm text-zinc-600 dark:text-zinc-400"
              >
                {formatDateTime(job.createdAt)}
              </time>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
