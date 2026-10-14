"""Background heartbeat: reports stage/progress and surfaces cancel / lost-lease.

Sends: every INTERVAL_SEC (keepalive), immediately on every stage change, at most every
PROGRESS_INTERVAL_SEC while progress advances, and immediately when progress reaches 100%.
Every send snapshots the *latest* state while holding the send lock, so concurrent callers
(timer thread, stage changes, final flush) are serialised and a late tick can never report
older state than a newer send.
"""

from __future__ import annotations

import sys
import threading
import time
from typing import Any, Callable

from .api import ApiClient, ApiError, StaleAttempt

INTERVAL_SEC = 15.0
PROGRESS_INTERVAL_SEC = 3.0
# Stages that start counting frames from scratch; later stages (encode/verify/upload) keep reporting
# the last known progress so the web never sees the counter vanish or go stale at e.g. 120/200.
_RESET_STAGES = frozenset({"download", "probe", "enhance"})


class Cancelled(Exception):
    """The server asked us to stop (cancelRequested); report fail(CANCELLED)."""


class LeaseLost(Exception):
    """STALE_ATTEMPT: another attempt owns the job; stop silently."""


class Heartbeat:
    def __init__(
        self,
        api: ApiClient,
        job_id: str,
        attempt_id: str,
        interval: float = INTERVAL_SEC,
        progress_interval: float = PROGRESS_INTERVAL_SEC,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._api = api
        self._job_id = job_id
        self._attempt_id = attempt_id
        self._interval = interval
        self._progress_interval = progress_interval
        self._clock = clock
        self._last_sent = clock()
        self._wake = threading.Event()  # set by set_progress: the thread should send now
        self._lock = threading.Lock()  # guards state fields (never held during network I/O)
        self._send_lock = threading.Lock()  # serialises sends
        self._stage = "download"
        self._processed: int | None = None
        self._total: int | None = None
        self._probe: dict[str, Any] | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.cancel_requested = False
        self.lost = False

    # --- lifecycle -------------------------------------------------------------------------
    def start(self) -> "Heartbeat":
        self._thread = threading.Thread(target=self._run, name="heartbeat", daemon=True)
        self._thread.start()
        return self

    def stop(self, flush: bool = False) -> None:
        """Join the thread; with flush=True then send one last beat (after the join: no concurrent send)."""
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
        if flush:
            self.beat()

    def __enter__(self) -> "Heartbeat":
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.stop()

    def _run(self) -> None:
        while not self._stop.is_set():
            self._wake.wait(self._interval)
            if self._stop.is_set():
                break
            self._wake.clear()
            self.beat()

    # --- state -----------------------------------------------------------------------------
    def set_stage(self, stage: str, probe: dict[str, Any] | None = None) -> None:
        """Change stage and report it immediately (probe, if given, rides on this beat)."""
        with self._lock:
            self._stage = stage
            if stage in _RESET_STAGES:
                self._processed = None
                self._total = None
            if probe is not None:
                self._probe = probe
        self.beat()

    def set_progress(self, processed: int, total: int | None) -> None:
        """Record progress (never decreasing, capped at total). Cheap and non-blocking: the heartbeat
        thread does the sending, at most every progress_interval and right away at 100%."""
        with self._lock:
            if total is not None:
                processed = min(processed, total)
            if self._processed is not None and processed < self._processed:
                processed = self._processed
            self._processed = processed
            self._total = total
            done = total is not None and total > 0 and processed >= total
            due = done or self._clock() - self._last_sent >= self._progress_interval
        if due:
            self._wake.set()

    def beat(self) -> None:
        """Send one heartbeat now. Transient API failures are tolerated; StaleAttempt sets `lost`."""
        with self._send_lock:
            if self.lost:
                return
            with self._lock:  # snapshot under the send lock: always the newest state
                stage, processed, total, probe = self._stage, self._processed, self._total, self._probe
                self._last_sent = self._clock()
            try:
                cancel = self._api.heartbeat(self._job_id, self._attempt_id, stage, processed, total, probe)
            except StaleAttempt:
                self.lost = True
                return
            except ApiError as e:
                print(f"heartbeat failed: {e}", file=sys.stderr, flush=True)
                return
            with self._lock:
                if probe is not None and self._probe is probe:
                    self._probe = None  # sent once
            if cancel:
                self.cancel_requested = True

    def check(self) -> None:
        """Raise LeaseLost / Cancelled if the job must stop."""
        if self.lost:
            raise LeaseLost()
        if self.cancel_requested:
            raise Cancelled()
