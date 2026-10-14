"""Real-ESRGAN runner logic without a GPU: pipeline orchestration with a pure-Python fake upscaler
(real ffmpeg decode/encode on tiny frames), OOM ladder, weights registry and download."""

from __future__ import annotations

import hashlib
import http.server
import subprocess
import threading
from pathlib import Path

import pytest

from conftest import make_clip
from enhancer_worker import cli, media, pipeline, weights
from enhancer_worker.errors import MediaError, WorkerError
from enhancer_worker.heartbeat import Cancelled
from enhancer_worker.presets import Preset
from enhancer_worker.probe import probe_file
from enhancer_worker.runners import get_runner
from enhancer_worker.runners import realesrgan as rr
from enhancer_worker.runners.realesrgan import (
    LADDER, AdaptiveUpscaler, AutoRunner, InferConfig, ModelSpec, RealEsrganRunner, is_oom,
)

W = H = 16
FRAME = W * H * 3


def nn2(frame: bytes, w: int = W, h: int = H) -> bytes:
    """Nearest-neighbour 2x on raw rgb24."""
    rows = []
    for y in range(h):
        row = frame[y * w * 3:(y + 1) * w * 3]
        dbl = b"".join(row[i:i + 3] * 2 for i in range(0, len(row), 3))
        rows += [dbl, dbl]
    return b"".join(rows)


@pytest.fixture(scope="module")
def tiny(tmp_path_factory) -> Path:
    return make_clip(tmp_path_factory.mktemp("tiny") / "tiny.mp4", size=f"{W}x{H}", rate="30", seconds=2)


def raw_encode_cmd(dst: Path) -> list[str]:
    """Lossless 'encoder': raw rgb24 in, raw rgb24 out, so output bytes can be compared exactly."""
    return ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{2 * W}x{2 * H}",
            "-framerate", "30", "-i", "-", "-f", "rawvideo", str(dst)]


def run_with_timeout(fn, timeout=60):
    box: dict = {}

    def target():
        try:
            box["value"] = fn()
        except BaseException as e:  # noqa: BLE001
            box["error"] = e

    t = threading.Thread(target=target, daemon=True)
    t.start()
    t.join(timeout)
    assert not t.is_alive(), "pipeline deadlocked"
    if "error" in box:
        raise box["error"]
    return box.get("value")


def pipe(tiny, out, **kw):
    args = dict(
        decode_cmd=media.decode_cmd(tiny), encode_cmd=raw_encode_cmd(out),
        in_frame_bytes=FRAME, out_frame_bytes=4 * FRAME,
        upscale=lambda frames: [nn2(f) for f in frames], batch_size=lambda: 3,
        on_progress=lambda n: None, check_abort=lambda: None,
    )
    args.update(kw)
    return run_with_timeout(lambda: pipeline.run_pipeline(**args))


def decoded_frames(tiny) -> list[bytes]:
    raw = subprocess.run(media.decode_cmd(tiny), capture_output=True, check=True).stdout
    return [raw[i:i + FRAME] for i in range(0, len(raw), FRAME)]


def live_pipeline_threads() -> list[str]:
    return [t.name for t in threading.enumerate() if t.name in ("decode", "encode") and t.is_alive()]


# --- pipeline ---------------------------------------------------------------------------------

def test_pipeline_order_batching_progress(tiny, tmp_path):
    expected = b"".join(nn2(f) for f in decoded_frames(tiny))
    assert len(expected) == 60 * 4 * FRAME
    batches, progress = [], []

    def up(frames):
        batches.append(len(frames))
        return [nn2(f) for f in frames]

    n = pipe(tiny, tmp_path / "o.raw", upscale=up, on_progress=progress.append)
    assert n == 60
    assert (tmp_path / "o.raw").read_bytes() == expected  # every frame, in order, none dropped
    assert sum(batches) == 60 and max(batches) <= 3 and all(b >= 1 for b in batches)
    assert progress == sorted(progress) and progress[-1] == 60
    assert live_pipeline_threads() == []


