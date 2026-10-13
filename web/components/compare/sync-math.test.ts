import { describe, expect, it } from "vitest";

import {
  FALLBACK_FPS,
  HARD_SEEK_COOLDOWN_MS,
  NUDGE_RATE,
  clampTime,
  decideDriftAction,
  frameCenterTime,
  frameDuration,
  frameIndex,
  lastFrameIndex,
  shouldCorrectDrift,
  stepTarget,
} from "./sync-math";

const NTSC = 30000 / 1001;

describe("shouldCorrectDrift", () => {
  it("does not correct within one frame", () => {
    expect(shouldCorrectDrift(5, 5, 30)).toBe(false);
    expect(shouldCorrectDrift(5, 5.02, 30)).toBe(false);
    expect(shouldCorrectDrift(5.02, 5, 30)).toBe(false);
  });

  it("tolerates exactly one frame", () => {
    expect(shouldCorrectDrift(5 + 1 / 30, 5, 30)).toBe(false);
  });

  it("corrects beyond one frame in either direction", () => {
    expect(shouldCorrectDrift(5.05, 5, 30)).toBe(true);
    expect(shouldCorrectDrift(5, 5.05, 30)).toBe(true);
  });

  it("scales threshold with fractional fps", () => {
    const frame = 1 / NTSC;
    expect(shouldCorrectDrift(10 + frame * 0.9, 10, NTSC)).toBe(false);
    expect(shouldCorrectDrift(10 + frame * 1.1, 10, NTSC)).toBe(true);
  });
});

describe("frameIndex", () => {
  it("floors time within a frame", () => {
    expect(frameIndex(0, 30)).toBe(0);
    expect(frameIndex(0.0333, 30)).toBe(0);
    expect(frameIndex(0.034, 30)).toBe(1);
    expect(frameIndex(1.0, 30)).toBe(30);
  });

  it("is stable on exact frame boundaries despite float error", () => {
    for (let n = 0; n < 500; n++) {
      expect(frameIndex(n / NTSC, NTSC)).toBe(n);
      expect(frameIndex(n / 24, 24)).toBe(n);
    }
  });

  it("round-trips with frameCenterTime", () => {
    for (const fps of [24, 30, 60, NTSC, 24000 / 1001]) {
      for (let n = 0; n < 200; n++) {
        expect(frameIndex(frameCenterTime(n, fps), fps)).toBe(n);
      }
    }
  });

  it("handles negative and non-finite time", () => {
    expect(frameIndex(-1, 30)).toBe(0);
    expect(frameIndex(Number.NaN, 30)).toBe(0);
  });
});

describe("stepTarget", () => {
  it("steps forward by exactly one frame, landing on frame center", () => {
    const t = stepTarget(frameCenterTime(10, 30), 1, 30, 10);
    expect(t).toBeCloseTo(frameCenterTime(11, 30), 12);
    expect(t - frameCenterTime(10, 30)).toBeCloseTo(1 / 30, 12);
  });

  it("steps backward by exactly one frame", () => {
    const t = stepTarget(frameCenterTime(10, 30), -1, 30, 10);
    expect(t).toBeCloseTo(frameCenterTime(9, 30), 12);
  });

  it("steps from a time that sits on a frame edge", () => {
    expect(frameIndex(stepTarget(5 / 30, 1, 30, 10), 30)).toBe(6);
    expect(frameIndex(stepTarget(5 / 30, -1, 30, 10), 30)).toBe(4);
  });

  it("works with fractional fps", () => {
    let t = frameCenterTime(0, NTSC);
    for (let i = 0; i < 100; i++) t = stepTarget(t, 1, NTSC, 60);
    expect(frameIndex(t, NTSC)).toBe(100);
    for (let i = 0; i < 100; i++) t = stepTarget(t, -1, NTSC, 60);
    expect(frameIndex(t, NTSC)).toBe(0);
  });

  it("clamps at the start", () => {
    expect(stepTarget(0, -1, 30, 10)).toBeCloseTo(frameCenterTime(0, 30), 12);
    expect(stepTarget(0.001, -1, 30, 10)).toBeGreaterThanOrEqual(0);
  });

  it("clamps at the last frame / duration", () => {
    const duration = 10; // 300 frames at 30 fps, last index 299
    const last = frameCenterTime(299, 30);
    expect(stepTarget(last, 1, 30, duration)).toBeCloseTo(last, 12);
    expect(stepTarget(duration, 1, 30, duration)).toBeLessThanOrEqual(duration);
    expect(frameIndex(stepTarget(duration, 1, 30, duration), 30)).toBe(299);
  });

  it("never exceeds duration for non-integer frame counts", () => {
    const duration = 1.01; // 30.3 frames -> last index 30, center 1.0166 > duration
    expect(stepTarget(0.99, 1, 30, duration)).toBeLessThanOrEqual(duration);
    expect(stepTarget(duration, 1, 30, duration)).toBeLessThanOrEqual(duration);
  });

  it("only clamps at 0 when duration is unknown", () => {
    expect(stepTarget(1, 1, 30, Number.NaN)).toBeCloseTo(
      frameCenterTime(0, 30),
      12,
    );
  });
});

