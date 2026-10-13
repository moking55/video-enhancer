'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, type FormEvent } from 'react';

import { checkPresetCompatibility, type Preset } from '@/lib/contracts/presets';
import type { AssetDto } from '@/lib/contracts/uploads';

type PresetOption = Pick<Preset, 'id' | 'label' | 'model' | 'scale' | 'maxInput' | 'limits'> & {
  note: string | null;
};

/** `AssetDto.clientMeta` uses `durationSec`; the preset check reads `duration`. */
function toCheckMeta(asset: AssetDto) {
  const { width, height, durationSec } = asset.clientMeta;
  return { width, height, duration: durationSec };
}

/**
 * Lists the presets, disables the ones the asset cannot use (with the reason),
 * and creates a job. The server re-checks everything (422 is shown as-is).
 */
export function PresetPicker(props: { asset: AssetDto; onCreated?: (jobId: string) => void }) {
  const { asset, onCreated } = props;
  const router = useRouter();
  const groupId = useId();
  const [presets, setPresets] = useState<PresetOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Deferred so the setState calls below are not synchronous in the effect.
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/v1/presets', { cache: 'no-store' });
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(body?.error?.message ?? `Could not load presets (${res.status})`);
          return;
        }
        setPresets(body.presets as PresetOption[]);
      } catch {
        if (!cancelled) setLoadError('Network error while loading presets.');
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const rows = (presets ?? []).map((preset) => ({
    preset,
    compat: checkPresetCompatibility(
      { ...preset, note: preset.note ?? undefined },
      toCheckMeta(asset),
      asset.sizeBytes,
    ),
  }));
  const firstUsable = rows.find((r) => r.compat.ok)?.preset.id ?? null;
  const chosen =
    selected && rows.some((r) => r.preset.id === selected && r.compat.ok) ? selected : firstUsable;

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
      <fieldset className="flex flex-col gap-2" disabled={busy}>
        <legend className="mb-1 text-sm font-medium">Choose an enhancement preset</legend>
        {rows.map(({ preset, compat }) => {
          const id = `${groupId}-${preset.id}`;
          const reasonId = `${id}-reason`;
          const noteId = `${id}-note`;
          const disabled = !compat.ok;
          return (
            <div key={preset.id} className="flex items-start gap-2">
              <input
                type="radio"
                id={id}
                name={`${groupId}-preset`}
                value={preset.id}
                checked={chosen === preset.id}
                disabled={disabled}
                onChange={() => setSelected(preset.id)}
                aria-describedby={
                  [!compat.ok ? reasonId : null, preset.note ? noteId : null]
                    .filter(Boolean)
                    .join(' ') || undefined
                }
                className="mt-1"
              />
              <div className="flex flex-col">
                <label htmlFor={id} className={disabled ? 'text-zinc-500' : undefined}>
                  {preset.label}{' '}
                  <span className="text-sm text-zinc-600 dark:text-zinc-400">
                    (output {preset.scale}x, input up to {preset.maxInput.width}x
                    {preset.maxInput.height})
                  </span>
                </label>
                {preset.note ? (
                  <span id={noteId} className="text-sm text-zinc-600 dark:text-zinc-400">
                    Note: {preset.note}
                  </span>
                ) : null}
                {!compat.ok ? (
                  <span id={reasonId} className="text-sm text-red-700 dark:text-red-400">
                    Not available: {compat.reason}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </fieldset>

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
