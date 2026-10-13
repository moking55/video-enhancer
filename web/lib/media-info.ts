/** Pure helpers for turning loosely-typed probe / output metadata into usable numbers. */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** "30000/1001" | "30" | 29.97 -> number, or undefined when not a positive finite rate. */
export function parseFps(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  const ratio = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(text);
  if (ratio) {
    const den = Number(ratio[2]);
    if (den === 0) return undefined;
    return parseFps(Number(ratio[1]) / den);
  }
  if (!/^\d+(?:\.\d+)?$/.test(text)) return undefined;
  return parseFps(Number(text));
}

const positive = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

/** fps from an asset `probe` object (ffprobe summary), trying the common key spellings. */
export function fpsFromProbe(probe: unknown): number | undefined {
  if (!isRecord(probe)) return undefined;
  for (const key of ['fps', 'fpsRational', 'avg_frame_rate', 'r_frame_rate']) {
    const fps = parseFps(probe[key]);
    if (fps !== undefined) return fps;
  }
  return undefined;
}

export type InputMediaInfo = { width?: number; height?: number; fps?: number };

/**
 * Input dimensions/fps: probe (ffprobe, authoritative) first, then browser
 * `client_meta` for dimensions, then the finished job's output meta for fps
 * (the worker keeps the input fps).
 */
export function resolveInputInfo(
  probe: unknown,
  clientMeta: unknown,
  outputMeta: unknown,
): InputMediaInfo {
  const p = isRecord(probe) ? probe : {};
  const c = isRecord(clientMeta) ? clientMeta : {};
  const o = isRecord(outputMeta) ? outputMeta : {};
  const out: InputMediaInfo = {};
  const width = positive(p.width) ?? positive(c.width);
  const height = positive(p.height) ?? positive(c.height);
  const fps = fpsFromProbe(probe) ?? parseFps(o.fps);
  if (width !== undefined) out.width = width;
  if (height !== undefined) out.height = height;
  if (fps !== undefined) out.fps = fps;
  return out;
}

/** `<name without extension>.<presetId>.mp4` */
export function outputDownloadName(filename: string, presetId: string): string {
  const base = filename.replace(/\.[^./\\]{1,8}$/, '') || 'video';
  return `${base}.${presetId}.mp4`;
}

/** Response of GET /api/v1/jobs/[id]/media. */
export type JobMediaResponse = {
  input: { url: string } & InputMediaInfo;
  output: { url: string; downloadUrl: string } | null;
};
