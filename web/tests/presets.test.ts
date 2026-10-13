import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkPresetCompatibility,
  getPreset,
  listPresets,
  MIB,
  type Preset,
} from '@/lib/contracts/presets';

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

describe('registry', () => {
  it('defines the real presets with SPEC models and limits', () => {
    const x2 = preset('realesrgan-x2');
    expect(x2).toMatchObject({ model: 'RealESRGAN_x2plus', scale: 2 });
    expect(x2.maxInput).toEqual({ width: 1920, height: 1080 });
    expect(x2.note).toBeUndefined();
    expect(preset('realesrgan-anime-x4').model).toBe('realesr-animevideov3');
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
    expect(listPresets().map((p) => p.id)).toEqual([
      'realesrgan-x2',
      'realesrgan-x4',
      'realesrgan-anime-x4',
    ]);
    expect(getPreset('mock-x2')).toBeUndefined();
  });

  it('allows mock-x2 in production with ENABLE_MOCK_PRESET=1', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENABLE_MOCK_PRESET', '1');
    expect(getPreset('mock-x2')).toBeDefined();
  });
});
