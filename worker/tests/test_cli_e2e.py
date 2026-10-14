from __future__ import annotations

import re
import threading
import time

import pytest

from enhancer_worker import cli, media
from enhancer_worker.api import ApiClient
from enhancer_worker.heartbeat import Cancelled, Heartbeat, LeaseLost
from enhancer_worker.probe import is_cfr, probe_file
from fake_api import TOKEN, FakeApi

MOCK_PRESET = {"id": "mock-x2", "model": "mock", "scale": 2, "params": {}}


@pytest.fixture
def api():
    a = FakeApi().start()
    yield a
    a.stop()


def run_cli(api, tmp_path, *extra):
    return cli.main(["run", "--api", api.base_url, "--token", TOKEN, "--runner", "mock",
                     "--work-dir", str(tmp_path / "work"), *extra])


def test_e2e_success(api, clips, tmp_path, capsys, monkeypatch):
    job_id = api.add_job(clips["small"], MOCK_PRESET)
    assert run_cli(api, tmp_path) == 0
    out = capsys.readouterr().out
    assert "queue empty" in out
    assert re.search(rf"job {job_id}: 60 frames in [0-9.]+s \([0-9.]+ s/frame, device=cpu\)", out)
    assert "sig=" not in out and TOKEN not in out

    assert api.jobs[job_id]["state"] == "SUCCEEDED", api.endpoints("fail")
    meta = api.endpoints("complete")[0]["outputMeta"]
    uploaded = tmp_path / "uploaded.mp4"
    uploaded.write_bytes(api.uploads[f"{job_id}.mp4"])
    assert meta["sizeBytes"] == uploaded.stat().st_size
    assert (meta["width"], meta["height"], meta["frames"], meta["fps"], meta["hasAudio"]) == (1280, 720, 60, 30.0, True)

    src = probe_file(clips["small"])
    got = media.verify_output(src, uploaded, 2)
    assert media.output_meta(got) == meta

    beats = api.endpoints("heartbeat")
    stages = [b["stage"] for b in beats]
    for s in ("download", "probe", "enhance", "encode", "verify", "upload"):
        assert s in stages
    # the counter never lags once the frames are done: encode/verify/upload carry processed == total
    for b in beats:
        if b["stage"] in ("encode", "verify", "upload"):
            assert b["processedFrames"] == b["totalFrames"] == 60
    # progress never goes backwards in the order the server received it
    seen = [b["processedFrames"] for b in beats if "processedFrames" in b]
    assert seen == sorted(seen)
    # the last heartbeat before complete is the 100% one
    order = [e for (e, _, _) in api.calls if e in ("heartbeat", "complete")]
    assert order[-1] == "complete"
    assert api.endpoints("heartbeat")[-1]["processedFrames"] == 60
    probes = [b["probe"] for b in beats if "probe" in b]
    assert len(probes) == 1 and probes[0]["frames"] == 60
    assert not (tmp_path / "work" / job_id).exists()  # cleaned up
    assert api.endpoints("fail") == []


def test_e2e_vfr_is_normalized_to_cfr(api, clips, tmp_path, capsys):
    src = probe_file(clips["vfr"])
    assert not is_cfr(src)
    job_id = api.add_job(clips["vfr"], MOCK_PRESET)
    assert run_cli(api, tmp_path) == 0
    out = capsys.readouterr().out
    assert f"job {job_id}: normalized VFR" in out and "-> CFR" in out

    assert api.jobs[job_id]["state"] == "SUCCEEDED", api.endpoints("fail")
    target = media.cfr_target_fps(src.avg_fps)
    meta = api.endpoints("complete")[0]["outputMeta"]
    assert meta["fps"] == float(target) and meta["hasAudio"] is True
    probes = [b["probe"] for b in api.endpoints("heartbeat") if "probe" in b]
    assert len(probes) == 1
    assert probes[0]["normalized"] == {"fromAvgFps": float(src.avg_fps), "toFps": float(target)}

    uploaded = tmp_path / "uploaded.mp4"
    uploaded.write_bytes(api.uploads[f"{job_id}.mp4"])
    out_info = probe_file(uploaded, force_count=True)
    assert out_info.fps == target and is_cfr(out_info)
    # Output frames = duration x target (frames duplicated/dropped), verified against the normalized input.
    assert abs(out_info.frames - src.duration * float(target)) <= 3
    assert not (tmp_path / "work" / job_id).exists()


def test_e2e_processes_queue_and_respects_max_jobs(api, clips, tmp_path, capsys):
    ids = [api.add_job(clips["small"], MOCK_PRESET) for _ in range(2)]
    assert run_cli(api, tmp_path, "--max-jobs", "1") == 0
    assert [api.jobs[i]["state"] for i in ids] == ["SUCCEEDED", "QUEUED"]
    assert run_cli(api, tmp_path) == 0
    assert all(api.jobs[i]["state"] == "SUCCEEDED" for i in ids)


def test_e2e_input_unsupported_skips_processing(api, clips, tmp_path):
    preset = {**MOCK_PRESET, "params": {"maxInput": {"width": 320, "height": 180}}}
    job_id = api.add_job(clips["small"], preset)
    assert run_cli(api, tmp_path) == 0
    fail = api.endpoints("fail")[0]
    assert fail["code"] == "INPUT_UNSUPPORTED" and "resolution" in fail["message"]
    assert api.jobs[job_id]["state"] == "FAILED"
    assert api.endpoints("output-url") == []
    assert "enhance" not in [b["stage"] for b in api.endpoints("heartbeat")]
    assert len([b for b in api.endpoints("heartbeat") if "probe" in b]) == 1  # probe still reported


