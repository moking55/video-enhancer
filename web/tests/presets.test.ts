import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkPresetCompatibility,
  estimateProcessingSec,
  getPreset,
  listPresets,
  MAX_ESTIMATED_SEC,
  MIB,
  PRESET_TIERS,
  type Preset,
} from '@/lib/contracts/presets';

/** Display order: fast -> balanced -> quality -> anime. */
const PRESET_ORDER = [
  'span-fast-x2',
  'realesrgan-fast-x4',
  'span-balanced-x4',
  'realesrgan-x2',
  'plksr-quality-x4',
  'realesrgan-x4',
  'compact-anime-x2',
  'realesrgan-anime-x4',
];

const preset = (id: string): Preset => {
  const p = getPreset(id);
  if (!p) throw new Error(`missing preset ${id}`);
  return p;
};

afterEach(() => vi.unstubAllEnvs());

describe('checkPresetCompatibility', () => {
  it('accepts input within limits', () => {
    expect(checkPresetCompatibility(preset('realesrgan-x4'), { width: 960, height: 540 })).toEqual({
      ok: true,
    });
    expect(
      checkPresetCompatibility(preset('realesrgan-x2'), { width: 1920, height: 1080 }).ok,
    ).toBe(true);
  });

  it('rejects 4x on 1080p with PRESET_INCOMPATIBLE', () => {
    const r = checkPresetCompatibility(preset('realesrgan-x4'), { width: 1920, height: 1080 });
    expect(r).toMatchObject({ ok: false, code: 'PRESET_INCOMPATIBLE' });
    expect(
      checkPresetCompatibility(preset('realesrgan-anime-x4'), { width: 1920, height: 1080 }).ok,
    ).toBe(false);
  });

  it('handles portrait by long/short side, not width/height', () => {
    expect(
      checkPresetCompatibility(preset('realesrgan-x2'), { width: 1080, height: 1920 }).ok,
    ).toBe(true);
    expect(checkPresetCompatibility(preset('realesrgan-x4'), { width: 540, height: 960 }).ok).toBe(
      true,
    );
    expect(
      checkPresetCompatibility(preset('realesrgan-x4'), { width: 1080, height: 1920 }).ok,
    ).toBe(false);
  });

  it('rejects when pixel count is lower but the long side is too long', () => {
    // 2000x400 = 800k px < 2.07M px, but long side 2000 > 1920
    expect(checkPresetCompatibility(preset('realesrgan-x2'), { width: 2000, height: 400 }).ok).toBe(
      false,
    );
  });

  it('rejects square input whose pixel count exceeds the preset', () => {
    expect(
      checkPresetCompatibility(preset('realesrgan-x2'), { width: 1080, height: 1080 }).ok,
    ).toBe(true);
    expect(
      checkPresetCompatibility(preset('realesrgan-x2'), { width: 1500, height: 1500 }).ok,
    ).toBe(false);
  });

  it('enforces duration and size limits', () => {
    const p = preset('realesrgan-x2');
    expect(checkPresetCompatibility(p, { duration: 120 }).ok).toBe(true);
    expect(checkPresetCompatibility(p, { duration: 120.5 }).ok).toBe(false);
    expect(checkPresetCompatibility(p, {}, 500 * MIB).ok).toBe(true);
    expect(checkPresetCompatibility(p, {}, 500 * MIB + 1).ok).toBe(false);
  });

  it('does not reject unknown or malformed metadata (UX-only check)', () => {
    const p = preset('realesrgan-x4');
    expect(checkPresetCompatibility(p, {}).ok).toBe(true);
    expect(checkPresetCompatibility(p, null).ok).toBe(true);
    expect(checkPresetCompatibility(p, { width: 'big', height: -1 }).ok).toBe(true);
    expect(checkPresetCompatibility(p, { width: 5000 }).ok).toBe(true);
  });
});

