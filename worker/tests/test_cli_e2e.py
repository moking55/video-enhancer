from __future__ import annotations

import pytest

from enhancer_worker import cli, media
from enhancer_worker.api import ApiClient
from enhancer_worker.heartbeat import Cancelled, Heartbeat, LeaseLost
from enhancer_worker.probe import probe_file
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
    for s in ("download", "probe", "enhance", "encode", "upload"):
        assert s in stages
    probes = [b["probe"] for b in beats if "probe" in b]
    assert len(probes) == 1 and probes[0]["frames"] == 60
    assert not (tmp_path / "work" / job_id).exists()  # cleaned up
    assert api.endpoints("fail") == []


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
