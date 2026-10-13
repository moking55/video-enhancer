"""Background heartbeat: reports stage/progress every 15 s and surfaces cancel / lost-lease."""

from __future__ import annotations

import sys
import threading
from typing import Any

from .api import ApiClient, ApiError, StaleAttempt

INTERVAL_SEC = 15.0


class Cancelled(Exception):
    """The server asked us to stop (cancelRequested); report fail(CANCELLED)."""


class LeaseLost(Exception):
    """STALE_ATTEMPT: another attempt owns the job; stop silently."""


class Heartbeat:
    def __init__(self, api: ApiClient, job_id: str, attempt_id: str, interval: float = INTERVAL_SEC):
        self._api = api
        self._job_id = job_id
        self._attempt_id = attempt_id
        self._interval = interval
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

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def __enter__(self) -> "Heartbeat":
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.stop()

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            self.beat()

    # --- state -----------------------------------------------------------------------------
    def set_stage(self, stage: str, probe: dict[str, Any] | None = None) -> None:
        """Change stage and report it immediately (probe, if given, rides on this beat)."""
        with self._lock:
            self._stage = stage
            self._processed = None
            self._total = None
            if probe is not None:
                self._probe = probe
        self.beat()

    def set_progress(self, processed: int, total: int | None) -> None:
        with self._lock:
            self._processed = processed
            self._total = total

    def beat(self) -> None:
        """Send one heartbeat now. Transient API failures are tolerated; StaleAttempt sets `lost`."""
        with self._send_lock:
            if self.lost:
                return
            with self._lock:
                stage, processed, total, probe = self._stage, self._processed, self._total, self._probe
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
