/** Preset registry (SPEC "Presets และ limits"). zod-free so it is cheap to import anywhere. */

export const MIB = 1024 * 1024;

/** Limits shared by every preset: MP4 input, <= 120 s, <= 500 MiB. */
export const COMMON_LIMITS = {
  maxDurationSec: 120,
  maxSizeBytes: 500 * MIB,
} as const;

/** GPU-time budget per job (Colab T4 estimate, includes {@link OVERHEAD_SEC}). */
export const MAX_ESTIMATED_SEC = 30 * 60;

/** Fixed cost per job: pip install, model load, download/upload transfer. */
export const OVERHEAD_SEC = 60;

/** Assumed frame rate when the browser did not report one. */
export const DEFAULT_FPS = 30;

export type Preset = {
  id: string;
  label: string;
  model: string;
  /** Final output scale factor (what the user gets). */
  scale: number;
  /** Largest accepted input; portrait input is compared with swapped sides. */
  maxInput: { width: number; height: number };
  /**
   * Seconds of Colab T4 time per frame per million INPUT pixels (fp16, tile 0).
   * x4plus and anime are measured (docs/spikes/realesrgan.md); x2plus and fast are estimates.
   */
  secPerMegapixelFrame: number;
  limits: typeof COMMON_LIMITS;
  note?: string;
  /** Content-specific model: never offered as the "try this instead" hint. */
  noSuggest?: boolean;
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
    // Estimate: 1.31 s/frame at 1280x720 input (x2plus body runs at half resolution).
    secPerMegapixelFrame: 1.31 / 0.9216,
    limits: COMMON_LIMITS,
  },
  {
    id: 'realesrgan-x4',
    label: 'Real-ESRGAN 4x',
    model: 'RealESRGAN_x4plus',
    scale: 4,
    maxInput: { width: 960, height: 540 },
    // Measured: 1.31 s/frame at 640x360 input.
    secPerMegapixelFrame: 1.31 / 0.2304,
    limits: COMMON_LIMITS,
  },
  {
    id: 'realesrgan-anime-x4',
    label: 'Real-ESRGAN Anime 4x',
    model: 'realesr-animevideov3',
    scale: 4,
    maxInput: { width: 960, height: 540 },
    // Measured: 0.16 s/frame at 640x360 input.
    secPerMegapixelFrame: 0.16 / 0.2304,
    limits: COMMON_LIMITS,
    noSuggest: true,
  },
  {
    id: 'realesrgan-fast-x4',
    label: 'Fast 4x (general)',
    model: 'realesr-general-x4v3',
    scale: 4,
    maxInput: { width: 960, height: 540 },
    // Estimate: same compact SRVGG family as animevideov3 (num_conv 32 vs 16 may be slower).
    secPerMegapixelFrame: 0.16 / 0.2304,
    limits: COMMON_LIMITS,
    note: 'Lighter model, much faster, slightly less detail',
  },
  {
    id: 'mock-x2',
    label: 'Mock 2x (dev only)',
    model: 'mock',
    scale: 2,
    maxInput: { width: 1920, height: 1080 },
    secPerMegapixelFrame: 0.01,
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

/**
 * Estimated Colab T4 time in seconds: fixed overhead + frames x per-frame model time.
 * An ESTIMATE from the T3 spike numbers, not a guarantee.
 */
export function estimateProcessingSec(
  preset: Pick<Preset, 'secPerMegapixelFrame'>,
  input: { width: number; height: number; durationSec: number; fps?: number },
): number {
  const fps = input.fps !== undefined && input.fps > 0 ? input.fps : DEFAULT_FPS;
  const frames = Math.ceil(input.durationSec * fps);
  const megapixels = (input.width * input.height) / 1e6;
  return OVERHEAD_SEC + frames * megapixels * preset.secPerMegapixelFrame;
}

/** "7.6 min" style label used in messages and the UI. */
export function formatEstimateMinutes(sec: number): string {
  const min = sec / 60;
  if (min < 1) return '< 1 min';
  return `${min < 10 ? min.toFixed(1) : Math.round(min)} min`;
}

export type PresetCompatibility =
  | { ok: true }
  | { ok: false; code: 'PRESET_INCOMPATIBLE' | 'PRESET_TOO_SLOW'; reason: string };

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

function fitsDimensions(preset: Preset, w: number, h: number): boolean {
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  const { width: mw, height: mh } = preset.maxInput;
  return !(w * h > mw * mh || long > Math.max(mw, mh) || short > Math.min(mw, mh));
}

/**
 * Cheap pre-check against browser-reported metadata. Unknown values are not
 * rejected here (the worker re-checks with ffprobe). Orientation-agnostic:
 * long side <= preset long side AND short side <= preset short side AND pixel
 * count <= preset pixel count, so 1080x1920 fits a 1920x1080 preset.
 * When size and duration are known, also rejects jobs whose estimated GPU time
 * exceeds {@link MAX_ESTIMATED_SEC} (PRESET_TOO_SLOW).
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
  if (w !== undefined && h !== undefined && !fitsDimensions(preset, w, h)) {
    const { width: mw, height: mh } = preset.maxInput;
    return fail(
      `Input ${w}x${h} exceeds ${preset.label} limit (${Math.max(mw, mh)}x${Math.min(mw, mh)}, either orientation)`,
    );
  }

  const duration = num(meta.duration);
  if (duration !== undefined && duration > preset.limits.maxDurationSec) {
    return fail(`Duration ${Math.round(duration)} s exceeds ${preset.limits.maxDurationSec} s`);
  }

  if (sizeBytes !== undefined && sizeBytes > preset.limits.maxSizeBytes) {
    return fail(`File exceeds ${preset.limits.maxSizeBytes / MIB} MiB`);
  }

  if (w !== undefined && h !== undefined && duration !== undefined) {
    const input = { width: w, height: h, durationSec: duration, fps: num(meta.fps) };
    const sec = estimateProcessingSec(preset, input);
    if (sec > MAX_ESTIMATED_SEC) {
      const sameScale = (p: Preset) => Number(p.scale === preset.scale);
      const fits = listPresets()
        .filter((p) => !p.devOnly && !p.noSuggest && p.id !== preset.id && fitsDimensions(p, w, h))
        .map((p) => ({ p, sec: estimateProcessingSec(p, input) }))
        .filter((c) => c.sec <= MAX_ESTIMATED_SEC)
        .sort((a, b) => sameScale(b.p) - sameScale(a.p) || a.sec - b.sec);
      const hint = fits[0]
        ? ` Try ${fits[0].p.label} (about ${formatEstimateMinutes(fits[0].sec)}).`
        : ' Try a shorter or smaller video.';
      return {
        ok: false,
        code: 'PRESET_TOO_SLOW',
        reason: `Estimated ${formatEstimateMinutes(sec)} on Colab T4 with ${preset.label}, over the ${MAX_ESTIMATED_SEC / 60} min limit.${hint}`,
      };
    }
  }

  return { ok: true };
}
