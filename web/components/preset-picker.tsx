'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { PresetOptions, usePresets } from '@/components/preset-options';
import type { AssetDto } from '@/lib/contracts/uploads';
import { apiErrorText } from '@/lib/error-messages';
import { buildPresetRows, compatReasonTh, resolveChosenPresetId } from '@/lib/preset-options';

/**
 * "Enhance again" for an existing asset: lists the presets, disables the ones
 * the asset cannot use (with the reason), and creates a job. The server
 * re-checks everything (a 422 is shown with a Thai reason).
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
        // 422 PRESET_*: the Thai reason comes from the same pure check the options use.
        const chosenRow = rows.find((r) => r.preset.id === chosen);
        const reason = chosenRow ? compatReasonTh(chosenRow.compat, chosenRow.preset.label) : null;
        const code = body?.error?.code;
        setError(
          reason && (code === 'PRESET_INCOMPATIBLE' || code === 'PRESET_TOO_SLOW')
            ? reason
            : apiErrorText(body, `สร้างงานไม่สำเร็จ (${res.status})`),
        );
        return;
      }
      const jobId = String(body.id);
      if (onCreated) onCreated(jobId);
      else router.push(`/jobs/${jobId}`);
    } catch {
      setError('เชื่อมต่อไม่ได้ กรุณาลองอีกครั้ง');
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
    return <p className="text-sm text-zinc-600 dark:text-zinc-400">กำลังโหลดรายการ preset...</p>;
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
          {busy ? 'กำลังสร้างงาน...' : 'เริ่มปรับปรุงคุณภาพ'}
        </button>
        {!chosen ? (
          <span className="ml-3 text-sm text-zinc-600 dark:text-zinc-400">
            ไม่มี preset ที่รองรับวิดีโอนี้
          </span>
        ) : null}
      </div>
    </form>
  );
}
