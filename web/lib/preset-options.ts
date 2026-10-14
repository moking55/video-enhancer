import {
  checkPresetCompatibility,
  estimateProcessingSec,
  type CompatIssue,
  type Preset,
  type PresetCompatibility,
} from '@/lib/contracts/presets';

/** Preset shape returned by `GET /api/v1/presets`. */
export type PresetOption = Pick<
  Preset,
  'id' | 'label' | 'model' | 'scale' | 'maxInput' | 'limits' | 'secPerMegapixelFrame'
> & {
  note: string | null;
  /** Can run on the worker's CPU fallback (see `Preset.cpuCapable`). */
  cpuCapable?: boolean;
};

/** Shown under presets that the worker can also run on CPU (informational; estimates stay GPU-based). */
export const CPU_CAPABLE_NOTE_TH = 'รันบน CPU ได้เมื่อ GPU ไม่ว่าง (ช้ากว่ามาก)';

/** The CPU note for a preset, or null when it needs a GPU. */
export function cpuCapableNoteTh(preset: Pick<PresetOption, 'cpuCapable'>): string | null {
  return preset.cpuCapable ? CPU_CAPABLE_NOTE_TH : null;
}

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
      { ...preset, note: preset.note ?? undefined, cpuCapable: preset.cpuCapable ? true : undefined },
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

/** "7.6 นาที" style label for the Thai UI (see `formatEstimateMinutes` for the English one). */
export function formatEstimateMinutesTh(sec: number): string {
  const min = sec / 60;
  if (min < 1) return '< 1 นาที';
  return `${min < 10 ? min.toFixed(1) : Math.round(min)} นาที`;
}

/**
 * Thai reason for an unusable preset, built from the structured issue (never
 * by parsing the English `reason`). `presetLabel` is the preset the issue is about.
 */
export function describeCompatIssueTh(issue: CompatIssue, presetLabel: string): string {
  switch (issue.kind) {
    case 'dimensions':
      return `วิดีโอขนาด ${issue.width}×${issue.height} เกินที่ ${presetLabel} รองรับ (สูงสุด ${issue.maxLong}×${issue.maxShort} ทั้งแนวนอนและแนวตั้ง)`;
    case 'duration':
      return `ความยาว ${Math.round(issue.durationSec)} วินาที เกินขีดจำกัด ${issue.maxDurationSec} วินาที`;
    case 'size':
      return `ไฟล์ใหญ่เกิน ${issue.maxMiB} MiB`;
    case 'too_slow': {
      const base = `คาดว่าใช้เวลาประมาณ ${formatEstimateMinutesTh(issue.estimateSec)}บน Colab T4 เมื่อใช้ ${presetLabel} เกินขีดจำกัด ${issue.limitMin} นาที`;
      return issue.suggestion
        ? `${base} ลองใช้ ${issue.suggestion.label} (ประมาณ ${formatEstimateMinutesTh(issue.suggestion.sec)})`
        : `${base} ลองใช้วิดีโอที่สั้นลงหรือเล็กลง`;
    }
  }
}

/** Thai reason of a failed compatibility check; null when the preset is usable. */
export function compatReasonTh(compat: PresetCompatibility, presetLabel: string): string | null {
  return compat.ok ? null : describeCompatIssueTh(compat.issue, presetLabel);
}

export type PresetRowSplit = {
  /** Presets that can run on the file (always all rows when nothing is hidden). */
  visible: PresetRow[];
  /** Presets that cannot run on the file; shown only on demand, with their reasons. */
  hidden: PresetRow[];
};

/**
 * Splits rows into usable and unusable. With `hideIncompatible` false (no file
 * chosen yet, so nothing is known) every row stays visible.
 */
export function splitPresetRows(
  rows: readonly PresetRow[],
  hideIncompatible: boolean,
): PresetRowSplit {
  if (!hideIncompatible) return { visible: [...rows], hidden: [] };
  return {
    visible: rows.filter((r) => r.compat.ok),
    hidden: rows.filter((r) => !r.compat.ok),
  };
}

/** "ซ่อน 3 ตัวเลือกที่ใช้กับไฟล์นี้ไม่ได้" */
export function hiddenPresetsLabelTh(count: number): string {
  return `ซ่อน ${count} ตัวเลือกที่ใช้กับไฟล์นี้ไม่ได้`;
}

/**
 * Message for when no preset fits the file: says why (from the structured
 * issues) and what to change (downscale, shorter clip, smaller file).
 */
export function noPresetAdviceTh(rows: readonly PresetRow[]): string {
  const kinds = new Set<CompatIssue['kind']>();
  for (const r of rows) if (!r.compat.ok) kinds.add(r.compat.issue.kind);

  const tips: string[] = [];
  if (kinds.has('dimensions')) {
    tips.push('ความละเอียดของวิดีโอสูงเกินไป ลองลดความละเอียด (downscale) ของวิดีโอก่อนอัปโหลด');
  }
  if (kinds.has('size')) {
    tips.push('ไฟล์ใหญ่เกินไป ลองบีบอัดไฟล์ให้เล็กลง');
  }
  if (kinds.has('duration')) {
    tips.push('วิดีโอยาวเกินไป ลองตัดเป็นคลิปที่สั้นลง');
  }
  if (kinds.has('too_slow') && !kinds.has('duration')) {
    tips.push('ใช้เวลาประมวลผลนานเกินไป ลองใช้คลิปที่สั้นลงหรือมีความละเอียดต่ำลง');
  }
  if (tips.length === 0) tips.push('ลองใช้ไฟล์ที่สั้นลงหรือมีความละเอียดต่ำลง');
  return `ไม่มี preset ที่ใช้กับวิดีโอนี้ได้ ${tips.join(' ')}`;
}