describe('estimateProcessingSec', () => {
  it('estimates 720p 10 s on x2 (30 fps default) as overhead + 300 x 1.31 s', () => {
    const sec = estimateProcessingSec(preset('realesrgan-x2'), {
      width: 1280,
      height: 720,
      durationSec: 10,
    });
    expect(sec).toBeCloseTo(60 + 300 * 1.31, 5);
    expect(sec / 60).toBeGreaterThan(7.5);
    expect(sec / 60).toBeLessThan(7.6);
  });

  it('uses the given fps and scales with input pixels', () => {
    const p = preset('realesrgan-x4');
    const base = { width: 640, height: 360, durationSec: 10 };
    expect(estimateProcessingSec(p, { ...base, fps: 24 })).toBeCloseTo(60 + 240 * 1.31, 5);
    expect(estimateProcessingSec(p, { ...base, width: 1280, height: 720 })).toBeCloseTo(
      60 + 300 * 1.31 * 4,
      5,
    );
  });

  it('is much cheaper for the compact models', () => {
    const input = { width: 640, height: 360, durationSec: 10 };
    expect(estimateProcessingSec(preset('realesrgan-fast-x4'), input)).toBeCloseTo(
      60 + 300 * 0.16,
      5,
    );
    expect(estimateProcessingSec(preset('realesrgan-anime-x4'), input)).toBeCloseTo(
      60 + 300 * 0.16,
      5,
    );
  });
});

describe('PRESET_TOO_SLOW budget', () => {
  const meta540 = { width: 960, height: 540, duration: 120 };

  it('rejects 540p 120 s on x4plus and suggests the fast preset', () => {
    const r = checkPresetCompatibility(preset('realesrgan-x4'), meta540);
    expect(r).toMatchObject({ ok: false, code: 'PRESET_TOO_SLOW' });
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toMatch(/Estimated \d+ min/);
    expect(r.reason).toContain('Fast 4× (ทั่วไป)');
  });

  it('accepts the same clip on the fast preset (inside the budget)', () => {
    expect(checkPresetCompatibility(preset('realesrgan-fast-x4'), meta540)).toEqual({ ok: true });
    expect(
      estimateProcessingSec(preset('realesrgan-fast-x4'), {
        width: 960,
        height: 540,
        durationSec: 120,
      }),
    ).toBeLessThan(MAX_ESTIMATED_SEC);
  });

  it('accepts 720p 10 s on x2 and does not apply the budget when duration is unknown', () => {
    expect(
      checkPresetCompatibility(preset('realesrgan-x2'), { width: 1280, height: 720, duration: 10 }).ok,
    ).toBe(true);
    expect(checkPresetCompatibility(preset('realesrgan-x4'), { width: 960, height: 540 }).ok).toBe(
      true,
    );
  });

  it('suggests a shorter video when no preset fits', () => {
    const r = checkPresetCompatibility(preset('realesrgan-x2'), {
      width: 1920,
      height: 1080,
      duration: 120,
    });
    expect(r).toMatchObject({ ok: false, code: 'PRESET_TOO_SLOW' });
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('shorter or smaller');
  });
});

describe('registry', () => {
  it('defines the real presets with SPEC models and limits', () => {
    const x2 = preset('realesrgan-x2');
    expect(x2).toMatchObject({ model: 'RealESRGAN_x2plus', scale: 2 });
    expect(x2.maxInput).toEqual({ width: 1920, height: 1080 });
    expect(x2.note).toBeUndefined();
    expect(preset('realesrgan-anime-x4').model).toBe('realesr-animevideov3');
    // Only the two anime presets may run on the worker's CPU fallback (CPU_PRESETS in the worker).
    expect(listPresets().filter((p) => p.cpuCapable).map((p) => p.id)).toEqual([
      'compact-anime-x2',
      'realesrgan-anime-x4',
    ]);
    expect(preset('realesrgan-fast-x4')).toMatchObject({
      model: 'realesr-general-x4v3',
      scale: 4,
      maxInput: { width: 960, height: 540 },
    });
    expect(preset('realesrgan-x4').limits).toEqual({
      maxDurationSec: 120,
      maxSizeBytes: 500 * MIB,
    });
  });

  it('offers mock-x2 outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(listPresets().map((p) => p.id)).toContain('mock-x2');
  });

  it('hides mock-x2 in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENABLE_MOCK_PRESET', '');
    expect(listPresets().map((p) => p.id)).toEqual(PRESET_ORDER);
    expect(getPreset('mock-x2')).toBeUndefined();
  });

  it('allows mock-x2 in production with ENABLE_MOCK_PRESET=1', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENABLE_MOCK_PRESET', '1');
    expect(getPreset('mock-x2')).toBeDefined();
  });
});

