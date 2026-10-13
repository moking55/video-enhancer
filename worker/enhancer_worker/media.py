"""ffmpeg command builders and output verification.

Colour handling lives in exactly one place (RGB_FROM_YUV_VF / YUV_FROM_RGB_VF below): every
yuv->rgb24 and rgb24->yuv conversion uses BT.709 explicitly, and the encoder tags the output
as BT.709. (swscale uses in_color_matrix for the YUV side of yuv->rgb and out_color_matrix for
the YUV side of rgb->yuv; the trailing format= pins the conversion inside the scale filter.)
"""

from __future__ import annotations

import subprocess
from fractions import Fraction
from functools import lru_cache
from pathlib import Path
from typing import Any

from .errors import MediaError, VerifyFailed
from .probe import ProbeInfo, probe_file

RGB_FROM_YUV_VF = "scale=in_color_matrix=bt709,format=rgb24"
YUV_FROM_RGB_VF = "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p"
BT709_TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]

DURATION_TOLERANCE_SEC = 0.05  # on top of one frame


@lru_cache(maxsize=None)
def passthrough_flags(ffmpeg: str = "ffmpeg") -> tuple[str, ...]:
    """-fps_mode passthrough (ffmpeg >= 5.1) or -vsync 0 (older, e.g. Colab's 4.4): feature-tested."""
    p = subprocess.run(
        [ffmpeg, "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=5", "-frames:v", "1",
         "-fps_mode", "passthrough", "-f", "null", "-"],
        capture_output=True,
    )
    return ("-fps_mode", "passthrough") if p.returncode == 0 else ("-vsync", "0")


def fps_arg(fps: Fraction) -> str:
    return f"{fps.numerator}/{fps.denominator}"


def x264_args(crf: int = 18) -> list[str]:
    """Output video encoding per SPEC: H.264 yuv420p CRF 18 preset medium, tagged BT.709."""
    return ["-c:v", "libx264", "-preset", "medium", "-crf", str(crf), "-pix_fmt", "yuv420p", *BT709_TAGS]


def nvenc_args(cq: int = 19) -> list[str]:
    """Output video encoding on NVIDIA GPUs (SPEC: used only when the feature test passes)."""
    return ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", str(cq), "-b:v", "0",
            "-pix_fmt", "yuv420p", *BT709_TAGS]


@lru_cache(maxsize=None)
def nvenc_available(ffmpeg: str = "ffmpeg") -> bool:
    """Feature test: can h264_nvenc encode a tiny clip with exactly the args we would use?"""
    try:
        p = subprocess.run(
            [ffmpeg, "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=256x256:r=5", "-frames:v", "5",
             "-vf", YUV_FROM_RGB_VF, *nvenc_args(), "-f", "null", "-"],
            capture_output=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return p.returncode == 0


def decode_cmd(src: str | Path, extra_vf: str | None = None) -> list[str]:
    """Decode all frames of the first video stream to raw rgb24 on stdout, one per input frame."""
    vf = RGB_FROM_YUV_VF if not extra_vf else f"{extra_vf},{RGB_FROM_YUV_VF}"
    return ["ffmpeg", "-v", "error", "-i", str(src), "-map", "0:v:0", *passthrough_flags(),
            "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]


def encode_cmd(dst: str | Path, width: int, height: int, fps: Fraction, crf: int = 18,
               codec_args: list[str] | None = None) -> list[str]:
    """Encode raw rgb24 frames from stdin to a video-only H.264 mp4 (libx264 unless codec_args given)."""
    return ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-s", f"{width}x{height}", "-framerate", fps_arg(fps), "-i", "-",
            "-vf", YUV_FROM_RGB_VF, *(codec_args or x264_args(crf)), "-an", str(dst)]


def mux_cmd(video_only: str | Path, original: str | Path, dst: str | Path) -> list[str]:
    """Copy video from video_only and audio from original (optional; no -shortest)."""
    return ["ffmpeg", "-v", "error", "-y", "-i", str(video_only), "-i", str(original),
            "-map", "0:v:0", "-map", "1:a?", "-c:v", "copy", "-c:a", "copy",
            "-movflags", "+faststart", str(dst)]


def run(cmd: list[str]) -> None:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True)
    except FileNotFoundError as e:
        raise MediaError(f"{cmd[0]} not found") from e
    if p.returncode != 0:
        raise MediaError(f"{cmd[0]} failed ({p.returncode}): {p.stderr.strip()[-500:]}")


def expected_size(info: ProbeInfo, scale: float) -> tuple[int, int]:
    return round(info.width * scale), round(info.height * scale)


def verify_output(input_info: ProbeInfo, output_path: str | Path, scale: float) -> ProbeInfo:
    """Check the output against the input; raise VerifyFailed listing all problems.
    Returns the output's ProbeInfo (frames counted by decoding)."""
    out = probe_file(output_path, force_count=True)
    problems: list[str] = []

    if out.frames != input_info.frames:
        problems.append(f"frame count {out.frames} != input {input_info.frames}")

    ew, eh = expected_size(input_info, scale)
    if ew % 2 or eh % 2:
        problems.append(f"expected size {ew}x{eh} is odd (cannot be yuv420p)")
    if (out.width, out.height) != (ew, eh):
        problems.append(f"size {out.width}x{out.height} != expected {ew}x{eh}")

    fps = input_info.fps
    tol = (1.0 / float(fps) if fps > 0 else 0.0) + DURATION_TOLERANCE_SEC
    if abs(out.duration - input_info.duration) > tol:
        problems.append(
            f"duration {out.duration:.3f}s differs from input {input_info.duration:.3f}s by more than {tol:.3f}s"
        )

    if out.has_audio != input_info.has_audio:
        problems.append(f"audio present={out.has_audio}, input had audio={input_info.has_audio}")

    if out.fps != fps:
        problems.append(f"fps {out.fps} != input {fps}")
    if out.codec != "h264" or out.pix_fmt != "yuv420p":
        problems.append(f"output must be h264/yuv420p (got {out.codec}/{out.pix_fmt})")

    if problems:
        raise VerifyFailed(problems)
    return out


def output_meta(out: ProbeInfo) -> dict[str, Any]:
    """outputMeta for POST /complete (contract: OutputMeta)."""
    return {
        "width": out.width,
        "height": out.height,
        "frames": out.frames,
        "fps": float(out.fps),
        "durationSec": out.duration,
        "hasAudio": out.has_audio,
        "sizeBytes": out.size_bytes,
    }