def test_pipeline_batch_size_is_re_read_each_iteration(tiny, tmp_path):
    sizes = iter([1, 1, 2, 2] + [4] * 100)
    batches = []

    def up(frames):
        batches.append(len(frames))
        return [nn2(f) for f in frames]

    pipe(tiny, tmp_path / "o.raw", upscale=up, batch_size=lambda: next(sizes))
    assert batches[:2] == [1, 1] and max(batches[2:4]) <= 2 and sum(batches) == 60


def test_pipeline_abort_kills_children_and_joins_threads(tiny, tmp_path, monkeypatch):
    procs = []
    real_popen = subprocess.Popen

    def popen(*a, **k):
        p = real_popen(*a, **k)
        procs.append(p)
        return p

    monkeypatch.setattr(pipeline.subprocess, "Popen", popen)
    calls = [0]

    def abort():
        calls[0] += 1
        if calls[0] == 3:
            raise Cancelled()

    with pytest.raises(Cancelled):
        pipe(tiny, tmp_path / "o.raw", check_abort=abort)
    assert len(procs) == 2 and all(p.poll() is not None for p in procs)
    assert live_pipeline_threads() == []


def test_pipeline_upscaler_exception_propagates(tiny, tmp_path):
    def up(frames):
        raise ValueError("boom")

    with pytest.raises(ValueError, match="boom"):
        pipe(tiny, tmp_path / "o.raw", upscale=up)
    assert live_pipeline_threads() == []


def test_pipeline_wrong_output_size_rejected(tiny, tmp_path):
    with pytest.raises(MediaError, match="wrong count or size"):
        pipe(tiny, tmp_path / "o.raw", upscale=lambda frames: frames)


def test_pipeline_decoder_failure_propagates(tmp_path):
    missing = tmp_path / "missing.mp4"
    with pytest.raises(MediaError, match="decode failed"):
        pipe(missing, tmp_path / "o.raw")
    assert live_pipeline_threads() == []


def test_pipeline_encoder_failure_propagates(tiny, tmp_path):
    bad = raw_encode_cmd(tmp_path / "o.raw")[:-1] + [str(tmp_path / "no-such-dir" / "o.raw")]
    with pytest.raises(MediaError, match="encode failed"):
        pipe(tiny, tmp_path / "o.raw", encode_cmd=bad)
    assert live_pipeline_threads() == []


# --- runner end to end with a fake engine ------------------------------------------------------

class FakeEngine:
    def __init__(self, spec: ModelSpec, path: Path, device: str = "cuda"):
        self.spec, self.path, self.calls, self.cleaned = spec, path, [], 0

    def set_size(self, w, h):
        self.w, self.h = w, h

    def cleanup(self):
        self.cleaned += 1

    def run(self, cfg, frames):
        self.calls.append((cfg, len(frames)))
        return [nn2(f, self.w, self.h) for f in frames]


@pytest.fixture
def runner(tmp_path, monkeypatch):
    monkeypatch.setattr(rr, "ensure_weights", lambda name, d, log=None: tmp_path / f"{name}.pth")
    return RealEsrganRunner(tmp_path / "w", engine_factory=FakeEngine, device="cuda")


def test_runner_end_to_end_verifies(runner, tiny, tmp_path):
    info = probe_file(tiny)
    preset = Preset.from_claim({"id": "realesrgan-x2", "model": "RealESRGAN_x2plus", "scale": 2})
    seen = []
    runner.process(tiny, tmp_path / "out.mp4", preset, info, lambda p, t: seen.append((p, t)), lambda: None)
    out = media.verify_output(info, tmp_path / "out.mp4", 2)
    assert (out.width, out.height, out.frames, out.has_audio) == (32, 32, 60, True)
    assert seen[-1] == (60, 60)
    assert runner.last_config["batch"] == 4 and runner.last_config["tile"] == 0
    assert runner.last_config["encoder"] in ("libx264", "h264_nvenc")
    assert not (tmp_path / "out.video.mp4").exists()
    assert live_pipeline_threads() == []


