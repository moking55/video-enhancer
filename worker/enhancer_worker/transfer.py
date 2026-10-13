"""Download the input / upload the output through signed URLs (streamed, never logged)."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable

import requests

from .errors import TransferError

CHUNK = 1 << 20
TRIES = 3


class _ServerError(Exception):
    def __init__(self, status: int):
        super().__init__(str(status))
        self.status = status


class _ClientError(Exception):
    def __init__(self, status: int):
        super().__init__(str(status))
        self.status = status


def _check_status(status: int) -> None:
    if status >= 500:
        raise _ServerError(status)
    if status >= 400:
        raise _ClientError(status)


def _retry(code: str, what: str, fn: Callable[[], None], sleep: Callable[[float], None], backoff: float) -> None:
    """Run fn up to TRIES times on connection errors / 5xx; 4xx fails at once. Messages hold no URL."""
    last = ""
    for attempt in range(TRIES):
        if attempt:
            sleep(backoff * (2 ** (attempt - 1)))
        try:
            fn()
            return
        except (requests.ConnectionError, requests.Timeout) as e:
            last = type(e).__name__
        except _ServerError as e:
            last = f"HTTP {e.status}"
        except _ClientError as e:
            raise TransferError(f"{what} rejected: HTTP {e.status}", code) from None
    raise TransferError(f"{what} failed after {TRIES} tries: {last}", code)


def download(
    url: str,
    dest: Path,
    expected_size: int | None,
    session: Any | None = None,
    sleep: Callable[[float], None] = time.sleep,
    backoff: float = 1.0,
) -> int:
    """Stream url to dest (via a .part file); verify size. Returns bytes written."""
    http = session or requests
    part = dest.with_name(dest.name + ".part")
    written = 0

    def attempt() -> None:
        nonlocal written
        written = 0
        with http.get(url, stream=True, timeout=(10, 60)) as resp:
            _check_status(resp.status_code)
            with open(part, "wb") as f:
                for block in resp.iter_content(chunk_size=CHUNK):
                    f.write(block)
                    written += len(block)

    try:
        _retry("DOWNLOAD_FAILED", "download", attempt, sleep, backoff)
        if expected_size is not None and written != expected_size:
            raise TransferError(
                f"download size mismatch: got {written} bytes, expected {expected_size}", "DOWNLOAD_FAILED"
            )
        part.replace(dest)
        return written
    finally:
        part.unlink(missing_ok=True)


def upload(
    put_url: str,
    headers: dict[str, str],
    path: Path,
    session: Any | None = None,
    sleep: Callable[[float], None] = time.sleep,
    backoff: float = 1.0,
) -> None:
    """PUT the file with exactly the given (signed) headers."""
    http = session or requests

    def attempt() -> None:
        with open(path, "rb") as f:
            resp = http.put(put_url, data=f, headers=headers, timeout=(10, 600))
        _check_status(resp.status_code)

    _retry("UPLOAD_FAILED", "upload", attempt, sleep, backoff)
