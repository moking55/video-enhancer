'use client';

import { useEffect, useId, useState } from 'react';

import { formatEstimateMinutes } from '@/lib/contracts/presets';
import type { PresetOption, PresetRow } from '@/lib/preset-options';

export type PresetsState = { presets: PresetOption[] | null; loadError: string | null };

/** Loads `GET /api/v1/presets` once after hydration. */
export function usePresets(): PresetsState {
  const [state, setState] = useState<PresetsState>({ presets: null, loadError: null });

  useEffect(() => {
    let cancelled = false;
    // Deferred so the setState calls below are not synchronous in the effect.
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/v1/presets', { cache: 'no-store' });
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setState({
            presets: null,
            loadError: body?.error?.message ?? `Could not load presets (${res.status})`,
          });
          return;
        }
        setState({ presets: body.presets as PresetOption[], loadError: null });
      } catch {
        if (!cancelled) {
          setState({ presets: null, loadError: 'Network error while loading presets.' });
        }
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return state;
}

/** Radio group of presets; unusable ones are disabled with the reason. */
export function PresetOptions(props: {
  rows: readonly PresetRow[];
  chosen: string | null;
  onChange: (presetId: string) => void;
  disabled?: boolean;
  legend?: string;
}) {
  const { rows, chosen, onChange, disabled = false, legend = 'Choose an enhancement preset' } = props;
  const groupId = useId();

  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {rows.map(({ preset, compat, estimateSec }) => {
        const id = `${groupId}-${preset.id}`;
        const reasonId = `${id}-reason`;
        const noteId = `${id}-note`;
        const unusable = !compat.ok;
        return (
          <div key={preset.id} className="flex items-start gap-2">
            <input
              type="radio"
              id={id}
              name={`${groupId}-preset`}
              value={preset.id}
              checked={chosen === preset.id}
              disabled={unusable}
              onChange={() => onChange(preset.id)}
              aria-describedby={
                [unusable ? reasonId : null, preset.note ? noteId : null]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
              className="mt-1"
            />
            <div className="flex flex-col">
              <label htmlFor={id} className={unusable ? 'text-zinc-500' : undefined}>
                {preset.label}{' '}
                <span className="text-sm text-zinc-600 dark:text-zinc-400">
                  (output {preset.scale}x, input up to {preset.maxInput.width}x
                  {preset.maxInput.height})
                </span>
              </label>
              {estimateSec !== null ? (
                <span className="text-sm text-zinc-600 dark:text-zinc-400">
                  ≈ {formatEstimateMinutes(estimateSec)} on Colab T4 (estimate)
                </span>
              ) : null}
              {preset.note ? (
                <span id={noteId} className="text-sm text-zinc-600 dark:text-zinc-400">
                  Note: {preset.note}
                </span>
              ) : null}
              {unusable ? (
                <span id={reasonId} className="text-sm text-red-700 dark:text-red-400">
                  Not available: {compat.reason}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}