def test_runner_rejects_scale_mismatch_and_unknown_preset(runner, tiny, tmp_path):
    info = probe_file(tiny)
    with pytest.raises(WorkerError, match="native model scale"):
        runner.process(tiny, tmp_path / "o.mp4", Preset.from_claim({"id": "realesrgan-x2", "scale": 4}),
                       info, lambda p, t: None, lambda: None)
    with pytest.raises(WorkerError, match="not supported"):
        runner.process(tiny, tmp_path / "o.mp4", Preset.from_claim({"id": "mock-x2", "scale": 2}),
                       info, lambda p, t: None, lambda: None)


def test_models_per_preset():
    assert rr.MODELS["realesrgan-x2"] == ModelSpec("RealESRGAN_x2plus", "rrdb", 2)
    assert rr.MODELS["realesrgan-x4"] == ModelSpec("RealESRGAN_x4plus", "rrdb", 4)
    assert rr.MODELS["realesrgan-anime-x4"] == ModelSpec("realesr-animevideov3", "srvgg", 4)
    assert rr.MODELS["realesrgan-fast-x4"] == ModelSpec("realesr-general-x4v3", "srvgg", 4, num_conv=32)
    assert rr.MODELS["realesrgan-anime-x4"].num_conv == 16
    assert set(rr.MODELS) == set(RealEsrganRunner.presets)
    assert all(m.weights in weights.WEIGHTS for m in rr.MODELS.values())


# --- OOM ladder / auto tile selection ----------------------------------------------------------

class CudaOOM(RuntimeError):
    pass


CudaOOM.__name__ = "OutOfMemoryError"  # torch.cuda.OutOfMemoryError, matched by name


def make_run(oom_if, log):
    def run(cfg, frames):
        log.append((cfg, len(frames)))
        if oom_if(cfg, len(frames)):
            raise CudaOOM("CUDA out of memory. Tried to allocate 2.00 GiB")
        return [f + b"!" for f in frames]

    return run


def test_ladder_order():
    assert [(c.tile, c.batch) for c in LADDER] == [(0, 4), (0, 2), (0, 1), (512, 1), (256, 1), (128, 1)]


@pytest.mark.parametrize("oom_if,expected", [
    (lambda c, n: False, (0, 4)),
    (lambda c, n: c.tile == 0 and c.batch > 1, (0, 1)),
    (lambda c, n: c.tile == 0, (512, 1)),
    (lambda c, n: c.tile in (0, 512), (256, 1)),
    (lambda c, n: c.tile != 128, (128, 1)),
])
def test_select_picks_first_config_that_fits(oom_if, expected):
    cleaned = []
    up = AdaptiveUpscaler(make_run(oom_if, []), cleanup=lambda: cleaned.append(1))
    cfg = up.select(b"x")
    assert (cfg.tile, cfg.batch) == expected
    assert up.batch_size() == expected[1]
    assert len(cleaned) == LADDER.index(cfg)


def test_select_probes_with_full_batch():
    log = []
    AdaptiveUpscaler(make_run(lambda c, n: False, log)).select(b"x")
    assert log == [(InferConfig(0, 4), 4)]


def test_select_exhausted_raises_oom_code():
    up = AdaptiveUpscaler(make_run(lambda c, n: True, []))
    with pytest.raises(WorkerError) as ei:
        up.select(b"x")
    assert ei.value.code == "OOM"


def test_non_oom_error_is_not_swallowed():
    def run(cfg, frames):
        raise RuntimeError("CUDA error: device-side assert triggered")

    with pytest.raises(RuntimeError, match="device-side"):
        AdaptiveUpscaler(run).select(b"x")


def test_mid_job_oom_steps_down_and_retries_chunk_in_order():
    log = []
    state = {"fail_once": True}

    def oom_if(cfg, n):
        if cfg == InferConfig(0, 4) and state["fail_once"] and len(log) >= 3:
            state["fail_once"] = False
            return True
        return False

    up = AdaptiveUpscaler(make_run(oom_if, log))
    assert up.select(b"x") == InferConfig(0, 4)
    frames = [bytes([i]) for i in range(8)]
    out = up(frames)
    assert out == [f + b"!" for f in frames]  # order preserved, nothing dropped or duplicated
    assert up.config == InferConfig(0, 2)  # stepped down once and stayed there


