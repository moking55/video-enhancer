'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';

import { PresetOptions, usePresets } from '@/components/preset-options';
import { Button } from '@/components/ui/button';
import type { AssetDto } from '@/lib/contracts/uploads';
import { apiErrorText } from '@/lib/error-messages';
import { buildPresetRows, compatReasonTh, resolveChosenPresetId } from '@/lib/preset-options';

/**
 * "Enhance again" for an existing asset: lists the presets that fit it (the
 * others are hidden, with their reasons on demand), and creates a job. The server
 * re-checks everything (a 422 is shown with a Thai reason).
 */
export function PresetPicker(props: { asset: AssetDto; onCreated?: (jobId: string) => void }) {
  const { asset, onCreated } = props;
  const router = useRouter();
  const hintId = useId();
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
      <PresetOptions
        rows={rows}
        chosen={chosen}
        onChange={setSelected}
        disabled={busy}
        hideIncompatible
      />

      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={!chosen || busy}
          aria-describedby={!chosen ? hintId : undefined}
          className="w-full sm:w-auto"
        >
          {busy ? 'กำลังสร้างงาน...' : 'เริ่มปรับปรุงคุณภาพ'}
        </Button>
        {!chosen ? (
          <span id={hintId} className="text-sm text-zinc-600 dark:text-zinc-400">
            ไม่มี preset ที่ใช้กับวิดีโอนี้ได้
          </span>
        ) : null}
      </div>
    </form>
  );
}
