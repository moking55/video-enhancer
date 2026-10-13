from __future__ import annotations

import subprocess

import pytest

from conftest import ffmpeg
from enhancer_worker import media
from enhancer_worker.errors import VerifyFailed
from enhancer_worker.probe import probe_file
from enhancer_worker.runners.mock import MockRunner
from enhancer_worker.presets import Preset


def upscale(src, dst, scale, *, extra=()):
    ffmpeg("-i", str(src), "-map", "0:v:0", "-map", "0:a?", *media.passthrough_flags(),
           "-vf", f"scale=iw*{scale}:ih*{scale}:flags=lanczos", *media.x264_args(), "-c:a", "copy",
           *extra, str(dst))
    return dst


def test_verify_passes_on_good_output(clips, tmp_path):
    info = probe_file(clips["720p_audio"])
    out = upscale(clips["720p_audio"], tmp_path / "o.mp4", 2)
    res = media.verify_output(info, out, 2)
    assert (res.width, res.height, res.frames) == (2560, 1440, 60)
    meta = media.output_meta(res)
    assert meta["hasAudio"] is True and meta["sizeBytes"] == out.stat().st_size


def test_verify_passes_without_audio(clips, tmp_path):
    info = probe_file(clips["720p_noaudio"])
    out = upscale(clips["720p_noaudio"], tmp_path / "o.mp4", 2)
    assert not media.verify_output(info, out, 2).has_audio


def test_verify_fails_wrong_size(clips, tmp_path):
    info = probe_file(clips["small"])
    out = upscale(clips["small"], tmp_path / "o.mp4", 3)
    with pytest.raises(VerifyFailed, match="size"):
        media.verify_output(info, out, 2)


def test_verify_fails_missing_audio(clips, tmp_path):
    info = probe_file(clips["small"])
    out = upscale(clips["small"], tmp_path / "o.mp4", 2, extra=("-an",))
    with pytest.raises(VerifyFailed, match="audio"):
        media.verify_output(info, out, 2)


def test_verify_fails_unexpected_audio(clips, tmp_path):
    info = probe_file(clips["720p_noaudio"])
    out = tmp_path / "o.mp4"
    ffmpeg("-i", str(clips["720p_noaudio"]), "-f", "lavfi", "-i", "sine=frequency=440", "-map", "0:v:0",
           "-map", "1:a", "-vf", "scale=iw*2:ih*2", *media.x264_args(), "-c:a", "aac", "-t", "2", str(out))
    with pytest.raises(VerifyFailed, match="audio"):
        media.verify_output(info, out, 2)


def test_verify_fails_frame_count_and_duration(clips, tmp_path):
    info = probe_file(clips["small"])
    out = upscale(clips["small"], tmp_path / "o.mp4", 2, extra=("-frames:v", "50"))
    with pytest.raises(VerifyFailed) as ei:
        media.verify_output(info, out, 2)
    assert any("frame count" in p for p in ei.value.problems)


def test_verify_fails_odd_expected_size(clips, tmp_path):
    info = probe_file(clips["small"])
    out = upscale(clips["small"], tmp_path / "o.mp4", 2)
    from dataclasses import replace
    with pytest.raises(VerifyFailed, match="odd"):
        media.verify_output(replace(info, width=641), out, 1)


def test_mock_runner_progress_and_abort(clips, tmp_path):
    info = probe_file(clips["small"])
    preset = Preset.from_claim({"id": "mock-x2", "model": "mock", "scale": 2})
    seen = []
    MockRunner().process(clips["small"], tmp_path / "o.mp4", preset, info,
                         lambda p, t: seen.append((p, t)), lambda: None)
    assert seen[-1] == (60, 60)
    media.verify_output(info, tmp_path / "o.mp4", 2)

    class Stop(Exception):
        pass

    def abort():
        raise Stop()

    with pytest.raises(Stop):
        MockRunner().process(clips["small"], tmp_path / "o2.mp4", preset, info, lambda p, t: None, abort)


def _frames(path, vf):
    cmd = ["ffmpeg", "-v", "error", "-i", str(path), "-frames:v", "1", "-vf", vf,
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    return subprocess.run(cmd, capture_output=True, check=True).stdout


def test_colour_roundtrip_uses_bt709(tmp_path):
    """yuv(709) -> rgb -> yuv(709 tagged) must reproduce the same picture. A 601/709 mixup shifts
    saturated colours by >10 levels, a correct roundtrip stays within rounding error."""
    src = tmp_path / "src.mp4"
    ffmpeg("-f", "lavfi", "-i", "smptebars=size=320x240:rate=5", "-frames:v", "1", "-vf",
           "scale=out_color_matrix=bt709,format=yuv420p", *media.BT709_TAGS,
           "-c:v", "libx264", "-crf", "0", str(src))
    raw = subprocess.run(media.decode_cmd(src), capture_output=True, check=True).stdout
    assert len(raw) == 320 * 240 * 3
    from fractions import Fraction
    out = tmp_path / "out.mp4"
    subprocess.run(media.encode_cmd(out, 320, 240, Fraction(5)), input=raw, capture_output=True, check=True)
    ref = _frames(src, media.RGB_FROM_YUV_VF)
    got = _frames(out, media.RGB_FROM_YUV_VF)
    mad = sum(abs(a - b) for a, b in zip(ref, got)) / len(ref)
    assert mad < 2.0, mad
    info = probe_file(out)
    assert info.pix_fmt == "yuv420p"
    tags = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=color_space",
                           "-of", "default=nw=1:nk=1", str(out)], capture_output=True, text=True).stdout
    assert tags.strip() == "bt709"
