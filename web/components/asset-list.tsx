'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { PresetPicker } from '@/components/preset-picker';
import { ASSETS_CHANGED_EVENT } from '@/lib/client-meta';
import { MIB } from '@/lib/contracts/presets';
import type { AssetDto } from '@/lib/contracts/uploads';

const STATE_TEXT: Record<AssetDto['state'], string> = {
  UPLOADING: 'Uploading (not finished)',
  READY: 'Ready',
  DELETED: 'Deleted',
};

function formatSize(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

function formatDetails(asset: AssetDto): string {
  const { width, height, durationSec } = asset.clientMeta;
  const parts: string[] = [];
  if (width && height) parts.push(`${width}x${height}`);
  if (durationSec) parts.push(`${durationSec.toFixed(1)} s`);
  return parts.length > 0 ? parts.join(', ') : 'unknown';
}

export function AssetList() {
  const [assets, setAssets] = useState<AssetDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [enhanceId, setEnhanceId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/assets', { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setLoadError(body?.error?.message ?? `Could not load files (${res.status})`);
        return;
      }
      setAssets(body.assets as AssetDto[]);
      setLoadError(null);
    } catch {
      setLoadError('Network error while loading files.');
    }
  }, []);

  useEffect(() => {
    // Deferred so the first fetch's setState is not synchronous in the effect.
    const initial = setTimeout(() => void load(), 0);
    const onChanged = () => void load();
    window.addEventListener(ASSETS_CHANGED_EVENT, onChanged);
    return () => {
      clearTimeout(initial);
      window.removeEventListener(ASSETS_CHANGED_EVENT, onChanged);
    };
  }, [load]);

  async function remove(asset: AssetDto) {
    if (
      !window.confirm(
        `Delete "${asset.filename}"? The original file, all enhanced results and their jobs will be removed. This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeletingId(asset.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/v1/assets/${asset.id}`, { method: 'DELETE' });
      if (res.status === 204 || res.status === 404) {
        if (enhanceId === asset.id) setEnhanceId(null);
        setNotice(`Deleted "${asset.filename}".`);
        await load();
        headingRef.current?.focus();
        return;
      }
      const body = await res.json().catch(() => null);
      setNotice(body?.error?.message ?? `Delete failed (${res.status})`);
    } catch {
      setNotice('Network error. Nothing was deleted.');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section aria-labelledby="assets-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2
          id="assets-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-xl font-semibold outline-offset-2"
        >
          Your videos
        </h2>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-zinc-300 px-3 py-1 text-sm dark:border-zinc-700"
        >
          Refresh
        </button>
      </div>

      <p role="status" className="text-sm">
        {notice}
      </p>
      {loadError ? <p role="alert">{loadError}</p> : null}
      {assets === null && !loadError ? <p role="status">Loading...</p> : null}
      {assets?.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">No videos yet. Upload one above.</p>
      ) : null}

      {assets && assets.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {assets.map((asset) => {
            const open = enhanceId === asset.id;
            const panelId = `enhance-${asset.id}`;
            return (
              <li
                key={asset.id}
                className="flex flex-col gap-2 rounded-md border border-zinc-300 p-4 dark:border-zinc-700"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="break-all font-medium">{asset.filename}</h3>
                  <span className="text-sm">
                    State: <strong>{STATE_TEXT[asset.state]}</strong>
                  </span>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm text-zinc-600 dark:text-zinc-400">
                  <dt>Size</dt>
                  <dd>{formatSize(asset.sizeBytes)}</dd>
                  <dt>Resolution / length</dt>
                  <dd>{formatDetails(asset)}</dd>
                  <dt>Uploaded</dt>
                  <dd>
                    <time dateTime={asset.createdAt}>
                      {new Date(asset.createdAt).toLocaleString()}
                    </time>
                  </dd>
                  {asset.latestJob ? (
                    <>
                      <dt>Latest job</dt>
                      <dd>
                        <Link
                          href={`/jobs/${asset.latestJob.id}`}
                          className="underline underline-offset-2"
                        >
                          {asset.latestJob.state} ({asset.latestJob.presetId})
                        </Link>
                      </dd>
                    </>
                  ) : null}
                </dl>

                <div className="flex flex-wrap gap-2">
                  {asset.state === 'READY' ? (
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-controls={panelId}
                      onClick={() => setEnhanceId(open ? null : asset.id)}
                      className="rounded-md bg-zinc-900 px-3 py-1 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                    >
                      Enhance again
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void remove(asset)}
                    disabled={deletingId === asset.id}
                    className="rounded-md border border-zinc-300 px-3 py-1 text-sm disabled:opacity-50 dark:border-zinc-700"
                  >
                    {deletingId === asset.id ? 'Deleting...' : 'Delete'}
                    <span className="sr-only"> {asset.filename}</span>
                  </button>
                </div>

                {open && asset.state === 'READY' ? (
                  <div id={panelId}>
                    <PresetPicker asset={asset} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
