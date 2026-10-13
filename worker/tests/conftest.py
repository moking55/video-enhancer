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


@pytest.fixture(scope="session")
def clips(tmp_path_factory) -> dict[str, Path]:
    d = tmp_path_factory.mktemp("clips")
    return {
        "720p_audio": make_clip(d / "720p_audio.mp4"),
        "720p_noaudio": make_clip(d / "720p_noaudio.mp4", audio=False),
        "ntsc": make_clip(d / "ntsc.mp4", size="640x360", rate="30000/1001", seconds=2),
        "small": make_clip(d / "small.mp4", size="640x360", seconds=2),
        "hevc": make_clip(d / "hevc.mp4", size="320x180", seconds=1, audio=False, vcodec="libx265"),
    }
