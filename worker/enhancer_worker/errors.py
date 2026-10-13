"""Shared exception types and text sanitising (never leak URLs or the token)."""

from __future__ import annotations

import re

_URL_RE = re.compile(r"https?://\S+")


def sanitize(text: str, secrets: tuple[str, ...] = (), limit: int = 2000) -> str:
    """Strip URLs (they may be signed) and secrets from text, then truncate."""
    for s in secrets:
        if s:
            text = text.replace(s, "<redacted>")
    text = _URL_RE.sub("<url>", text)
    return text[:limit]


class WorkerError(Exception):
    """Base error carrying the failure code reported to the server."""

    code = "INTERNAL"

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        if code:
            self.code = code


class InputUnsupported(WorkerError):
    code = "INPUT_UNSUPPORTED"

    def __init__(self, reason: str, reasons: list[str] | None = None):
        super().__init__(reason)
        self.reasons = reasons or [reason]


class MediaError(WorkerError):
    """ffmpeg/ffprobe failed."""

    code = "ENCODE_FAILED"


class VerifyFailed(WorkerError):
    code = "VERIFY_FAILED"

    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


class TransferError(WorkerError):
    """Download/upload failed (code DOWNLOAD_FAILED or UPLOAD_FAILED)."""
