'use client';

import { useEffect, useId, useState } from 'react';

import { apiErrorText } from '@/lib/error-messages';
import {
  compatReasonTh,
  cpuCapableNoteTh,
  formatEstimateMinutesTh,
  hiddenPresetsLabelTh,
  noPresetAdviceTh,
  splitPresetRows,
} from '@/lib/preset-options';
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
            loadError: apiErrorText(body, `โหลดรายการ preset ไม่สำเร็จ (${res.status})`),
          });
          return;
        }
        setState({ presets: body.presets as PresetOption[], loadError: null });
      } catch {
        if (!cancelled) {
          setState({ presets: null, loadError: 'เชื่อมต่อไม่ได้ขณะโหลดรายการ preset' });
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

/**
 * Radio group of the presets that can run on the file. With `hideIncompatible`
 * (a file is chosen) the others are hidden behind a one-line summary whose
 * "แสดงเหตุผล" toggle lists them with their Thai reasons.
 */
export function PresetOptions(props: {
  rows: readonly PresetRow[];
  chosen: string | null;
  onChange: (presetId: string) => void;
  disabled?: boolean;
  legend?: string;
  /** Hide presets that cannot run on the file (set once a file is known). */
  hideIncompatible?: boolean;
}) {
  const {
    rows,
    chosen,
    onChange,
    disabled = false,
    legend = 'เลือก preset สำหรับปรับปรุงคุณภาพ',
    hideIncompatible = false,
  } = props;
  const groupId = useId();
  const reasonsId = `${groupId}-hidden`;
  const [showReasons, setShowReasons] = useState(false);
  const { visible, hidden } = splitPresetRows(rows, hideIncompatible);
  const noneFit = hideIncompatible && rows.length > 0 && visible.length === 0;

  return (
    <fieldset className="flex min-w-0 flex-col gap-2" disabled={disabled}>
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {visible.map(({ preset, estimateSec }) => {
        const id = `${groupId}-${preset.id}`;
        const noteId = `${id}-note`;
        const cpuNote = cpuCapableNoteTh(preset);
        const cpuNoteId = `${id}-cpu`;
        return (
          <div
            key={preset.id}
            className="relative flex items-start gap-3 rounded-lg border border-zinc-300 p-3 has-[:checked]:border-blue-600 has-[:checked]:bg-blue-50 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-blue-600 dark:border-zinc-700 dark:has-[:checked]:border-blue-400 dark:has-[:checked]:bg-blue-950/40"
          >
            <input
              type="radio"
              id={id}
              name={`${groupId}-preset`}
              value={preset.id}
              checked={chosen === preset.id}
              onChange={() => onChange(preset.id)}
              aria-describedby={
                [preset.note ? noteId : null, cpuNote ? cpuNoteId : null].filter(Boolean).join(' ') ||
                undefined
              }
              className="mt-0.5 h-5 w-5 shrink-0 accent-blue-600"
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              {/* The label's overlay makes the whole card clickable. */}
              <label
                htmlFor={id}
                className="cursor-pointer font-medium after:absolute after:inset-0 after:content-['']"
              >
                {preset.label}{' '}
                <span className="text-sm font-normal text-zinc-600 dark:text-zinc-400">
                  (ผลลัพธ์ {preset.scale}×, อินพุตสูงสุด {preset.maxInput.width}×
                  {preset.maxInput.height})
                </span>
              </label>
              {estimateSec !== null ? (
                <span className="text-sm text-zinc-600 dark:text-zinc-400">
                  ≈ {formatEstimateMinutesTh(estimateSec)}บน Colab T4 (โดยประมาณ)
                </span>
              ) : null}
              {preset.note ? (
                <span id={noteId} className="text-sm text-zinc-600 dark:text-zinc-400">
                  หมายเหตุ: {preset.note}
                </span>
              ) : null}
              {cpuNote ? (
                <span id={cpuNoteId} className="text-sm text-zinc-600 dark:text-zinc-400">
                  {cpuNote}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}

      {noneFit ? (
        <p
          role="alert"
          className="rounded-lg border border-red-600 bg-red-50 p-3 text-sm text-red-900 dark:border-red-400 dark:bg-red-950 dark:text-red-100"
        >
          {noPresetAdviceTh(hidden)}
        </p>
      ) : null}

      {hidden.length > 0 ? (
        <div className="flex flex-col gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <span>{hiddenPresetsLabelTh(hidden.length)}</span>
            <button
              type="button"
              aria-expanded={showReasons}
              aria-controls={reasonsId}
              onClick={() => setShowReasons((v) => !v)}
              className="min-h-11 rounded-md px-2 font-medium text-blue-700 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:text-blue-300"
            >
              {showReasons ? 'ซ่อนเหตุผล' : 'แสดงเหตุผล'}
            </button>
          </div>
          {showReasons ? (
            <ul id={reasonsId} className="flex flex-col gap-2">
              {hidden.map(({ preset, compat }) => (
                <li
                  key={preset.id}
                  className="rounded-lg border border-dashed border-zinc-300 p-3 dark:border-zinc-700"
                >
                  <span className="font-medium text-zinc-800 dark:text-zinc-200">{preset.label}</span>
                  <span className="block">ใช้ไม่ได้: {compatReasonTh(compat, preset.label)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}
