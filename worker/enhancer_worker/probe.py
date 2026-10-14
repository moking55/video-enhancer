"""ffprobe wrapper and input-limit checks (SPEC "Presets and limits")."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

from .errors import InputUnsupported, MediaError
from .presets import Preset

HDR_TRANSFERS = {"smpte2084", "arib-std-b67"}
# avg_frame_rate is frames / stream-duration, so container/audio padding and edit lists can
# shift it a little away from r_frame_rate even for constant-rate material.
CFR_REL_TOLERANCE = Fraction(2, 100)  # |avg - r| / r <= 2%
# Frame count vs. duration * r_frame_rate: allow max(2 frames, 1% of frames).
FRAME_COUNT_ABS_TOLERANCE = 2
FRAME_COUNT_REL_TOLERANCE = Fraction(1, 100)


@dataclass
class ProbeInfo:
    """Facts about a video file. width/height are display dimensions (rotation applied),
    which is what ffmpeg decodes to by default (autorotate)."""

    width: int
    height: int
    fps: Fraction  # r_frame_rate (fallback avg_frame_rate)
    avg_fps: Fraction
    frames: int
    duration: float  # container duration, seconds
    codec: str
    pix_fmt: str | None
    has_audio: bool
    audio_codec: str | None
    color_transfer: str | None
    rotation: int  # 0 / 90 / 180 / 270
    size_bytes: int
    format_name: str

    def to_summary(self) -> dict[str, Any]:
        """JSON-safe dict sent to the server as the heartbeat `probe` (camelCase)."""
        return {
            "width": self.width,
            "height": self.height,
            "fps": float(self.fps),
            "fpsRational": f"{self.fps.numerator}/{self.fps.denominator}",
            "avgFps": f"{self.avg_fps.numerator}/{self.avg_fps.denominator}",
            "frames": self.frames,
            "durationSec": self.duration,
            "codec": self.codec,
            "pixFmt": self.pix_fmt,
            "hasAudio": self.has_audio,
            "audioCodec": self.audio_codec,
            "colorTransfer": self.color_transfer,
            "rotation": self.rotation,
            "sizeBytes": self.size_bytes,
            "formatName": self.format_name,
        }


def _run_ffprobe(args: list[str]) -> str:
    try:
        p = subprocess.run(["ffprobe", "-v", "error", *args], capture_output=True, text=True)
    except FileNotFoundError as e:
        raise MediaError("ffprobe not found") from e
    if p.returncode != 0:
        raise MediaError(f"ffprobe failed: {p.stderr.strip()[-500:]}")
    return p.stdout


def count_frames(path: str | Path) -> int:
    """Exact frame count by decoding (slow)."""
    out = _run_ffprobe(
        ["-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames",
         "-of", "default=nokey=1:noprint_wrappers=1", str(path)]
    ).strip()
    try:
        return int(out)
    except ValueError as e:
        raise MediaError(f"could not count frames: {out!r}") from e


def _fraction(s: Any) -> Fraction:
    try:
        f = Fraction(str(s))
    except (ValueError, ZeroDivisionError):
        return Fraction(0)
    return f


def _rotation(stream: dict[str, Any]) -> int:
    rot: Any = (stream.get("tags") or {}).get("rotate")
    for sd in stream.get("side_data_list") or []:
        if "rotation" in sd:
            rot = sd["rotation"]
    try:
        return int(round(float(rot))) % 360 if rot is not None else 0
    except (TypeError, ValueError):
        return 0


def parse_probe(data: dict[str, Any], frames_fallback: Any = None) -> ProbeInfo:
    """Build ProbeInfo from ffprobe JSON. frames_fallback: callable returning the frame count
    when the stream has no usable nb_frames."""
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise InputUnsupported("no video stream")
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    fmt = data.get("format") or {}

    avg = _fraction(video.get("avg_frame_rate", "0/0"))
    rfr = _fraction(video.get("r_frame_rate", "0/0"))
    fps = rfr if rfr > 0 else avg

    nb = video.get("nb_frames")
    if nb is not None and str(nb).isdigit():
        frames = int(nb)
    elif frames_fallback is not None:
        frames = int(frames_fallback())
    else:
        frames = 0

    dur: Any = fmt.get("duration", video.get("duration"))
    duration = float(dur) if dur not in (None, "N/A") else 0.0

    rotation = _rotation(video)
    w, h = int(video.get("width", 0)), int(video.get("height", 0))
    if rotation in (90, 270):
        w, h = h, w

    return ProbeInfo(
        width=w,
        height=h,
        fps=fps,
        avg_fps=avg,
        frames=frames,
        duration=duration,
        codec=str(video.get("codec_name", "")),
        pix_fmt=video.get("pix_fmt"),
        has_audio=bool(audio),
        audio_codec=audio[0].get("codec_name") if audio else None,
        color_transfer=video.get("color_transfer"),
        rotation=rotation,
        size_bytes=int(fmt.get("size", 0) or 0),
        format_name=str(fmt.get("format_name", "")),
    )


def probe_file(path: str | Path, force_count: bool = False) -> ProbeInfo:
    """ffprobe a file. Counts frames by decoding when nb_frames is missing (or force_count)."""
    out = _run_ffprobe(["-print_format", "json", "-show_streams", "-show_format", str(path)])
    data = json.loads(out)
    if force_count:
        for s in data.get("streams", []):
            if s.get("codec_type") == "video":
                s["nb_frames"] = None
                break
    return parse_probe(data, frames_fallback=lambda: count_frames(path))


def is_cfr(info: ProbeInfo) -> bool:
    """True when the clip is effectively constant frame rate.

    CFR if EITHER holds:
      1. avg_frame_rate is within CFR_REL_TOLERANCE of r_frame_rate, or
      2. frame count matches duration * r_frame_rate within max(2, 1% of frames).
    Missing avg_frame_rate skips check 1 (falls back to check 2). If check 2 cannot be
    evaluated either (no frames/duration), the clip is treated as CFR rather than rejected.
    """
    fps = info.fps
    if fps <= 0:
        # Nothing to compare against; missing data is not grounds for rejection.
        return True

    if info.avg_fps > 0 and abs(info.avg_fps - fps) / fps <= CFR_REL_TOLERANCE:
        return True

    if info.frames > 0 and info.duration > 0:
        expected = Fraction(info.duration) * fps
        tolerance = max(Fraction(FRAME_COUNT_ABS_TOLERANCE), FRAME_COUNT_REL_TOLERANCE * info.frames)
        return abs(info.frames - expected) <= tolerance

    # Frame count or duration unknown: cannot prove VFR, so don't reject on missing data.
    return True


def check_input_limits(
    info: ProbeInfo, preset: Preset, *, allow_vfr: bool = False, check_size: bool = True
) -> None:
    """Raise InputUnsupported listing every violated limit.

    allow_vfr: the caller normalizes VFR to CFR itself. check_size: False for the normalized
    intermediate (near-lossless, so larger than the upload the size limit applies to)."""
    r: list[str] = []
    if "mp4" not in info.format_name.split(","):
        r.append(f"container must be MP4 (got {info.format_name or 'unknown'})")
    if info.codec != "h264":
        r.append(f"video codec must be H.264 (got {info.codec or 'unknown'})")
    if info.pix_fmt != "yuv420p":
        r.append(f"pixel format must be 8-bit yuv420p (got {info.pix_fmt})")
    if info.color_transfer in HDR_TRANSFERS:
        r.append(f"HDR is not supported (transfer {info.color_transfer})")
    if info.has_audio and info.audio_codec != "aac":
        r.append(f"audio must be AAC or absent (got {info.audio_codec})")
    if not allow_vfr and not is_cfr(info):
        r.append("variable frame rate is not supported (r_frame_rate != avg_frame_rate)")
    if info.frames <= 0 or info.width <= 0 or info.height <= 0:
        r.append("no decodable video frames")
    if info.duration > preset.max_duration_sec:
        r.append(f"duration {info.duration:.1f}s exceeds {preset.max_duration_sec}s")
    if check_size and info.size_bytes > preset.max_size_bytes:
        r.append(f"file size {info.size_bytes} bytes exceeds {preset.max_size_bytes}")
    if info.width > preset.max_width or info.height > preset.max_height:
        r.append(
            f"resolution {info.width}x{info.height} exceeds {preset.max_width}x{preset.max_height} "
            f"for preset {preset.id}"
        )
    if r:
        raise InputUnsupported("; ".join(r), r)
