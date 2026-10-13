"""Runner protocol: turns an input video into an enhanced output video."""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Protocol

from ..presets import Preset
from ..probe import ProbeInfo

# on_progress(processed_frames, total_frames); check_abort() raises Cancelled / LeaseLost.
ProgressFn = Callable[[int, int], None]
AbortFn = Callable[[], None]


class Runner(Protocol):
    name: str
    presets: tuple[str, ...]  # preset ids this runner can run (sent in claim)

    def process(
        self,
        input_path: Path,
        output_path: Path,
        preset: Preset,
        info: ProbeInfo,
        on_progress: ProgressFn,
        check_abort: AbortFn,
    ) -> None:
        """Write output_path (MP4 H.264 yuv420p, same frames/fps, audio copied). Must call
        check_abort() regularly and let its exception propagate."""
        ...