def test_e2e_cancel(api, clips, tmp_path):
    api.cancel_on_heartbeat = True
    job_id = api.add_job(clips["small"], MOCK_PRESET)
    assert run_cli(api, tmp_path) == 0
    assert api.endpoints("fail")[0]["code"] == "CANCELLED"
    assert api.jobs[job_id]["state"] == "CANCELLED"
    assert api.endpoints("complete") == []


def test_e2e_stale_attempt_is_silent(api, clips, tmp_path):
    api.stale_on_heartbeat = True
    api.add_job(clips["small"], MOCK_PRESET)
    assert run_cli(api, tmp_path) == 0
    assert api.endpoints("fail") == [] and api.endpoints("complete") == []


def test_e2e_complete_409_cancelled_is_done(api, clips, tmp_path):
    api.complete_status = (409, {"error": {"code": "CANCELLED", "message": "c"}})
    api.add_job(clips["small"], MOCK_PRESET)
    assert run_cli(api, tmp_path) == 0
    assert len(api.endpoints("complete")) == 1 and api.endpoints("fail") == []


def test_e2e_complete_output_missing_reports_fail(api, clips, tmp_path):
    api.complete_status = (409, {"error": {"code": "OUTPUT_MISSING", "message": "gone"}})
    api.add_job(clips["small"], MOCK_PRESET)
    assert run_cli(api, tmp_path) == 0
    assert api.endpoints("fail")[0]["code"] == "INTERNAL"


def test_bad_token_exits_nonzero(api, tmp_path, capsys):
    rc = cli.main(["run", "--api", api.base_url, "--token", "wrong", "--runner", "mock",
                   "--work-dir", str(tmp_path)])
    assert rc == 1
    assert "wrong" not in capsys.readouterr().out


def test_heartbeat_flags():
    class Fake:
        def __init__(self):
            self.cancel = False
            self.n = 0

        def heartbeat(self, *a):
            self.n += 1
            return self.cancel

    f = Fake()
    hb = Heartbeat(f, "j", "a", interval=0.05)
    hb.start()
    try:
        hb.set_stage("enhance")
        hb.set_progress(3, 10)
        hb.check()
        f.cancel = True
        hb.beat()
        with pytest.raises(Cancelled):
            hb.check()
        hb.lost = True
        with pytest.raises(LeaseLost):
            hb.check()
    finally:
        hb.stop()
    assert f.n >= 2


class _Rec:
    def __init__(self):
        self.calls = []
        self.lock = threading.Lock()

    def heartbeat(self, job_id, attempt_id, stage, processed=None, total=None, probe=None):
        with self.lock:
            self.calls.append((stage, processed, total))
        return False


def test_heartbeat_sends_immediately_on_stage_change():
    rec = _Rec()
    hb = Heartbeat(rec, "j", "a", interval=3600)  # the timer never fires in this test
    with hb:
        for st in ("download", "probe", "enhance", "encode", "verify", "upload"):
            hb.set_stage(st)
    assert [c[0] for c in rec.calls[:6]] == ["download", "probe", "enhance", "encode", "verify", "upload"]


def test_heartbeat_progress_is_throttled_and_flushed_at_100_percent():
    rec = _Rec()
    now = [0.0]
    hb = Heartbeat(rec, "j", "a", interval=3600, progress_interval=3.0, clock=lambda: now[0])
    with hb:
        hb.set_stage("enhance")
        hb.set_progress(1, 200)  # too soon: not woken
        time.sleep(0.2)
        assert len(rec.calls) == 1
        now[0] = 3.5
        hb.set_progress(50, 200)  # due -> thread sends without waiting for the 1 h timer
        deadline = time.time() + 5
        while len(rec.calls) < 2 and time.time() < deadline:
            time.sleep(0.01)
        assert rec.calls[-1] == ("enhance", 50, 200)
        hb.set_progress(200, 200)  # 100% is always sent right away
        while len(rec.calls) < 3 and time.time() < deadline:
            time.sleep(0.01)
        assert rec.calls[-1] == ("enhance", 200, 200)


def test_heartbeat_progress_never_decreases_and_survives_stage_change():
    rec = _Rec()
    hb = Heartbeat(rec, "j", "a", interval=3600)
    hb.set_stage("enhance")
    hb.set_progress(120, 200)
    hb.set_progress(100, 200)  # late/out-of-order callback
    hb.beat()
    assert rec.calls[-1] == ("enhance", 120, 200)
    hb.set_stage("encode")  # keeps the counter instead of dropping it
    assert rec.calls[-1] == ("encode", 120, 200)
    hb.set_progress(200, 200)
    hb.set_stage("upload")
    assert rec.calls[-1] == ("upload", 200, 200)


def test_heartbeat_stop_flush_joins_thread_then_sends_last_state():
    rec = _Rec()
    hb = Heartbeat(rec, "j", "a", interval=3600).start()
    hb.set_stage("enhance")
    hb.set_progress(10, 10)
    hb.stop(flush=True)
    assert hb._thread is not None and not hb._thread.is_alive()
    assert rec.calls[-1] == ("enhance", 10, 10)


def test_heartbeat_sends_are_serialised_and_never_stale():
    sent: list[int | None] = []
    active = [0]
    overlap = [False]

    class Slow:
        def heartbeat(self, job_id, attempt_id, stage, processed=None, total=None, probe=None):
            active[0] += 1
            if active[0] > 1:
                overlap[0] = True
            time.sleep(0.02)
            sent.append(processed)
            active[0] -= 1
            return False

    hb = Heartbeat(Slow(), "j", "a", interval=0.01)
    hb.start()
    hb.set_stage("enhance")
    for i in range(1, 30):
        hb.set_progress(i, 30)
        hb.beat()
    hb.stop(flush=True)
    assert not overlap[0]
    nums = [x for x in sent if x is not None]
    assert nums == sorted(nums) and nums[-1] == 29
