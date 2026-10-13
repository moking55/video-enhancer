/**
 * Pure helpers for keeping two <video> elements frame-aligned.
 * No DOM access so they can be unit-tested in a node environment.
 */

/** Used only when the caller passes a non-finite or non-positive fps. */
export const FALLBACK_FPS = 30;

/** Small nudge so values like n/fps are not floored to n-1 by float error. */
const EPSILON = 1e-6;

export function sanitizeFps(fps: number): number {
  return Number.isFinite(fps) && fps > 0 ? fps : FALLBACK_FPS;
}

export function frameDuration(fps: number): number {
  return 1 / sanitizeFps(fps);
}

/** Zero-based index of the frame displayed at time `t` (seconds). */
export function frameIndex(t: number, fps: number): number {
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.floor(t * sanitizeFps(fps) + EPSILON);
}

/** Time at the center of frame `n`, which avoids landing on a frame edge. */
export function frameCenterTime(n: number, fps: number): number {
  return (Math.max(0, n) + 0.5) / sanitizeFps(fps);
}

/** Index of the last frame in a clip, or 0 when duration is unknown/zero. */
export function lastFrameIndex(duration: number, fps: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, Math.ceil(duration * sanitizeFps(fps) - EPSILON) - 1);
}

/** Clamp `t` to [0, duration]. An unknown duration only clamps at 0. */
export function clampTime(t: number, duration: number): number {
  const lower = Number.isFinite(t) ? Math.max(0, t) : 0;
  if (!Number.isFinite(duration) || duration <= 0) return lower;
  return Math.min(lower, duration);
}

/**
 * Drift is corrected only when the follower is more than one frame away
 * from the master (strictly greater, so exactly one frame is tolerated).
 */
export function shouldCorrectDrift(
  masterTime: number,
  followerTime: number,
  fps: number,
): boolean {
  return Math.abs(masterTime - followerTime) > frameDuration(fps) + EPSILON;
}

/**
 * Target time after stepping `direction` frames from `currentTime`.
 * Lands on the center of the target frame, clamped to [0, duration].
 */
export function stepTarget(
  currentTime: number,
  direction: 1 | -1,
  fps: number,
  duration: number,
): number {
  const next = Math.min(
    Math.max(frameIndex(currentTime, fps) + direction, 0),
    lastFrameIndex(duration, fps),
  );
  return clampTime(frameCenterTime(next, fps), duration);
}

/** Above this drift (seconds) a hard seek is allowed; below it we nudge rate. */
export const HARD_SEEK_THRESHOLD_S = 0.15;
/** Minimum time between two hard seeks of the follower. */
export const HARD_SEEK_COOLDOWN_MS = 500;
/** Follower playbackRate is scaled by 1 +/- this while catching up. */
export const NUDGE_RATE = 0.05;

export type DriftDecision = {
  /** Issue `follower.currentTime = master.currentTime`. */
  seek: boolean;
  /** Multiplier applied to the master's playbackRate for the follower. */
  rateFactor: number;
};

export type DriftInput = {
  masterTime: number;
  followerTime: number;
  fps: number;
  followerSeeking: boolean;
  msSinceLastSeek: number;
};

/**
 * Decide how to correct follower drift while playing.
 * - within 1 frame: do nothing, normal rate
 * - follower mid-seek: do nothing (a new seek would restart it)
 * - up to HARD_SEEK_THRESHOLD_S, or inside the seek cooldown: nudge rate
 * - beyond the threshold and past the cooldown: hard seek
 */
export function decideDriftAction({
  masterTime,
  followerTime,
  fps,
  followerSeeking,
  msSinceLastSeek,
}: DriftInput): DriftDecision {
  const none: DriftDecision = { seek: false, rateFactor: 1 };
  if (followerSeeking) return none;
  if (!shouldCorrectDrift(masterTime, followerTime, fps)) return none;
  const drift = masterTime - followerTime; // > 0: follower is behind
  if (
    Math.abs(drift) > HARD_SEEK_THRESHOLD_S &&
    msSinceLastSeek >= HARD_SEEK_COOLDOWN_MS
  ) {
    return { seek: true, rateFactor: 1 };
  }
  return { seek: false, rateFactor: drift > 0 ? 1 + NUDGE_RATE : 1 - NUDGE_RATE };
}
