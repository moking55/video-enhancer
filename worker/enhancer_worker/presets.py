"""Preset parameters as received in the claim response (with SPEC defaults as fallback)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

DEFAULT_MAX_DURATION_SEC = 120
DEFAULT_MAX_SIZE_BYTES = 500 * 1024 * 1024

# SPEC "Presets and limits": max input dimensions per preset id.
_DEFAULT_MAX_INPUT = {
    "realesrgan-x2": (1920, 1080),
    "realesrgan-x4": (960, 540),
    "realesrgan-anime-x4": (960, 540),
    "realesrgan-fast-x4": (960, 540),
    "span-fast-x2": (1920, 1080),
    "compact-anime-x2": (1920, 1080),
    "span-balanced-x4": (960, 540),
    "plksr-quality-x4": (960, 540),
    "mock-x2": (1920, 1080),
}


@dataclass(frozen=True)
class Preset:
    id: str
    model: str
    scale: float
    max_width: int
    max_height: int
    max_duration_sec: float = DEFAULT_MAX_DURATION_SEC
    max_size_bytes: int = DEFAULT_MAX_SIZE_BYTES
    params: Any = None

    @classmethod
    def from_claim(cls, d: dict[str, Any]) -> "Preset":
        params = d.get("params") if isinstance(d.get("params"), dict) else {}
        max_input = params.get("maxInput") or {}
        limits = params.get("limits") or {}
        dw, dh = _DEFAULT_MAX_INPUT.get(d["id"], (1920, 1080))
        return cls(
            id=d["id"],
            model=d.get("model", ""),
            scale=d["scale"],
            max_width=int(max_input.get("width", dw)),
            max_height=int(max_input.get("height", dh)),
            max_duration_sec=limits.get("maxDurationSec", DEFAULT_MAX_DURATION_SEC),
            max_size_bytes=int(limits.get("maxSizeBytes", DEFAULT_MAX_SIZE_BYTES)),
            params=params,
        )