def test_is_oom_detection():
    assert is_oom(CudaOOM("x"))
    assert is_oom(RuntimeError("CUDA error: out of memory"))
    assert is_oom(RuntimeError("CUBLAS_STATUS_ALLOC_FAILED when calling cublasCreate"))
    wrapped = rr.ModelForwardError("wrapped")
    wrapped.__cause__ = RuntimeError("CUDA out of memory")
    assert is_oom(wrapped)
    assert not is_oom(ValueError("bad shape"))
    assert not is_oom(None)


def test_adaptive_upscaler_through_the_pipeline(tiny, tmp_path):
    """OOM at batch 4 mid-stream: pipeline output is still complete and ordered."""
    state = {"calls": 0}

    def run(cfg, frames):
        state["calls"] += 1
        if cfg.batch > 2 and state["calls"] > 3:
            raise CudaOOM("out of memory")
        return [nn2(f) for f in frames]

    up = AdaptiveUpscaler(run, ladder=(InferConfig(0, 4), InferConfig(0, 2)))
    expected = b"".join(nn2(f) for f in decoded_frames(tiny))
    pipe(tiny, tmp_path / "o.raw", upscale=up, batch_size=up.batch_size)
    assert (tmp_path / "o.raw").read_bytes() == expected
    assert up.config == InferConfig(0, 2)


# --- encoder selection / media args ------------------------------------------------------------

def test_nvenc_args_and_encode_cmd_uses_codec_args():
    a = media.nvenc_args()
    assert a[:8] == ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "19"]
    assert "-b:v" in a and "yuv420p" in a and "bt709" in a
    from fractions import Fraction
    cmd = media.encode_cmd("o.mp4", 32, 32, Fraction(30), codec_args=a)
    assert "h264_nvenc" in cmd and "libx264" not in cmd
    assert "libx264" in media.encode_cmd("o.mp4", 32, 32, Fraction(30))
    assert isinstance(media.nvenc_available(), bool)


# --- weights -----------------------------------------------------------------------------------

def test_registry_contents():
    realesrgan = {"RealESRGAN_x4plus", "RealESRGAN_x2plus", "realesr-animevideov3", "realesr-general-x4v3"}
    spandrel = {"2xNomosUni_span_multijpg", "2xHFA2kAVCCompact", "4xNomosUni_span_multijpg",
                "4xNomosWebPhoto_RealPLKSR"}
    assert set(weights.WEIGHTS) == realesrgan | spandrel
    for name in realesrgan:
        spec = weights.WEIGHTS[name]
        assert spec.url.startswith("https://github.com/xinntao/Real-ESRGAN/releases/download/")
        assert spec.url.endswith(spec.filename)
    for spec in weights.WEIGHTS.values():
        assert spec.url.endswith(spec.filename)
        assert spec.sha256 is not None and len(spec.sha256) == 64  # every weight file is pinned
    assert "/v0.2.1/" in weights.WEIGHTS["RealESRGAN_x2plus"].url
    general = weights.WEIGHTS["realesr-general-x4v3"]
    assert "/v0.2.5.0/" in general.url and general.size_bytes == 4885111
    assert general.sha256 is not None and len(general.sha256) == 64


class _Server:
    def __init__(self, files: dict[str, bytes]):
        self.hits = 0
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                data = files.get(self.path)
                if data is None:
                    self.send_error(404)
                    return
                outer.hits += 1
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


DATA = b"weights-bytes" * 1000


@pytest.fixture
def server():
    s = _Server({"/m.pth": DATA})
    yield s
    s.close()


def spec_for(server, sha):
    return {"m": weights.WeightSpec("m", "m.pth", server.url + "/m.pth", sha)}


def test_download_atomic_cached_and_hash_checked(server, tmp_path):
    reg = spec_for(server, hashlib.sha256(DATA).hexdigest())
    logs = []
    p = weights.ensure_weights("m", tmp_path / "cache", registry=reg, log=logs.append)
    assert p.read_bytes() == DATA and list(p.parent.glob("*.part")) == []
    assert weights.ensure_weights("m", tmp_path / "cache", registry=reg, log=logs.append) == p
    assert server.hits == 1  # second call served from cache
    p.write_bytes(b"corrupt")  # corrupted cache entry is replaced
    weights.ensure_weights("m", tmp_path / "cache", registry=reg, log=logs.append)
    assert p.read_bytes() == DATA and server.hits == 2


