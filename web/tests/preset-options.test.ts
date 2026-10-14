import { describe, expect, it } from 'vitest';

import { listPresets } from '@/lib/contracts/presets';
import {
  buildPresetRows,
  CPU_CAPABLE_NOTE_TH,
  cpuCapableNoteTh,
  defaultPresetId,
  hiddenPresetsLabelTh,
  noPresetAdviceTh,
  resolveChosenPresetId,
  splitPresetRows,
  type PresetOption,
} from '@/lib/preset-options';

const MIB = 1024 * 1024;

const presets: PresetOption[] = listPresets().map(
  ({ id, label, model, scale, maxInput, limits, note, secPerMegapixelFrame, cpuCapable }) => ({
    id,
    label,
    model,
    scale,
    maxInput,
    limits,
    secPerMegapixelFrame,
    note: note ?? null,
    cpuCapable: cpuCapable === true,
  }),
);

const byId = (rows: ReturnType<typeof buildPresetRows>, id: string) =>
  rows.find((r) => r.preset.id === id)!;

describe('defaultPresetId', () => {
  it('prefers fast 4x when it fits', () => {
    const rows = buildPresetRows(presets, { width: 640, height: 360, durationSec: 5 });
    expect(defaultPresetId(rows)).toBe('realesrgan-fast-x4');
  });

  it('falls back to 2x when the input is too big for the 4x presets', () => {
    const rows = buildPresetRows(presets, { width: 1920, height: 1080, durationSec: 5 });
    expect(byId(rows, 'realesrgan-fast-x4').compat.ok).toBe(false);
    expect(defaultPresetId(rows)).toBe('realesrgan-x2');
  });

  it('falls back to the first compatible preset when neither preferred one fits', () => {
    const rows = buildPresetRows(
      presets.filter((p) => p.id !== 'realesrgan-fast-x4' && p.id !== 'realesrgan-x2'),
      { width: 640, height: 360, durationSec: 5 },
    );
    expect(defaultPresetId(rows)).toBe(rows.find((r) => r.compat.ok)!.preset.id);
  });

  it('is null when nothing fits', () => {
    const rows = buildPresetRows(presets, { width: 3840, height: 2160, durationSec: 5 });
    expect(rows.every((r) => !r.compat.ok)).toBe(true);
    expect(defaultPresetId(rows)).toBeNull();
  });

  it('is usable before any metadata is known (nothing disabled)', () => {
    const rows = buildPresetRows(presets, {});
    expect(rows.every((r) => r.compat.ok && r.estimateSec === null)).toBe(true);
    expect(defaultPresetId(rows)).toBe('realesrgan-fast-x4');
  });
});

describe('buildPresetRows', () => {
  it('gives disabled reasons for oversized dimensions, duration, size', () => {
    const dim = buildPresetRows(presets, { width: 1920, height: 1080, durationSec: 5 });
    const x4 = byId(dim, 'realesrgan-x4').compat;
    expect(x4.ok).toBe(false);
    if (!x4.ok) expect(x4.reason).toMatch(/exceeds/);

    const dur = buildPresetRows(presets, { width: 640, height: 360, durationSec: 121 });
    const d = byId(dur, 'realesrgan-x2').compat;
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/Duration/);

    const big = buildPresetRows(presets, { sizeBytes: 501 * MIB });
    const s = byId(big, 'realesrgan-x2').compat;
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.reason).toMatch(/500 MiB/);
  });

  it('disables over-budget presets as too slow and keeps faster ones', () => {
    const rows = buildPresetRows(presets, { width: 960, height: 540, durationSec: 120 });
    const slow = byId(rows, 'realesrgan-x4').compat;
    expect(slow.ok).toBe(false);
    if (!slow.ok) expect(slow.code).toBe('PRESET_TOO_SLOW');
    expect(byId(rows, 'realesrgan-fast-x4').compat.ok).toBe(true);
  });

  it('computes an estimate only when width, height and duration are known', () => {
    expect(byId(buildPresetRows(presets, { width: 640, height: 360 }), 'realesrgan-x2').estimateSec).toBeNull();
    const est = byId(
      buildPresetRows(presets, { width: 640, height: 360, durationSec: 10 }),
      'realesrgan-x2',
    ).estimateSec;
    expect(est).toBeGreaterThan(60);
  });
});

