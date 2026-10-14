"""Runner registry."""

from __future__ import annotations

from .base import Runner

RUNNER_NAMES = ("mock", "realesrgan", "auto")  # auto = realesrgan + spandrel presets


def get_runner(name: str, weights_dir: str | None = None, device: str = "auto") -> Runner:
    if name == "mock":
        from .mock import MockRunner

        return MockRunner()
    if name == "realesrgan":
        from .realesrgan import RealEsrganRunner

        return RealEsrganRunner(weights_dir, device=device)
    if name == "auto":
        from .realesrgan import AutoRunner

        return AutoRunner(weights_dir, device=device)
    raise ValueError(f"unknown runner {name!r} (choose from {', '.join(RUNNER_NAMES)})")
