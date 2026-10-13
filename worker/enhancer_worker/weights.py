"""Real-ESRGAN weights: registry of official release files, cached download with SHA-256 check.

The cache directory is a parameter (Colab passes a Google Drive path so weights survive sessions).
Downloads are atomic (temp file in the cache dir, then os.replace), so a killed session never
leaves a truncated weight file behind under the final name.
"""

from __future__ import annotations

import hashlib
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping

import requests

from .errors import WorkerError

_RELEASE = "https://github.com/xinntao/Real-ESRGAN/releases/download"


class WeightsError(WorkerError):
    code = "WEIGHTS_FAILED"


@dataclass(frozen=True)
class WeightSpec:
    name: str  # model name (registry key)
    filename: str
    url: str
    sha256: str | None = None  # None: not pinned; the hash is computed and logged on download
    size_bytes: int | None = None


# SHA-256 / sizes computed from the official GitHub release assets on 2026-10-14.
WEIGHTS: Mapping[str, WeightSpec] = {
    s.name: s
    for s in (
        WeightSpec(
            "RealESRGAN_x4plus", "RealESRGAN_x4plus.pth", f"{_RELEASE}/v0.1.0/RealESRGAN_x4plus.pth",
            "4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1", 67040989,
        ),
        WeightSpec(
            "RealESRGAN_x2plus", "RealESRGAN_x2plus.pth", f"{_RELEASE}/v0.2.1/RealESRGAN_x2plus.pth",
            "49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb", 67061725,
        ),
        WeightSpec(
            "realesr-animevideov3", "realesr-animevideov3.pth",
            f"{_RELEASE}/v0.2.5.0/realesr-animevideov3.pth",
            "b8a8376811077954d82ca3fcf476f1ac3da3e8a68a4f4d71363008000a18b75d", 2504012,
        ),
    )
}

DEFAULT_CACHE_DIR = Path("~/.cache/enhancer-weights").expanduser()


def sha256_file(path: str | Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(chunk):
            h.update(block)
    return h.hexdigest()


def _default_log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _download(url: str, tmp: Path, timeout: float) -> str:
    """Stream url into tmp; return the SHA-256 of what was written."""
    h = hashlib.sha256()
    try:
        with requests.get(url, stream=True, timeout=timeout, allow_redirects=True) as resp:
            resp.raise_for_status()
            expected = resp.headers.get("Content-Length")
            written = 0
            with open(tmp, "wb") as f:
                for block in resp.iter_content(chunk_size=1 << 20):
                    f.write(block)
                    h.update(block)
                    written += len(block)
            if expected and expected.isdigit() and int(expected) != written:
                raise WeightsError(f"truncated download ({written} of {expected} bytes)")
    except requests.RequestException as e:
        # never echo the URL (it may be signed after redirects)
        raise WeightsError(f"weights download failed: {type(e).__name__}") from e
    return h.hexdigest()


def ensure_weights(
    name: str,
    cache_dir: str | Path | None = None,
    *,
    registry: Mapping[str, WeightSpec] | None = None,
    log: Callable[[str], None] = _default_log,
    timeout: float = 60.0,
) -> Path:
    """Return the path of the cached weight file, downloading it first when needed."""
    reg = registry if registry is not None else WEIGHTS
    if name not in reg:
        raise WeightsError(f"unknown weights {name!r} (known: {', '.join(reg)})")
    spec = reg[name]
    cache = Path(cache_dir).expanduser() if cache_dir else DEFAULT_CACHE_DIR
    cache.mkdir(parents=True, exist_ok=True)
    dest = cache / spec.filename

    if dest.exists():
        if dest.stat().st_size > 0 and (spec.sha256 is None or sha256_file(dest) == spec.sha256):
            return dest
        log(f"weights: cached {spec.filename} is invalid, downloading again")
        dest.unlink()

    tmp = cache / f"{spec.filename}.{os.getpid()}.part"
    log(f"weights: downloading {spec.filename}")
    try:
        digest = _download(spec.url, tmp, timeout)
        if spec.sha256 is not None and digest != spec.sha256:
            raise WeightsError(f"SHA-256 mismatch for {spec.filename}: got {digest}, expected {spec.sha256}")
        if spec.sha256 is None:
            log(f"weights: {spec.filename} sha256 {digest} (not pinned)")
        os.replace(tmp, dest)
    finally:
        tmp.unlink(missing_ok=True)
    log(f"weights: {spec.filename} ready")
    return dest
