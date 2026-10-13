"use client";

import { useEffect, useRef } from "react";

export const POLL_INTERVAL_MS = 3000;

/**
 * Calls `tick` every `intervalMs` while `active` and the tab is visible.
 * Hiding the tab stops the timer; showing it again ticks once immediately and
 * restarts the timer. A tick that is still running is never overlapped.
 */
export function usePolling(
  tick: () => Promise<void> | void,
  active: boolean,
  intervalMs: number = POLL_INTERVAL_MS,
) {
  const tickRef = useRef(tick);
  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    let running = false;

    const run = async () => {
      if (running) return;
      running = true;
      try {
        await tickRef.current();
      } finally {
        running = false;
      }
    };
    const start = () => {
      if (timer !== null || document.hidden) return;
      timer = setInterval(() => void run(), intervalMs);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        void run();
        start();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [active, intervalMs]);
}
