"""Mock runner: plain ffmpeg lanczos upscale (no GPU). One command; progress from -progress pipe:1."""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from ..errors import MediaError
from ..media import passthrough_flags, x264_args
from ..presets import Preset
from ..probe import ProbeInfo
from .base import AbortFn, ProgressFn


def build_cmd(input_path: Path, output_path: Path, scale: float) -> list[str]:
    s = f"{scale:g}"
    return ["ffmpeg", "-v", "error", "-nostats", "-y", "-i", str(input_path),
            "-map", "0:v:0", "-map", "0:a?", *passthrough_flags(),
            "-vf", f"scale=iw*{s}:ih*{s}:flags=lanczos",
            *x264_args(), "-c:a", "copy", "-movflags", "+faststart",
            "-progress", "pipe:1", str(output_path)]


class MockRunner:
    name = "mock"
    presets = ("mock-x2",)

    def process(
        self,
        input_path: Path,
        output_path: Path,
        preset: Preset,
        info: ProbeInfo,
        on_progress: ProgressFn,
        check_abort: AbortFn,
    ) -> None:
        cmd = build_cmd(input_path, output_path, preset.scale)
        with tempfile.TemporaryFile() as err:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, text=True)
            try:
                assert proc.stdout is not None
                for line in proc.stdout:
                    key, _, value = line.strip().partition("=")
                    if key == "frame" and value.isdigit():
                        on_progress(int(value), info.frames)
                    check_abort()
                rc = proc.wait()
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
            if rc != 0:
                err.seek(0)
                tail = err.read().decode("utf-8", "replace").strip()[-500:]
                raise MediaError(f"ffmpeg failed ({rc}): {tail}")
        on_progress(info.frames, info.frames)
