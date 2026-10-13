'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { CompareViewer } from '@/components/compare/compare-viewer';
import { JobStatus } from '@/components/job-status';
import type { JobDto } from '@/lib/contracts/jobs';
import type { AssetDto } from '@/lib/contracts/uploads';
import type { JobMediaResponse } from '@/lib/media-info';

/** Do not refetch signed URLs more often than this after a playback error. */
const MEDIA_REFETCH_MIN_MS = 10_000;
const DEFAULT_FPS = 30;

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Job status plus, once SUCCEEDED, the original-vs-enhanced compare viewer. */
export function JobDetail({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<JobDto | null>(null);
  const [assetName, setAssetName] = useState<string | undefined>();
  const [media, setMedia] = useState<JobMediaResponse | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const lastMediaFetch = useRef(0);
  const succeeded = job?.state === 'SUCCEEDED';

  const assetId = job?.assetId;
  useEffect(() => {
    if (!assetId) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/v1/assets', { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { assets: AssetDto[] };
        const found = body.assets.find((a) => a.id === assetId);
        if (!cancelled && found) setAssetName(found.filename);
      } catch {
        // The name is cosmetic.
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [assetId]);

  const loadMedia = useCallback(async () => {
    lastMediaFetch.current = Date.now();
    try {
      const res = await fetch(`/api/v1/jobs/${jobId}/media`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setMediaError(body?.error?.message ?? `Could not load the videos (${res.status})`);
        return;
      }
      setMedia(body as JobMediaResponse);
      setMediaError(null);
    } catch {
      setMediaError('Network error while loading the videos.');
    }
  }, [jobId]);

  useEffect(() => {
    if (!succeeded) return;
    const timer = setTimeout(() => void loadMedia(), 0);
    return () => clearTimeout(timer);
  }, [succeeded, loadMedia]);

  const onJobChange = useCallback((next: JobDto) => {
    setJob(next);
  }, []);

  const onMediaError = useCallback(() => {
    if (Date.now() - lastMediaFetch.current >= MEDIA_REFETCH_MIN_MS) void loadMedia();
  }, [loadMedia]);

  const meta = job?.outputMeta && typeof job.outputMeta === 'object' ? (job.outputMeta as Record<string, unknown>) : {};
  const outputWidth = num(meta.width);
  const outputHeight = num(meta.height);
  const fps = media?.input.fps ?? num(meta.fps) ?? DEFAULT_FPS;

  return (
    <div className="flex flex-col gap-8">
      <JobStatus jobId={jobId} assetName={assetName} onJobChange={onJobChange} />

      {succeeded ? (
        <section aria-labelledby="compare-heading" className="flex flex-col gap-3">
          <h2 id="compare-heading" className="text-xl font-semibold">
            Compare
          </h2>
          {mediaError ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {mediaError}{' '}
              <button type="button" className="underline" onClick={() => void loadMedia()}>
                Try again
              </button>
            </p>
          ) : null}
          {media?.output && outputWidth && outputHeight ? (
            <CompareViewer
              inputUrl={media.input.url}
              outputUrl={media.output.url}
              fps={fps}
              outputWidth={outputWidth}
              outputHeight={outputHeight}
              onMediaError={onMediaError}
            />
          ) : media?.output ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              The result has no size information, so it cannot be compared here. Use the download
              button instead.
            </p>
          ) : !mediaError ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading videos...</p>
          ) : null}
        </section>
      ) : null}

      <p>
        <Link href="/jobs" className="text-sm underline underline-offset-2">
          Back to all jobs
        </Link>
      </p>
    </div>
  );
}