def test_hash_mismatch_raises_and_leaves_nothing(server, tmp_path):
    reg = spec_for(server, "0" * 64)
    with pytest.raises(weights.WeightsError, match="SHA-256 mismatch"):
        weights.ensure_weights("m", tmp_path / "cache", registry=reg, log=lambda m: None)
    assert list((tmp_path / "cache").iterdir()) == []


def test_unpinned_hash_is_computed_and_logged(server, tmp_path):
    logs = []
    p = weights.ensure_weights("m", tmp_path, registry=spec_for(server, None), log=logs.append)
    assert p.exists()
    assert any(hashlib.sha256(DATA).hexdigest() in m for m in logs)


def test_download_http_error_and_unknown_name(server, tmp_path):
    reg = {"m": weights.WeightSpec("m", "m.pth", server.url + "/missing.pth")}
    with pytest.raises(weights.WeightsError) as ei:
        weights.ensure_weights("m", tmp_path, registry=reg, log=lambda m: None)
    assert "127.0.0.1" not in str(ei.value)  # URLs are never echoed
    assert list(tmp_path.iterdir()) == []
    with pytest.raises(weights.WeightsError, match="unknown"):
        weights.ensure_weights("nope", tmp_path)


# --- cli wiring --------------------------------------------------------------------------------

def test_get_runner_realesrgan_needs_no_torch(tmp_path):
    r = get_runner("realesrgan", str(tmp_path))
    assert r.name == "realesrgan" and r.weights_dir == tmp_path
    assert set(r.presets) == {"realesrgan-x2", "realesrgan-x4", "realesrgan-anime-x4", "realesrgan-fast-x4"}


def test_cli_realesrgan_runs_setup_lazily_and_passes_weights_dir(monkeypatch, tmp_path):
    from enhancer_worker import setup_colab

    called, captured = [], {}
    monkeypatch.setattr(setup_colab, "ensure_realesrgan", lambda *a, **k: called.append(1))
    monkeypatch.setattr(cli, "run_queue", lambda api, runner, wd, mj: captured.update(runner=runner) or 0)
    base = ["run", "--api", "http://x", "--token", "t", "--work-dir", str(tmp_path / "w")]
    assert cli.main([*base, "--runner", "mock"]) == 0
    assert called == []  # the mock runner never triggers the Colab install
    assert cli.main([*base, "--runner", "realesrgan", "--weights-dir", str(tmp_path / "wd")]) == 0
    assert called == [1] and captured["runner"].weights_dir == tmp_path / "wd"
    assert cli.build_parser().parse_args(["run"]).weights_dir.endswith("enhancer-weights")


def test_cli_setup_failure_exits_2(monkeypatch, capsys):
    from enhancer_worker import setup_colab

    def boom():
        raise RuntimeError("no network at https://x.example/secret?sig=1")

    monkeypatch.setattr(setup_colab, "ensure_realesrgan", boom)
    rc = cli.main(["run", "--api", "http://x", "--token", "t", "--runner", "realesrgan"])
    assert rc == 2
    err = capsys.readouterr().err
    assert "setup failed" in err and "sig=" not in err


# --- CPU fallback (Anime 4x only) --------------------------------------------------------------

ANIME = {"id": "realesrgan-anime-x4", "model": "realesr-animevideov3", "scale": 4, "params": {}}


class FakeEngine4(FakeEngine):
    """4x nearest neighbour; records the device it was built for."""

    def __init__(self, spec, path, device="cuda"):
        super().__init__(spec, path)
        self.device = device

    def run(self, cfg, frames):
        self.calls.append((cfg, len(frames)))
        return [nn2(nn2(f, self.w, self.h), 2 * self.w, 2 * self.h) for f in frames]


