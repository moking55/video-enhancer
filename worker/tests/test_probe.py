from __future__ import annotations

from dataclasses import replace
from fractions import Fraction

import pytest

from enhancer_worker.errors import InputUnsupported
from enhancer_worker.presets import Preset
from enhancer_worker.probe import check_input_limits, is_cfr, parse_probe, probe_file

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
    # avg far from r AND frame count (217) inconsistent with duration * r (300).
    info = replace(good(clips), fps=Fraction(30), avg_fps=Fraction(25), frames=217, duration=10.0)
    with pytest.raises(InputUnsupported, match="variable frame rate"):
        check_input_limits(info, PRESET)


def _probe(r: str, avg: str | None, frames: int, duration: float):
    video = {"codec_type": "video", "codec_name": "h264", "width": 1280, "height": 720,
             "pix_fmt": "yuv420p", "r_frame_rate": r, "nb_frames": str(frames)}
    if avg is not None:
        video["avg_frame_rate"] = avg
    data = {"streams": [video],
            "format": {"duration": str(duration), "size": "1000",
                       "format_name": "mov,mp4,m4a,3gp,3g2,mj2"}}
    return parse_probe(data)


def test_is_cfr_reported_phone_clip_is_cfr():
    # 190 frames over 7.58 s at 25 fps; avg = frames / stream duration.
    info = _probe("25/1", "19000/758", frames=190, duration=7.58)
    assert info.avg_fps == Fraction(19000, 758)
    assert is_cfr(info)
    check_input_limits(info, PRESET)  # no raise


def test_is_cfr_ntsc_rational_is_cfr():
    info = _probe("30000/1001", "2997/100", frames=60, duration=2.0)
    assert is_cfr(info)


def test_is_cfr_obvious_vfr_is_vfr():
    info = _probe("30/1", "2170/100", frames=217, duration=10.0)
    assert not is_cfr(info)
    with pytest.raises(InputUnsupported, match="variable frame rate"):
        check_input_limits(info, PRESET)


def test_is_cfr_missing_avg_falls_back_to_frames_check():
    assert is_cfr(_probe("25/1", None, frames=190, duration=7.58))
    assert is_cfr(_probe("25/1", "0/0", frames=190, duration=7.58))
    # Avg missing and frame count clearly inconsistent with duration * r: VFR.
    assert not is_cfr(_probe("30/1", "0/0", frames=100, duration=10.0))


def test_is_cfr_missing_everything_is_cfr():
    assert is_cfr(_probe("25/1", "0/0", frames=0, duration=0.0))


def test_summary_includes_avg_fps():
    info = _probe("25/1", "19000/758", frames=190, duration=7.58)
    assert info.to_summary()["avgFps"] == "9500/379"  # Fraction reduces 19000/758


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


def test_vfr_clip_is_not_cfr(clips):
    info = probe_file(clips["vfr"])
    assert not is_cfr(info), (info.fps, info.avg_fps, info.frames, info.duration)
    with pytest.raises(InputUnsupported, match="variable frame rate"):
        check_input_limits(info, PRESET)
    check_input_limits(info, PRESET, allow_vfr=True)  # caller normalizes


@pytest.mark.parametrize("avg, expected", [
    (Fraction(235, 10), Fraction(24000, 1001)),
    (Fraction(24), Fraction(24)),
    (Fraction(25), Fraction(25)),
    (Fraction(299, 10), Fraction(30000, 1001)),
    (Fraction(30), Fraction(30)),
    (Fraction(48), Fraction(30)),
    (Fraction(599, 10), Fraction(30)),
    (Fraction(0), Fraction(30)),
])
def test_cfr_target_fps(avg, expected):
    from enhancer_worker.media import cfr_target_fps
    assert cfr_target_fps(avg) == expected