describe('resolveChosenPresetId', () => {
  const rows = buildPresetRows(presets, { width: 1920, height: 1080, durationSec: 5 });

  it('keeps a usable selection', () => {
    expect(resolveChosenPresetId(rows, 'realesrgan-x2')).toBe('realesrgan-x2');
  });

  it('ignores a disabled or unknown selection and uses the default', () => {
    expect(resolveChosenPresetId(rows, 'realesrgan-x4')).toBe('realesrgan-x2');
    expect(resolveChosenPresetId(rows, 'nope')).toBe('realesrgan-x2');
    expect(resolveChosenPresetId(rows, null)).toBe('realesrgan-x2');
  });
});

describe('cpuCapableNoteTh', () => {
  it('is shown only for the anime presets', () => {
    const notes = presets.filter((p) => cpuCapableNoteTh(p) !== null).map((p) => p.id);
    expect(notes).toEqual(['compact-anime-x2', 'realesrgan-anime-x4']);
    expect(cpuCapableNoteTh(presets.find((p) => p.id === 'realesrgan-anime-x4')!)).toBe(
      'รันบน CPU ได้เมื่อ GPU ไม่ว่าง (ช้ากว่ามาก)',
    );
    expect(CPU_CAPABLE_NOTE_TH).toContain('CPU');
  });

  it('leaves estimates and compatibility GPU-based', () => {
    const rows = buildPresetRows(presets, { width: 640, height: 360, durationSec: 10 });
    const anime = byId(rows, 'realesrgan-anime-x4');
    expect(anime.compat.ok).toBe(true);
    // 300 frames x 0.2304 MP x (0.16 / 0.2304) s + 60 s overhead: the measured T4 number, no CPU factor.
    expect(anime.estimateSec).toBeCloseTo(60 + 300 * 0.16, 5);
  });
});

describe('splitPresetRows', () => {
  it('keeps every preset visible before a file is known', () => {
    const rows = buildPresetRows(presets, { width: 3840, height: 2160, durationSec: 5 });
    const { visible, hidden } = splitPresetRows(rows, false);
    expect(visible).toHaveLength(rows.length);
    expect(hidden).toHaveLength(0);
  });

  it('hides incompatible presets once a file is known', () => {
    const rows = buildPresetRows(presets, { width: 1920, height: 1080, durationSec: 5 });
    const { visible, hidden } = splitPresetRows(rows, true);
    expect(visible.every((r) => r.compat.ok)).toBe(true);
    expect(hidden.every((r) => !r.compat.ok)).toBe(true);
    expect(visible.length + hidden.length).toBe(rows.length);
    expect(hidden.map((r) => r.preset.id)).toContain('realesrgan-fast-x4');
    expect(visible.map((r) => r.preset.id)).toContain('realesrgan-x2');
  });

  it('keeps the default selection inside the visible list', () => {
    const rows = buildPresetRows(presets, { width: 1920, height: 1080, durationSec: 5 });
    const { visible } = splitPresetRows(rows, true);
    expect(visible.map((r) => r.preset.id)).toContain(resolveChosenPresetId(rows, null));
  });

  it('hides nothing when everything fits', () => {
    const rows = buildPresetRows(presets, { width: 640, height: 360, durationSec: 5 });
    expect(splitPresetRows(rows, true).hidden).toHaveLength(0);
  });
});

describe('hiddenPresetsLabelTh', () => {
  it('counts the hidden presets', () => {
    expect(hiddenPresetsLabelTh(3)).toBe('ซ่อน 3 ตัวเลือกที่ใช้กับไฟล์นี้ไม่ได้');
  });
});

describe('noPresetAdviceTh', () => {
  it('suggests downscaling when the resolution is too high', () => {
    const rows = buildPresetRows(presets, { width: 3840, height: 2160, durationSec: 5 });
    expect(splitPresetRows(rows, true).visible).toHaveLength(0);
    const text = noPresetAdviceTh(rows);
    expect(text).toContain('ไม่มี preset');
    expect(text).toContain('ลดความละเอียด');
  });

  it('suggests a shorter clip when the video is too long', () => {
    const rows = buildPresetRows(presets, { width: 640, height: 360, durationSec: 121 });
    const text = noPresetAdviceTh(rows);
    expect(text).toContain('ตัดเป็นคลิปที่สั้นลง');
    expect(text).not.toContain('ลดความละเอียด');
  });

  it('suggests a smaller file when the file is too large', () => {
    const rows = buildPresetRows(presets, { sizeBytes: 501 * MIB });
    expect(noPresetAdviceTh(rows)).toContain('ไฟล์ใหญ่เกินไป');
  });
});