def test_resolve_device(monkeypatch):
    monkeypatch.setattr(rr, "cuda_available", lambda: True)
    assert rr.resolve_device("auto") == "cuda"
    monkeypatch.setattr(rr, "cuda_available", lambda: False)
    assert rr.resolve_device("auto") == "cpu"
    assert rr.resolve_device("cuda") == "cuda" and rr.resolve_device("cpu") == "cpu"  # explicit wins
    with pytest.raises(ValueError, match="device"):
        rr.resolve_device("tpu")


def test_supported_presets_per_device():
    assert rr.CPU_PRESETS == ("realesrgan-anime-x4", "compact-anime-x2")
    assert set(rr.CPU_PRESETS) <= set(rr.ALL_MODELS)
    # `--runner realesrgan` keeps serving only its own four presets: on CPU just Anime 4x
    assert rr.supported_presets("cpu") == ("realesrgan-anime-x4",)
    assert set(rr.supported_presets("cuda")) == set(rr.MODELS)
    assert RealEsrganRunner(device="cpu").claim_presets() == ("realesrgan-anime-x4",)
    assert set(RealEsrganRunner(device="cuda").claim_presets()) == set(rr.MODELS)
    # `--runner auto`: cuda -> every preset, cpu -> the two anime presets
    assert rr.supported_presets("cpu", rr.ALL_MODELS) == rr.CPU_PRESETS
    assert AutoRunner(device="cpu").claim_presets() == rr.CPU_PRESETS
    assert set(AutoRunner(device="cuda").claim_presets()) == set(rr.ALL_MODELS) and len(rr.ALL_MODELS) == 8


def test_runner_auto_device(monkeypatch):
    monkeypatch.setattr(rr, "cuda_available", lambda: False)
    assert RealEsrganRunner().device == "cpu"
    monkeypatch.setattr(rr, "cuda_available", lambda: True)
    assert RealEsrganRunner().device == "cuda"


def test_cpu_runner_end_to_end_anime(tiny, tmp_path, monkeypatch):
    monkeypatch.setattr(rr, "ensure_weights", lambda name, d, log=None: tmp_path / f"{name}.pth")
    monkeypatch.setattr(media, "nvenc_available", lambda *a, **k: pytest.fail("nvenc must not be probed on CPU"))
    runner = RealEsrganRunner(tmp_path / "w", engine_factory=FakeEngine4, device="cpu")
    info = probe_file(tiny)
    runner.process(tiny, tmp_path / "out.mp4", Preset.from_claim(ANIME), info, lambda p, t: None, lambda: None)
    out = media.verify_output(info, tmp_path / "out.mp4", 4)
    assert (out.width, out.height, out.frames) == (4 * W, 4 * H, 60)
    engine = runner._engines["realesr-animevideov3"]
    assert engine.device == "cpu"  # the factory got the device
    assert runner.last_config == {"tile": 0, "batch": 1, "encoder": "libx264", "device": "cpu"}
    assert {n for _, n in engine.calls} == {1}  # CPU never batches
    assert live_pipeline_threads() == []


@pytest.mark.parametrize("preset_id,scale", [("realesrgan-x2", 2), ("realesrgan-x4", 4), ("realesrgan-fast-x4", 4)])
def test_cpu_runner_rejects_non_cpu_presets(tmp_path, tiny, preset_id, scale):
    runner = RealEsrganRunner(tmp_path / "w", engine_factory=FakeEngine4, device="cpu")
    with pytest.raises(WorkerError, match="not supported on cpu") as ei:
        runner.process(tiny, tmp_path / "o.mp4", Preset.from_claim({"id": preset_id, "scale": scale}),
                       probe_file(tiny), lambda p, t: None, lambda: None)
    assert ei.value.code == "UNSUPPORTED_DEVICE"
    assert runner._engines == {}  # rejected before any model/weights work


def test_is_oom_detects_host_memory_errors():
    assert is_oom(MemoryError())
    assert is_oom(RuntimeError("[enforce fail at alloc_cpu.cpp] DefaultCPUAllocator: not enough memory: "
                               "you tried to allocate 1073741824 bytes"))
    assert is_oom(RuntimeError("DefaultCPUAllocator: can't allocate memory"))
    wrapped = rr.ModelForwardError("wrapped")
    wrapped.__cause__ = MemoryError()
    assert is_oom(wrapped)
    assert not is_oom(RuntimeError("shape mismatch"))


