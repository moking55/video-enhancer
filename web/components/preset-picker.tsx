'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { PresetOptions, usePresets } from '@/components/preset-options';
import type { AssetDto } from '@/lib/contracts/uploads';
import { buildPresetRows, resolveChosenPresetId } from '@/lib/preset-options';

/**
 * "Enhance again" for an existing asset: lists the presets, disables the ones
 * the asset cannot use (with the reason), and creates a job. The server
 * re-checks everything (422 is shown as-is).
 */
export function PresetPicker(props: { asset: AssetDto; onCreated?: (jobId: string) => void }) {
  const { asset, onCreated } = props;
  const router = useRouter();
  const { presets, loadError } = usePresets();
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = buildPresetRows(presets ?? [], {
    width: asset.clientMeta.width,
    height: asset.clientMeta.height,
    durationSec: asset.clientMeta.durationSec,
    sizeBytes: asset.sizeBytes,
  });
  const chosen = resolveChosenPresetId(rows, selected);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: asset.id, presetId: chosen }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? `Could not create the job (${res.status})`);
        return;
      }
      const jobId = String(body.id);
      if (onCreated) onCreated(jobId);
      else router.push(`/jobs/${jobId}`);
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <p role="alert" className="text-sm text-red-700 dark:text-red-400">
        {loadError}
      </p>
    );
  }
  if (!presets) {
    return <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading presets...</p>;
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <PresetOptions rows={rows} chosen={chosen} onChange={setSelected} disabled={busy} />

      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <div>
        <button
          type="submit"
          disabled={!chosen || busy}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {busy ? 'Creating job...' : 'Start enhancing'}
        </button>
        {!chosen ? (
          <span className="ml-3 text-sm text-zinc-600 dark:text-zinc-400">
            No preset fits this video.
          </span>
        ) : null}
      </div>
    </form>
  );
}
