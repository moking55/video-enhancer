/** Preset registry (SPEC "Presets และ limits"). zod-free so it is cheap to import anywhere. */

export const MIB = 1024 * 1024;

/** Limits shared by every preset: MP4 input, <= 120 s, <= 500 MiB. */
export const COMMON_LIMITS = {
  maxDurationSec: 120,
  maxSizeBytes: 500 * MIB,
} as const;

export type Preset = {
  id: string;
  label: string;
  model: string;
  /** Final output scale factor (what the user gets). */
  scale: number;
  /** Largest accepted input; portrait input is compared with swapped sides. */
  maxInput: { width: number; height: number };
  limits: typeof COMMON_LIMITS;
  note?: string;
  /** Not offered in production unless ENABLE_MOCK_PRESET=1. */
  devOnly?: boolean;
};

const ALL_PRESETS: readonly Preset[] = [
  {
    id: 'realesrgan-x2',
    label: 'Real-ESRGAN 2x',
    model: 'RealESRGAN_x2plus',
    scale: 2,
    maxInput: { width: 1920, height: 1080 },
    limits: COMMON_LIMITS,
  },
  {
    id: 'realesrgan-x4',
    label: 'Real-ESRGAN 4x',
    model: 'RealESRGAN_x4plus',
    scale: 4,
    maxInput: { width: 960, height: 540 },
    limits: COMMON_LIMITS,
  },
  {
    id: 'realesrgan-anime-x4',
    label: 'Real-ESRGAN Anime 4x',
    model: 'realesr-animevideov3',
    scale: 4,
    maxInput: { width: 960, height: 540 },
    limits: COMMON_LIMITS,
  },
  {
    id: 'mock-x2',
    label: 'Mock 2x (dev only)',
    model: 'mock',
    scale: 2,
    maxInput: { width: 1920, height: 1080 },
    limits: COMMON_LIMITS,
    note: 'Plain ffmpeg scale for end-to-end testing without a GPU',
    devOnly: true,
  },
];

function mockEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.ENABLE_MOCK_PRESET === '1';
}

/** Presets offered right now (evaluated per call so env changes apply). */
export function listPresets(): Preset[] {
  const mock = mockEnabled();
  return ALL_PRESETS.filter((p) => !p.devOnly || mock);
}

export function getPreset(id: string): Preset | undefined {
  return listPresets().find((p) => p.id === id);
}

/** Subset of `assets.client_meta` (values read from <video> in the browser; UX only). */
export type ClientMeta = {
  width?: number;
  height?: number;
  /** Seconds. */
  duration?: number;
};

export type PresetCompatibility =
  | { ok: true }
  | { ok: false; code: 'PRESET_INCOMPATIBLE'; reason: string };

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

/**
 * Cheap pre-check against browser-reported metadata. Unknown values are not
 * rejected here (the worker re-checks with ffprobe). Orientation-agnostic:
 * long side <= preset long side AND short side <= preset short side AND pixel
 * count <= preset pixel count, so 1080x1920 fits a 1920x1080 preset.
 */
export function checkPresetCompatibility(
  preset: Preset,
  clientMeta: unknown,
  sizeBytes?: number,
): PresetCompatibility {
  const meta = (clientMeta && typeof clientMeta === 'object' ? clientMeta : {}) as Record<
    string,
    unknown
  >;
  const fail = (reason: string): PresetCompatibility => ({
    ok: false,
    code: 'PRESET_INCOMPATIBLE',
    reason,
  });

  const w = num(meta.width);
  const h = num(meta.height);
  if (w !== undefined && h !== undefined) {
    const long = Math.max(w, h);
    const short = Math.min(w, h);
    const { width: mw, height: mh } = preset.maxInput;
    const pLong = Math.max(mw, mh);
    const pShort = Math.min(mw, mh);
    if (w * h > mw * mh || long > pLong || short > pShort) {
      return fail(
        `Input ${w}x${h} exceeds ${preset.label} limit (${pLong}x${pShort}, either orientation)`,
      );
    }
  }

  const duration = num(meta.duration);
  if (duration !== undefined && duration > preset.limits.maxDurationSec) {
    return fail(`Duration ${Math.round(duration)} s exceeds ${preset.limits.maxDurationSec} s`);
  }

  if (sizeBytes !== undefined && sizeBytes > preset.limits.maxSizeBytes) {
    return fail(`File exceeds ${preset.limits.maxSizeBytes / MIB} MiB`);
  }

  return { ok: true };
}
