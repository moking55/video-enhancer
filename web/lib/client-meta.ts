import { COMMON_LIMITS, MIB } from '@/lib/contracts/presets';

/** Browser-only helpers for the upload form (UX pre-checks; the server re-validates). */

export type VideoMeta = {
  width?: number;
  height?: number;
  durationSec?: number;
};

export const CLIENT_LIMITS = {
  maxBytes: COMMON_LIMITS.maxSizeBytes,
  maxDurationSec: COMMON_LIMITS.maxDurationSec,
  /** Compared orientation-agnostically (long side vs long side). */
  maxLongSide: 1920,
  maxShortSide: 1080,
} as const;

type FileLike = { name: string; type: string; size: number };

const isMp4 = (file: FileLike) =>
  file.type === 'video/mp4' || (file.type === '' && /\.mp4$/i.test(file.name));

/** Human-readable problems; an empty list means the file may be uploaded. */
export function checkClientLimits(file: FileLike, meta: VideoMeta = {}): string[] {
  const problems: string[] = [];
  if (!isMp4(file) || !/\.mp4$/i.test(file.name)) {
    problems.push('รองรับเฉพาะไฟล์ MP4 (.mp4, video/mp4) เท่านั้น');
  }
  if (file.size <= 0) {
    problems.push('ไฟล์ว่างเปล่า');
  } else if (file.size > CLIENT_LIMITS.maxBytes) {
    problems.push(
      `ไฟล์ขนาด ${(file.size / MIB).toFixed(1)} MiB เกินขีดจำกัด (สูงสุด ${CLIENT_LIMITS.maxBytes / MIB} MiB)`,
    );
  }
  if (meta.durationSec !== undefined && meta.durationSec > CLIENT_LIMITS.maxDurationSec) {
    problems.push(
      `ความยาว ${Math.ceil(meta.durationSec)} วินาที เกินขีดจำกัด (สูงสุด ${CLIENT_LIMITS.maxDurationSec} วินาที)`,
    );
  }
  if (meta.width !== undefined && meta.height !== undefined) {
    const long = Math.max(meta.width, meta.height);
    const short = Math.min(meta.width, meta.height);
    if (long > CLIENT_LIMITS.maxLongSide || short > CLIENT_LIMITS.maxShortSide) {
      problems.push(
        `ความละเอียด ${meta.width}×${meta.height} เกินขีดจำกัด (สูงสุด ${CLIENT_LIMITS.maxLongSide}×${CLIENT_LIMITS.maxShortSide} ทั้งแนวนอนและแนวตั้ง)`,
      );
    }
  }
  return problems;
}

/**
 * Reads width/height/duration through a detached <video>. Resolves with `{}`
 * when the browser cannot decode the file or `timeoutMs` passes (the worker
 * re-probes with ffprobe, so missing metadata is not fatal).
 */
export function readVideoMeta(file: File, timeoutMs = 8000): Promise<VideoMeta> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let done = false;

    const finish = (meta: VideoMeta) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(meta);
    };

    const timer = setTimeout(() => finish({}), timeoutMs);
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => {
      const meta: VideoMeta = {};
      if (video.videoWidth > 0) meta.width = video.videoWidth;
      if (video.videoHeight > 0) meta.height = video.videoHeight;
      if (Number.isFinite(video.duration) && video.duration > 0) meta.durationSec = video.duration;
      finish(meta);
    };
    video.onerror = () => finish({});
    video.src = url;
  });
}

/** Dispatched on `window` after an upload/delete so the asset list re-fetches. */
export const ASSETS_CHANGED_EVENT = 'assets:changed';
