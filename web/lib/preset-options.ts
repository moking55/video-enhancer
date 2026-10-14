import {
  checkPresetCompatibility,
  estimateProcessingSec,
  type Preset,
  type PresetCompatibility,
} from '@/lib/contracts/presets';

/** Preset shape returned by `GET /api/v1/presets`. */
export type PresetOption = Pick<
  Preset,
  'id' | 'label' | 'model' | 'scale' | 'maxInput' | 'limits' | 'secPerMegapixelFrame'
> & {
  note: string | null;
};

/** What is known about the video (browser-reported; any field may be missing). */
export type PresetInput = {
  width?: number;
  height?: number;
  durationSec?: number;
  sizeBytes?: number;
};

export type PresetRow = {
  preset: PresetOption;
  /** Colab T4 estimate in seconds; null until width, height and duration are known. */
  estimateSec: number | null;
  compat: PresetCompatibility;
};

/** Tried in order when picking the default; falls back to the first usable preset. */
export const PREFERRED_PRESET_IDS = ['realesrgan-fast-x4', 'realesrgan-x2'] as const;

/** Compatibility and time estimate per preset for one video. */
export function buildPresetRows(presets: readonly PresetOption[], input: PresetInput): PresetRow[] {
  const { width, height, durationSec, sizeBytes } = input;
  const checkMeta = { width, height, duration: durationSec };
  return presets.map((preset) => ({
    preset,
    estimateSec:
      width && height && durationSec
        ? estimateProcessingSec(preset, { width, height, durationSec })
        : null,
    compat: checkPresetCompatibility(
      { ...preset, note: preset.note ?? undefined },
      checkMeta,
      sizeBytes,
    ),
  }));
}

/** Default: the preferred compatible preset (fast 4x, then 2x), else the first compatible one. */
export function defaultPresetId(rows: readonly PresetRow[]): string | null {
  const usable = rows.filter((r) => r.compat.ok);
  for (const id of PREFERRED_PRESET_IDS) {
    if (usable.some((r) => r.preset.id === id)) return id;
  }
  return usable[0]?.preset.id ?? null;
}

/** The user's selection if it is still usable, otherwise the default. */
export function resolveChosenPresetId(
  rows: readonly PresetRow[],
  selected: string | null,
): string | null {
  if (selected && rows.some((r) => r.preset.id === selected && r.compat.ok)) return selected;
  return defaultPresetId(rows);
}
