from __future__ import annotations

from dataclasses import replace
from fractions import Fraction

import pytest

from enhancer_worker.errors import InputUnsupported
from enhancer_worker.presets import Preset
from enhancer_worker.probe import check_input_limits, parse_probe, probe_file

PRESET = Preset.from_claim({"id": "mock-x2", "model": "mock", "scale": 2})


def test_probe_cfr_720p_audio(clips):
    info = probe_file(clips["720p_audio"])
    assert (info.width, info.height) == (1280, 720)
    assert info.fps == Fraction(30)
    assert info.frames == 60
    assert info.codec == "h264" and info.pix_fmt == "yuv420p"
    assert info.has_audio and info.audio_codec == "aac"
    assert info.rotation == 0
    assert 1.9 < info.duration < 2.2
    assert info.size_bytes > 0
    check_input_limits(info, PRESET)  # no raise
    summary = info.to_summary()
    assert summary["fpsRational"] == "30/1" and summary["hasAudio"] is True


def test_probe_no_audio(clips):
    info = probe_file(clips["720p_noaudio"])
    assert not info.has_audio and info.audio_codec is None
    check_input_limits(info, PRESET)


def test_probe_ntsc_rational_fps(clips):
    info = probe_file(clips["ntsc"])
    assert info.fps == Fraction(30000, 1001)
    assert info.frames == 60
    check_input_limits(info, PRESET)


def test_frames_counted_when_nb_frames_missing(clips):
    info = probe_file(clips["720p_audio"], force_count=True)
    assert info.frames == 60


def test_rotation_swaps_display_dims():
    data = {
        "streams": [{"codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080,
                     "r_frame_rate": "30/1", "avg_frame_rate": "30/1", "nb_frames": "10",
                     "side_data_list": [{"rotation": -90}]}],
        "format": {"duration": "1.0", "size": "1000", "format_name": "mov,mp4,m4a,3gp,3g2,mj2"},
    }
    info = parse_probe(data)
    assert info.rotation == 270 and (info.width, info.height) == (1080, 1920)


def good(clips):
    return probe_file(clips["720p_audio"])


def test_limit_too_long(clips):
    with pytest.raises(InputUnsupported, match="duration"):
        check_input_limits(replace(good(clips), duration=121.0), PRESET)


def test_limit_too_big_dimensions(clips):
    p = Preset.from_claim({"id": "realesrgan-x4", "model": "m", "scale": 4})  # 960x540
    with pytest.raises(InputUnsupported, match="resolution"):
        check_input_limits(good(clips), p)


def test_limit_params_from_claim_override_defaults(clips):
    p = Preset.from_claim({"id": "mock-x2", "model": "m", "scale": 2,
                           "params": {"maxInput": {"width": 640, "height": 360},
                                      "limits": {"maxDurationSec": 120, "maxSizeBytes": 1000}}})
    with pytest.raises(InputUnsupported) as ei:
        check_input_limits(good(clips), p)
    assert len(ei.value.reasons) == 2  # resolution + size


def test_limit_file_size(clips):
    with pytest.raises(InputUnsupported, match="file size"):
        check_input_limits(replace(good(clips), size_bytes=600 * 1024 * 1024), PRESET)


def test_limit_hevc(clips):
    info = probe_file(clips["hevc"])
    assert info.codec == "hevc"
    with pytest.raises(InputUnsupported, match="H.264"):
        check_input_limits(info, PRESET)


def test_limit_vfr_fake(clips):
    info = replace(good(clips), fps=Fraction(30), avg_fps=Fraction(25))
    with pytest.raises(InputUnsupported, match="variable frame rate"):
        check_input_limits(info, PRESET)


def test_limit_hdr_10bit_and_audio(clips):
    base = good(clips)
    with pytest.raises(InputUnsupported, match="HDR"):
        check_input_limits(replace(base, color_transfer="smpte2084"), PRESET)
    with pytest.raises(InputUnsupported, match="yuv420p"):
        check_input_limits(replace(base, pix_fmt="yuv420p10le"), PRESET)
    with pytest.raises(InputUnsupported, match="AAC"):
        check_input_limits(replace(base, audio_codec="mp3"), PRESET)
    with pytest.raises(InputUnsupported, match="MP4"):
        check_input_limits(replace(base, format_name="matroska,webm"), PRESET)
