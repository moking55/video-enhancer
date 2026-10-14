"""Runner registry."""

from __future__ import annotations

from .base import Runner

RUNNER_NAMES = ("mock", "realesrgan")


def get_runner(name: str, weights_dir: str | None = None, device: str = "auto") -> Runner:
    if name == "mock":
        from .mock import MockRunner

        return MockRunner()
    if name == "realesrgan":
        from .realesrgan import RealEsrganRunner

        return RealEsrganRunner(weights_dir, device=device)
    raise ValueError(f"unknown runner {name!r} (choose from {', '.join(RUNNER_NAMES)})")