describe('spandrel presets', () => {
  const X4PLUS = 1.31 / 0.2304; // measured T4 anchor, s per input MP
  const ANIME = 0.16 / 0.2304;

  it('defines the four approved presets with their models, scales and input limits', () => {
    expect(preset('span-fast-x2')).toMatchObject({
      label: 'เร็ว 2× (ทั่วไป)',
      model: '2xNomosUni_span_multijpg',
      scale: 2,
      maxInput: { width: 1920, height: 1080 },
    });
    expect(preset('compact-anime-x2')).toMatchObject({
      label: 'เร็ว 2× (อนิเมะ)',
      model: '2xHFA2kAVCCompact',
      scale: 2,
      maxInput: { width: 1920, height: 1080 },
    });
    expect(preset('span-balanced-x4')).toMatchObject({
      label: 'สมดุล 4× (ทั่วไป)',
      model: '4xNomosUni_span_multijpg',
      scale: 4,
      maxInput: { width: 960, height: 540 },
    });
    expect(preset('plksr-quality-x4')).toMatchObject({
      label: 'คุณภาพ 4× (ภาพจริง)',
      model: '4xNomosWebPhoto_RealPLKSR',
      scale: 4,
      maxInput: { width: 960, height: 540 },
    });
    for (const id of ['span-fast-x2', 'compact-anime-x2', 'span-balanced-x4', 'plksr-quality-x4']) {
      expect(preset(id).limits).toEqual({ maxDurationSec: 120, maxSizeBytes: 500 * MIB });
      expect(preset(id).note).toBeTruthy();
    }
  });

  it('uses the agreed (conservative, uncalibrated) cost estimates', () => {
    expect(preset('span-fast-x2').secPerMegapixelFrame).toBeCloseTo(0.25 * X4PLUS, 8);
    expect(preset('span-balanced-x4').secPerMegapixelFrame).toBeCloseTo(0.25 * X4PLUS, 8);
    expect(preset('plksr-quality-x4').secPerMegapixelFrame).toBeCloseTo(X4PLUS, 8);
    expect(preset('compact-anime-x2').secPerMegapixelFrame).toBeCloseTo(0.5 * ANIME, 8);
    // PLKSR runs fp32 on a T4, so it is costed above SPAN
    expect(preset('plksr-quality-x4').secPerMegapixelFrame).toBeGreaterThan(
      preset('span-balanced-x4').secPerMegapixelFrame,
    );
    // 640x360, 10 s, 30 fps = 300 frames
    const input = { width: 640, height: 360, durationSec: 10 };
    expect(estimateProcessingSec(preset('span-balanced-x4'), input)).toBeCloseTo(
      60 + 300 * 0.2304 * 0.25 * X4PLUS,
      5,
    );
  });

  it('keeps the dimension and budget checks working for the new presets', () => {
    const meta540 = { width: 960, height: 540, duration: 120 };
    expect(checkPresetCompatibility(preset('plksr-quality-x4'), meta540)).toMatchObject({
      ok: false,
      code: 'PRESET_TOO_SLOW',
    });
    expect(
      checkPresetCompatibility(preset('span-balanced-x4'), { ...meta540, duration: 30 }).ok,
    ).toBe(true);
    expect(
      checkPresetCompatibility(preset('compact-anime-x2'), { width: 1920, height: 1080 }).ok,
    ).toBe(true);
    expect(
      checkPresetCompatibility(preset('span-balanced-x4'), { width: 1920, height: 1080 }).ok,
    ).toBe(false);
  });

  it('marks only the anime presets cpuCapable and never suggests them', () => {
    expect(preset('compact-anime-x2')).toMatchObject({ cpuCapable: true, noSuggest: true });
    expect(preset('plksr-quality-x4').cpuCapable).toBeUndefined();
    expect(preset('span-fast-x2').cpuCapable).toBeUndefined();
    expect(preset('span-balanced-x4').cpuCapable).toBeUndefined();
  });

  it('lists presets in tier order: fast, balanced, quality, anime', () => {
    const real = listPresets().filter((p) => !p.devOnly);
    expect(real.map((p) => p.id)).toEqual(PRESET_ORDER);
    const tiers = real.map((p) => PRESET_TIERS.indexOf(p.tier!));
    expect(tiers.every((t) => t >= 0)).toBe(true);
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    expect(new Set(real.map((p) => p.tier))).toEqual(new Set(PRESET_TIERS));
  });
});
