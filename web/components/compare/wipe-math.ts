/** Pure helpers for the wipe divider and time display. */

export const WIPE_STEP = 0.02;
export const WIPE_STEP_LARGE = 0.1;

/** Divider position as a fraction 0..1 of the viewer width. */
export function clampWipe(pos: number): number {
  if (!Number.isFinite(pos)) return 0.5;
  return Math.min(1, Math.max(0, pos));
}

/** Pointer x -> divider position inside a container. */
export function wipeFromPointer(clientX: number, left: number, width: number): number {
  if (width <= 0) return 0.5;
  return clampWipe((clientX - left) / width);
}

export function nudgeWipe(pos: number, direction: 1 | -1, large = false): number {
  const step = large ? WIPE_STEP_LARGE : WIPE_STEP;
  // Round to avoid 0.1 + 0.02 float noise accumulating in aria-valuenow.
  return clampWipe(Math.round((pos + direction * step) * 1000) / 1000);
}

/** CSS clip-path that keeps only the part of the top layer left of the divider. */
export function wipeClipPath(pos: number): string {
  const rightInset = (1 - clampWipe(pos)) * 100;
  return `inset(0 ${rightInset.toFixed(3)}% 0 0)`;
}

/** m:ss.cc (centiseconds) for the time readout. */
export function formatTime(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalCs = Math.floor(s * 100 + 1e-6);
  const cs = totalCs % 100;
  const whole = Math.floor(totalCs / 100);
  const m = Math.floor(whole / 60);
  const sec = whole % 60;
  return `${m}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** Number of frames in a clip (rounded, since duration * fps is rarely an integer). */
export function totalFrames(duration: number, fps: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(fps) || fps <= 0) return 0;
  return Math.round(duration * fps);
}
