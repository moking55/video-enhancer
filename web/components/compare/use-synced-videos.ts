"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import {
  clampTime,
  decideDriftAction,
  frameIndex,
  stepTarget,
} from "./sync-math";

export type SyncedVideosState = {
  playing: boolean;
  currentTime: number;
  duration: number;
  /** Zero-based index of the frame at `currentTime`. */
  frame: number;
};

export type UseSyncedVideosOptions = {
  /** Frames per second of the clip (from ffprobe). */
  fps: number;
};

export type UseSyncedVideos = SyncedVideosState & {
  togglePlay: () => void;
  seek: (time: number) => void;
  /** Move both videos by exactly one frame. Pauses first if playing. */
  stepFrame: (direction: 1 | -1) => void;
};

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const INITIAL_STATE: SyncedVideosState = {
  playing: false,
  currentTime: 0,
  duration: 0,
  frame: 0,
};

/**
 * Keeps two <video> elements in sync. The master (output) drives the
 * follower (original, forced muted); the follower never drives the master.
 *
 * Both refs must already point at mounted elements when the consumer
 * component mounts (i.e. render both <video> elements unconditionally).
 */
export function useSyncedVideos(
  masterRef: RefObject<HTMLVideoElement | null>,
  followerRef: RefObject<HTMLVideoElement | null>,
  { fps }: UseSyncedVideosOptions,
): UseSyncedVideos {
  const [state, setState] = useState<SyncedVideosState>(INITIAL_STATE);
  const fpsRef = useRef(fps);

  useEffect(() => {
    fpsRef.current = fps;
  }, [fps]);

  useEffect(() => {
    const master = masterRef.current as FrameCallbackVideo | null;
    const follower = followerRef.current;
    if (!master || !follower) return;

    follower.muted = true;

    let frameHandle: number | null = null;
    let rafHandle: number | null = null;

    const publish = () => {
      const currentTime = master.currentTime;
      const duration = Number.isFinite(master.duration) ? master.duration : 0;
      const playing = !master.paused && !master.ended;
      const frame = frameIndex(currentTime, fpsRef.current);
      setState((prev) =>
        prev.playing === playing &&
        prev.currentTime === currentTime &&
        prev.duration === duration &&
        prev.frame === frame
          ? prev
          : { playing, currentTime, duration, frame },
      );
    };

    let lastSeekAt = Number.NEGATIVE_INFINITY;

    const restoreRate = () => {
      if (follower.playbackRate !== master.playbackRate) {
        follower.playbackRate = master.playbackRate;
      }
    };

    const seekFollower = () => {
      lastSeekAt = performance.now();
      follower.currentTime = master.currentTime;
    };

    /** Copy master time onto the follower (deferred while it has no metadata). */
    const alignFollower = () => {
      if (follower.readyState < HTMLMediaElement.HAVE_METADATA) return;
      seekFollower();
    };

    const correctDrift = () => {
      if (follower.readyState < HTMLMediaElement.HAVE_METADATA) return;
      const decision = decideDriftAction({
        masterTime: master.currentTime,
        followerTime: follower.currentTime,
        fps: fpsRef.current,
        followerSeeking: follower.seeking,
        msSinceLastSeek: performance.now() - lastSeekAt,
      });
      if (decision.seek) {
        seekFollower();
        restoreRate();
        return;
      }
      const target = master.playbackRate * decision.rateFactor;
      if (follower.playbackRate !== target) follower.playbackRate = target;
    };

    const tick = () => {
      frameHandle = null;
      rafHandle = null;
      if (master.paused || master.ended) return;
      correctDrift();
      publish();
      schedule();
    };

    const schedule = () => {
      if (frameHandle !== null || rafHandle !== null) return;
      if (typeof master.requestVideoFrameCallback === "function") {
        frameHandle = master.requestVideoFrameCallback(tick);
      } else {
        rafHandle = requestAnimationFrame(tick);
      }
    };

    const cancelSchedule = () => {
      if (frameHandle !== null) {
        master.cancelVideoFrameCallback?.(frameHandle);
        frameHandle = null;
      }
      if (rafHandle !== null) {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
      }
    };

    const startFollowerPlayback = () => {
      if (master.paused) return;
      follower.play().catch(() => {
        // Autoplay/abort rejections are harmless; drift loop keeps it aligned.
      });
    };

    const onPlay = () => {
      alignFollower();
      startFollowerPlayback();
      schedule();
      publish();
    };
    const onPause = () => {
      follower.pause();
      restoreRate();
      alignFollower();
      cancelSchedule();
      publish();
    };
    const onWaiting = () => follower.pause();
    const onPlaying = () => {
      alignFollower();
      startFollowerPlayback();
      schedule();
      publish();
    };
    const onSeeking = () => {
      alignFollower();
      publish();
    };
    const onSeeked = () => {
      alignFollower();
      publish();
    };
    const onRateChange = () => {
      follower.playbackRate = master.playbackRate;
    };
    const onMetadata = () => publish();
    const onFollowerMetadata = () => {
      follower.muted = true;
      follower.playbackRate = master.playbackRate;
      alignFollower();
      startFollowerPlayback();
    };

    const masterEvents: [string, () => void][] = [
      ["play", onPlay],
      ["pause", onPause],
      ["ended", onPause],
      ["waiting", onWaiting],
      ["playing", onPlaying],
      ["seeking", onSeeking],
      ["seeked", onSeeked],
      ["ratechange", onRateChange],
      ["timeupdate", publish],
      ["loadedmetadata", onMetadata],
      ["durationchange", onMetadata],
    ];
    for (const [name, handler] of masterEvents) {
      master.addEventListener(name, handler);
    }
    follower.addEventListener("loadedmetadata", onFollowerMetadata);

    // Pick up whatever state the elements are already in (e.g. cached media).
    follower.playbackRate = master.playbackRate;
    queueMicrotask(() => {
      publish();
      if (!master.paused) onPlay();
    });

    return () => {
      cancelSchedule();
      for (const [name, handler] of masterEvents) {
        master.removeEventListener(name, handler);
      }
      follower.removeEventListener("loadedmetadata", onFollowerMetadata);
    };
  }, [masterRef, followerRef]);

  const seek = useCallback(
    (time: number) => {
      const master = masterRef.current;
      if (!master) return;
      const duration = Number.isFinite(master.duration) ? master.duration : 0;
      // The master's `seeking` listener propagates the time to the follower.
      master.currentTime = clampTime(time, duration);
    },
    [masterRef],
  );

  const togglePlay = useCallback(() => {
    const master = masterRef.current;
    if (!master) return;
    if (master.paused || master.ended) {
      master.play().catch(() => {
        // Rejected play() (e.g. interrupted by pause) needs no handling.
      });
    } else {
      master.pause();
    }
  }, [masterRef]);

  const stepFrame = useCallback(
    (direction: 1 | -1) => {
      const master = masterRef.current;
      if (!master) return;
      if (!master.paused) master.pause();
      const duration = Number.isFinite(master.duration) ? master.duration : 0;
      master.currentTime = stepTarget(
        master.currentTime,
        direction,
        fpsRef.current,
        duration,
      );
    },
    [masterRef],
  );

  return { ...state, togglePlay, seek, stepFrame };
}