describe("helpers", () => {
  it("lastFrameIndex", () => {
    expect(lastFrameIndex(10, 30)).toBe(299);
    expect(lastFrameIndex(0, 30)).toBe(0);
    expect(lastFrameIndex(Number.POSITIVE_INFINITY, 30)).toBe(0);
  });

  it("clampTime", () => {
    expect(clampTime(-1, 10)).toBe(0);
    expect(clampTime(11, 10)).toBe(10);
    expect(clampTime(5, 10)).toBe(5);
    expect(clampTime(5, 0)).toBe(5);
  });

  it("falls back to a default fps for invalid values", () => {
    expect(frameDuration(0)).toBeCloseTo(1 / FALLBACK_FPS, 12);
    expect(frameDuration(Number.NaN)).toBeCloseTo(1 / FALLBACK_FPS, 12);
  });
});

describe("decideDriftAction", () => {
  const base = {
    masterTime: 10,
    followerTime: 10,
    fps: 30,
    followerSeeking: false,
    msSinceLastSeek: 10_000,
  };

  it("does nothing within one frame", () => {
    expect(decideDriftAction({ ...base, followerTime: 9.98 })).toEqual({
      seek: false,
      rateFactor: 1,
    });
  });

  it("nudges rate up when the follower is behind (small drift)", () => {
    const d = decideDriftAction({ ...base, followerTime: 9.9 });
    expect(d.seek).toBe(false);
    expect(d.rateFactor).toBeCloseTo(1 + NUDGE_RATE, 12);
  });

  it("nudges rate down when the follower is ahead (small drift)", () => {
    const d = decideDriftAction({ ...base, followerTime: 10.1 });
    expect(d.seek).toBe(false);
    expect(d.rateFactor).toBeCloseTo(1 - NUDGE_RATE, 12);
  });

  it("hard seeks above the threshold", () => {
    expect(decideDriftAction({ ...base, followerTime: 9.5 })).toEqual({
      seek: true,
      rateFactor: 1,
    });
    expect(decideDriftAction({ ...base, followerTime: 10.5 }).seek).toBe(true);
  });

  it("never acts while the follower is seeking", () => {
    expect(
      decideDriftAction({ ...base, followerTime: 5, followerSeeking: true }),
    ).toEqual({ seek: false, rateFactor: 1 });
  });

  it("does not hard seek again inside the cooldown (nudges instead)", () => {
    const d = decideDriftAction({
      ...base,
      followerTime: 9.5,
      msSinceLastSeek: HARD_SEEK_COOLDOWN_MS - 1,
    });
    expect(d.seek).toBe(false);
    expect(d.rateFactor).toBeCloseTo(1 + NUDGE_RATE, 12);
    expect(
      decideDriftAction({
        ...base,
        followerTime: 9.5,
        msSinceLastSeek: HARD_SEEK_COOLDOWN_MS,
      }).seek,
    ).toBe(true);
  });
});