def test_cpu_ladder_starts_at_whole_frame_batch_1():
    assert [(c.tile, c.batch) for c in rr.CPU_LADDER] == [(0, 1), (512, 1), (256, 1), (128, 1)]


def test_cpu_ladder_drops_to_tiles_on_memory_error():
    log, cleaned = [], []

    def run(cfg, frames):
        log.append(cfg)
        if cfg.tile == 0:
            raise MemoryError()
        return [f + b"!" for f in frames]

    up = AdaptiveUpscaler(run, ladder=rr.CPU_LADDER, cleanup=lambda: cleaned.append(1))
    assert up.select(b"x") == InferConfig(512, 1)
    assert up([b"a", b"b"]) == [b"a!", b"b!"] and cleaned == [1]
    assert all(c.batch == 1 for c in log)


def test_cpu_ladder_exhausted_reports_oom():
    def run(cfg, frames):
        raise MemoryError()

    with pytest.raises(WorkerError) as ei:
        AdaptiveUpscaler(run, ladder=rr.CPU_LADDER).select(b"x")
    assert ei.value.code == "OOM"


def test_cli_device_flag(monkeypatch, tmp_path):
    from enhancer_worker import setup_colab

    monkeypatch.setattr(setup_colab, "ensure_realesrgan", lambda *a, **k: None)
    captured = []
    monkeypatch.setattr(cli, "run_queue", lambda api, runner, wd, mj: captured.append(runner) or 0)
    base = ["run", "--api", "http://x", "--token", "t", "--work-dir", str(tmp_path / "w"), "--runner", "realesrgan"]
    assert cli.build_parser().parse_args(["run"]).device == "auto"
    monkeypatch.setattr(rr, "cuda_available", lambda: False)
    for extra in ([], ["--device", "cuda"], ["--device", "cpu"]):
        assert cli.main([*base, *extra]) == 0
    assert [r.device for r in captured] == ["cpu", "cuda", "cpu"]
    with pytest.raises(SystemExit):
        cli.main([*base, "--device", "tpu"])


def test_run_queue_cpu_claims_only_cpu_presets_and_sends_no_gpu(tmp_path, capsys, monkeypatch):
    from enhancer_worker.api import ApiClient
    from fake_api import TOKEN, FakeApi

    monkeypatch.setattr(cli, "detect_gpu", lambda: pytest.fail("no GPU probing on CPU"))
    api = FakeApi().start()
    try:
        runner = RealEsrganRunner(tmp_path / "w", engine_factory=FakeEngine4, device="cpu")
        assert cli.run_queue(ApiClient(api.base_url, TOKEN), runner, tmp_path / "work") == 0
        assert api.endpoints("claim") == [{"presets": ["realesrgan-anime-x4"]}]  # no "gpu" key
    finally:
        api.stop()
    out = capsys.readouterr().out
    assert "device: cpu (" in out and "only these presets will be claimed: realesrgan-anime-x4" in out


def test_run_queue_cuda_claims_all_and_sends_gpu(tmp_path, capsys, monkeypatch):
    from enhancer_worker.api import ApiClient
    from fake_api import TOKEN, FakeApi

    monkeypatch.setattr(cli, "detect_gpu", lambda: {"name": "Tesla T4", "vramMb": 15360})
    api = FakeApi().start()
    try:
        runner = RealEsrganRunner(tmp_path / "w", engine_factory=FakeEngine4, device="cuda")
        assert cli.run_queue(ApiClient(api.base_url, TOKEN), runner, tmp_path / "work") == 0
        body = api.endpoints("claim")[0]
        assert set(body["presets"]) == set(rr.MODELS)
        assert body["gpu"] == {"name": "Tesla T4", "vramMb": 15360}
    finally:
        api.stop()
    assert "device: cuda (Tesla T4)" in capsys.readouterr().out
