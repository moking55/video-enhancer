from __future__ import annotations

import subprocess
from pathlib import Path

import pytest


def ffmpeg(*args: str) -> None:
    p = subprocess.run(["ffmpeg", "-v", "error", "-y", *args], capture_output=True, text=True)
    assert p.returncode == 0, p.stderr


def make_clip(path: Path, *, size="1280x720", rate="30", seconds=2, audio=True, vcodec="libx264",
              extra: tuple[str, ...] = ()) -> Path:
    args = ["-f", "lavfi", "-i", f"testsrc2=size={size}:rate={rate}"]
    if audio:
        args += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"]
    args += ["-t", str(seconds), "-c:v", vcodec]
    if vcodec == "libx264":
        args += ["-preset", "ultrafast", "-crf", "20"]
    args += ["-pix_fmt", "yuv420p"]
    if audio:
        args += ["-c:a", "aac", "-b:a", "96k"]
    args += [*extra, "-movflags", "+faststart", str(path)]
    ffmpeg(*args)
    return path


def vfr_flags() -> tuple[str, ...]:
    p = subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=5",
                        "-frames:v", "1", "-fps_mode", "vfr", "-f", "null", "-"], capture_output=True)
    return ("-fps_mode", "vfr") if p.returncode == 0 else ("-vsync", "vfr")


def make_vfr_clip(path: Path) -> Path:
    """Genuinely VFR: 30 fps for the first second, then every 3rd frame kept (timestamps preserved)."""
    ffmpeg("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi",
           "-i", "sine=frequency=440:sample_rate=48000", "-t", "4",
           "-vf", r"select='not(mod(n\,3))+lt(n\,30)'", *vfr_flags(),
           "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(path))
    return path


@pytest.fixture(scope="session")
def clips(tmp_path_factory) -> dict[str, Path]:
    d = tmp_path_factory.mktemp("clips")
    return {
        "720p_audio": make_clip(d / "720p_audio.mp4"),
        "720p_noaudio": make_clip(d / "720p_noaudio.mp4", audio=False),
        "ntsc": make_clip(d / "ntsc.mp4", size="640x360", rate="30000/1001", seconds=2),
        "small": make_clip(d / "small.mp4", size="640x360", seconds=2),
        "vfr": make_vfr_clip(d / "vfr.mp4"),
        "hevc": make_clip(d / "hevc.mp4", size="320x180", seconds=1, audio=False, vcodec="libx265"),
    }
