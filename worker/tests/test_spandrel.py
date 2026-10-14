"""Spandrel engine without torch / spandrel: pure helpers (precision, size padding, tile grid), loader wiring with
fake `torch` and `spandrel` modules injected through sys.modules, preset -> engine dispatch, CPU preset filter, setup.

The two numerical tests at the bottom (tiled output == whole-frame output) need a real torch and are skipped
when it is not installed (it is not a test dependency; run them in an environment that has torch)."""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

from conftest import make_clip
from enhancer_worker import cli, media, setup_colab
from enhancer_worker.errors import WorkerError
from enhancer_worker.presets import Preset
from enhancer_worker.probe import probe_file
from enhancer_worker.runners import get_runner
from enhancer_worker.runners import realesrgan as rr
from enhancer_worker.runners import spandrel_engine as se
from enhancer_worker.runners.realesrgan import AutoRunner, InferConfig, ModelSpec, RealEsrganRunner
from test_realesrgan import FakeEngine, H, W, live_pipeline_threads, nn2

SPAN_X2 = rr.SPANDREL_MODELS["span-fast-x2"]
PLKSR_X4 = rr.SPANDREL_MODELS["plksr-quality-x4"]


# --- pure helpers -------------------------------------------------------------------------------

def test_use_half_only_on_cuda_when_supported():
    assert se.use_half("cuda", True) is True
    assert se.use_half("cuda", False) is False  # RealPLKSR: spandrel says no fp16
    assert se.use_half("cpu", True) is False


@pytest.mark.parametrize("args,expected", [
    ((17, 33), (17, 33)),  # no requirement
    ((17, 33, 0, 8), (24, 40)),  # multiple_of
    ((20, 20, 32), (32, 32)),  # minimum
    ((20, 50, 32), (32, 50)),
    ((20, 50, 0, 1, True), (50, 50)),  # square
    ((20, 50, 32, 16, True), (64, 64)),  # all three
    ((32, 32, 32, 16, True), (32, 32)),  # already fine
])
def test_padded_size(args, expected):
    assert se.padded_size(*args) == expected


def _check_plan(h, w, tile, overlap):
    tiles = se.plan_tiles(h, w, tile, overlap)
    covered = [[0] * w for _ in range(h)]
    eff_overlap = max(0, min(overlap, tile // 4))
    for t in tiles:
        assert 0 <= t.ey0 <= t.y0 < t.y1 <= t.ey1 <= h and 0 <= t.ex0 <= t.x0 < t.x1 <= t.ex1 <= w
        assert t.ey1 - t.ey0 <= tile and t.ex1 - t.ex0 <= tile
        # context on each side: full overlap, or all the way to the image border
        assert t.y0 - t.ey0 == min(eff_overlap, t.y0) and t.ey1 - t.y1 == min(eff_overlap, h - t.y1)
        assert t.x0 - t.ex0 == min(eff_overlap, t.x0)
        assert t.ex1 - t.x1 == min(eff_overlap, w - t.x1)
        for y in range(t.y0, t.y1):
            for x in range(t.x0, t.x1):
                covered[y][x] += 1
    assert all(c == 1 for row in covered for c in row), "cores must partition the image exactly"
    return tiles


@pytest.mark.parametrize("h,w,tile,overlap", [
    (540, 960, 256, 16), (540, 960, 512, 16), (541, 961, 128, 16),  # odd sizes
    (1, 1, 64, 16), (7, 300, 64, 16), (360, 640, 0 + 1000, 16),  # tiny / tile larger than the frame
    (100, 100, 100, 16), (101, 100, 100, 16),  # frame == tile, one pixel over
    (64, 64, 8, 16), (50, 70, 3, 16),  # overlap clamped for tiny tiles
    (360, 640, 128, 0),
])
def test_plan_tiles_partition_and_context(h, w, tile, overlap):
    _check_plan(h, w, tile, overlap)


def test_plan_tiles_single_block_when_frame_fits():
    (t,) = se.plan_tiles(360, 640, 1000)
    assert (t.y0, t.y1, t.x0, t.x1) == (t.ey0, t.ey1, t.ex0, t.ex1) == (0, 360, 0, 640)


def test_plan_tiles_grid_shape_and_balance():
    tiles = se.plan_tiles(540, 960, 256, 16)  # core 224 -> 3 rows x 5 columns, near-equal cores
    assert len(tiles) == 15
    heights = {t.y1 - t.y0 for t in tiles}
    assert max(heights) - min(heights) <= 1 and max(heights) <= 224


@pytest.mark.parametrize("scale", [2, 4])
def test_tile_output_slices_cover_the_scaled_image(scale):
    h, w = 135, 241
    out = [[0] * (w * scale) for _ in range(h * scale)]
    for t in se.plan_tiles(h, w, 64):
        sy0, sy1, sx0, sx1 = t.src_crop(scale)
        dy0, dy1, dx0, dx1 = t.dst(scale)
        assert (sy1 - sy0, sx1 - sx0) == (dy1 - dy0, dx1 - dx0)  # what is cropped is what is written
        assert 0 <= sy0 and sy1 <= (t.ey1 - t.ey0) * scale and sx1 <= (t.ex1 - t.ex0) * scale
        for y in range(dy0, dy1):
            for x in range(dx0, dx1):
                out[y][x] += 1
    assert all(c == 1 for row in out for c in row)


# --- fake torch / spandrel ----------------------------------------------------------------------

class FakeT:
    """Shape-only stand-in for a BCHW tensor."""

    def __init__(self, shape, dtype="f32"):
        self.shape, self.dtype, self.writes, self.device = tuple(shape), dtype, [], "dev"

    def __getitem__(self, idx):
        shape = list(self.shape)
        for i, sl in enumerate(idx):
            if isinstance(sl, slice):
                shape[i] = len(range(*sl.indices(shape[i])))
        return FakeT(shape, self.dtype)

    def __setitem__(self, idx, value):
        self.writes.append((idx, value.shape))

    def contiguous(self):
        return self


class FakeDescriptor:
    def __init__(self, scale, supports_half, minimum=0, multiple_of=1, square=False):
        self.scale, self.supports_half = scale, supports_half
        self.size_requirements = types.SimpleNamespace(minimum=minimum, multiple_of=multiple_of, square=square)
        self.calls: list = []
        self.inputs: list = []
        self.net = None  # real torch tests: a callable to run instead of the shape-only stand-in

    def eval(self):
        self.calls.append("eval")
        return self

    def to(self, device):
        self.calls.append(("to", device))
        return self

    def half(self):
        self.calls.append("half")
        return self

    def float(self):
        self.calls.append("float")
        return self

    def __call__(self, x):
        if self.net is not None:
            return self.net(x)
        self.inputs.append(x.shape)
        b, c, h, w = x.shape
        return FakeT((b, c, h * self.scale, w * self.scale), x.dtype)


@pytest.fixture
def fakes(monkeypatch):
    """Inject fake `torch` and `spandrel`; returns a namespace to configure and inspect them."""
    state = types.SimpleNamespace(cuda=True, loaded=[], descriptor=None, cudnn=types.SimpleNamespace(benchmark=False),
                                  threads=[], pad_calls=[])

    def pad(x, p, mode="constant"):
        left, right, top, bottom = p
        state.pad_calls.append((mode, p))
        return FakeT((x.shape[0], x.shape[1], x.shape[2] + bottom, x.shape[3] + right), x.dtype)

    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: state.cuda, empty_cache=lambda: None)
    torch.backends = types.SimpleNamespace(cudnn=state.cudnn)
    torch.set_num_threads = state.threads.append
    torch.device = lambda d: ("device", d)
    torch.nn = types.SimpleNamespace(functional=types.SimpleNamespace(pad=pad))
    torch.empty = lambda shape, dtype=None, device=None: FakeT(shape, dtype)

    class ModelLoader:
        def load_from_file(self, path):
            state.loaded.append(path)
            return state.descriptor

    spandrel = types.ModuleType("spandrel")
    spandrel.ModelLoader = ModelLoader
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "spandrel", spandrel)
    return state


def make_engine(fakes, spec=SPAN_X2, device="cuda", **desc):
    fakes.descriptor = FakeDescriptor(spec.scale, **{"supports_half": True, **desc})
    return se.SpandrelEngine(spec, Path("w.safetensors"), device)


def test_loader_wiring_half_on_cuda_when_supported(fakes):
    e = make_engine(fakes)
    assert fakes.loaded == ["w.safetensors"]
    assert fakes.descriptor.calls == ["eval", ("to", ("device", "cuda")), "half"]
    assert e.half and e.precision == "fp16" and fakes.cudnn.benchmark is True


def test_loader_wiring_fp32_when_architecture_is_not_half_safe(fakes):
    e = make_engine(fakes, PLKSR_X4, supports_half=False)
    assert fakes.descriptor.calls == ["eval", ("to", ("device", "cuda")), "float"]
    assert not e.half and e.precision == "fp32"


def test_loader_wiring_cpu_is_fp32_even_if_half_is_supported(fakes):
    fakes.cuda = False  # a CPU engine must not need CUDA
    e = make_engine(fakes, device="cpu", supports_half=True)
    assert fakes.descriptor.calls == ["eval", ("to", ("device", "cpu")), "float"]
    assert e.precision == "fp32" and fakes.threads and fakes.cudnn.benchmark is False


def test_loader_rejects_missing_gpu_scale_mismatch_and_unknown_device(fakes):
    fakes.cuda = False
    fakes.descriptor = FakeDescriptor(2, True)
    with pytest.raises(WorkerError) as ei:
        se.SpandrelEngine(SPAN_X2, Path("w"), "cuda")
    assert ei.value.code == "NO_GPU"
    with pytest.raises(WorkerError, match="unknown device"):
        se.SpandrelEngine(SPAN_X2, Path("w"), "tpu")
    fakes.cuda = True
    fakes.descriptor = FakeDescriptor(4, True)  # file holds a 4x model but the preset says 2x
    with pytest.raises(WorkerError, match="scale"):
        se.SpandrelEngine(SPAN_X2, Path("w"), "cuda")


def test_forward_pads_to_size_requirements_and_crops_after(fakes):
    e = make_engine(fakes, minimum=32, multiple_of=16, square=False)
    y = e._forward(FakeT((1, 3, 20, 45)))
    assert fakes.descriptor.inputs == [(1, 3, 32, 48)]  # min 32 on h, 45 -> 48 on w
    assert fakes.pad_calls == [("reflect", (0, 3, 0, 12))]  # right/bottom only
    assert y.shape == (1, 3, 40, 90)  # cropped back to input * scale (x2), no padding left in the output


def test_forward_square_requirement_and_replicate_fallback_for_tiny_blocks(fakes):
    e = make_engine(fakes, square=True)
    e._forward(FakeT((1, 3, 10, 30)))
    assert fakes.descriptor.inputs[-1] == (1, 3, 30, 30)
    e._forward(FakeT((1, 3, 4, 30)))  # pad 26 >= height 4: reflect would raise, so replicate
    assert fakes.pad_calls[-1][0] == "replicate"


def test_forward_without_requirements_does_not_pad(fakes):
    e = make_engine(fakes)
    y = e._forward(FakeT((1, 3, 17, 33)))
    assert fakes.pad_calls == [] and fakes.descriptor.inputs == [(1, 3, 17, 33)] and y.shape == (1, 3, 34, 66)


@pytest.mark.parametrize("spec", [SPAN_X2, rr.SPANDREL_MODELS["span-balanced-x4"]])
def test_forward_tiled_writes_every_output_pixel_once_with_correct_shapes(fakes, spec):
    e = make_engine(fakes, spec, minimum=0)
    x = FakeT((1, 3, 135, 241))
    out = e._forward_tiled(x, 64)
    s = spec.scale
    assert out.shape == (1, 3, 135 * s, 241 * s)
    assert len(out.writes) == len(se.plan_tiles(135, 241, 64))
    for (_, _, ys, xs), shape in out.writes:
        assert shape[2:] == (ys.stop - ys.start, xs.stop - xs.start)  # source crop fits the destination slot
    assert max(i[2] for i in fakes.descriptor.inputs) <= 64 and max(i[3] for i in fakes.descriptor.inputs) <= 64


# --- preset -> engine dispatch ------------------------------------------------------------------

def test_spandrel_models_registry():
    assert {k: (m.weights, m.scale, m.engine) for k, m in rr.SPANDREL_MODELS.items()} == {
        "span-fast-x2": ("2xNomosUni_span_multijpg", 2, "spandrel"),
        "compact-anime-x2": ("2xHFA2kAVCCompact", 2, "spandrel"),
        "span-balanced-x4": ("4xNomosUni_span_multijpg", 4, "spandrel"),
        "plksr-quality-x4": ("4xNomosWebPhoto_RealPLKSR", 4, "spandrel"),
    }
    assert all(m.engine == "realesrgan" for m in rr.MODELS.values())
    assert list(rr.ALL_MODELS) == [*rr.MODELS, *rr.SPANDREL_MODELS]
    from enhancer_worker import weights

    for m in rr.ALL_MODELS.values():
        w = weights.WEIGHTS[m.weights]
        assert w.sha256 and (m.engine != "spandrel" or w.filename.endswith(".safetensors"))
        assert (w.url.startswith("https://huggingface.co/Phips/") and "/resolve/" in w.url) == (m.engine == "spandrel")


def test_default_factory_dispatches_by_engine(monkeypatch):
    built = []

    class Torch:
        def __init__(self, *a):
            built.append(("realesrgan", a))

    class Span:
        def __init__(self, *a):
            built.append(("spandrel", a))

    monkeypatch.setattr(rr, "TorchEngine", Torch)
    monkeypatch.setattr(se, "SpandrelEngine", Span)
    p = Path("p")
    assert isinstance(rr.default_engine_factory(rr.MODELS["realesrgan-x4"], p, "cuda"), Torch)
    assert isinstance(rr.default_engine_factory(rr.SPANDREL_MODELS["span-fast-x2"], p, "cpu"), Span)
    assert [b[0] for b in built] == ["realesrgan", "spandrel"] and built[1][1][2] == "cpu"
    with pytest.raises(WorkerError, match="unknown engine"):
        rr.default_engine_factory(ModelSpec("x", "y", 2, engine="onnx"), p, "cuda")


@pytest.fixture(scope="module")
def tiny(tmp_path_factory) -> Path:
    return make_clip(tmp_path_factory.mktemp("tiny") / "tiny.mp4", size=f"{W}x{H}", rate="30", seconds=1)


@pytest.fixture
def weights_stub(tmp_path, monkeypatch):
    monkeypatch.setattr(rr, "ensure_weights", lambda name, d, log=None: tmp_path / f"{name}.safetensors")


def claim(preset_id, scale):
    return Preset.from_claim({"id": preset_id, "model": "m", "scale": scale})


def test_auto_runner_builds_the_engine_each_preset_names(tmp_path, tiny, weights_stub):
    seen = []

    def factory(spec, path, device):
        seen.append((spec.engine, spec.weights, path.suffix, device))
        return FakeEngine(spec, path, device)

    runner = AutoRunner(tmp_path / "w", engine_factory=factory, device="cuda")
    info = probe_file(tiny)
    runner.process(tiny, tmp_path / "a.mp4", claim("span-fast-x2", 2), info, lambda p, t: None, lambda: None)
    runner.process(tiny, tmp_path / "b.mp4", claim("realesrgan-x2", 2), info, lambda p, t: None, lambda: None)
    out = media.verify_output(info, tmp_path / "a.mp4", 2)
    assert (out.width, out.height, out.frames) == (2 * W, 2 * H, 30)
    assert seen == [("spandrel", "2xNomosUni_span_multijpg", ".safetensors", "cuda"),
                    ("realesrgan", "RealESRGAN_x2plus", ".safetensors", "cuda")]
    assert live_pipeline_threads() == []


def test_runner_reports_engine_precision_in_last_config(tmp_path, tiny, weights_stub):
    class Eng(FakeEngine):
        precision = "fp32"

    runner = AutoRunner(tmp_path / "w", engine_factory=Eng, device="cuda")
    runner.process(tiny, tmp_path / "o.mp4", claim("span-fast-x2", 2), probe_file(tiny),
                   lambda p, t: None, lambda: None)
    assert runner.last_config["precision"] == "fp32"


def test_realesrgan_runner_stays_realesrgan_only(tmp_path, tiny):
    runner = RealEsrganRunner(tmp_path / "w", engine_factory=FakeEngine, device="cuda")
    assert set(runner.presets) == set(rr.MODELS)
    with pytest.raises(WorkerError, match="not supported by the realesrgan runner"):
        runner.process(tiny, tmp_path / "o.mp4", claim("span-fast-x2", 2), probe_file(tiny),
                       lambda p, t: None, lambda: None)


def test_auto_runner_scale_mismatch(tmp_path, tiny):
    runner = AutoRunner(tmp_path / "w", engine_factory=FakeEngine, device="cuda")
    with pytest.raises(WorkerError, match="native model scale"):
        runner.process(tiny, tmp_path / "o.mp4", claim("span-balanced-x4", 2), probe_file(tiny),
                       lambda p, t: None, lambda: None)


def test_cpu_auto_runner_runs_compact_anime_x2_and_rejects_the_rest(tmp_path, tiny, weights_stub):
    runner = AutoRunner(tmp_path / "w", engine_factory=FakeEngine, device="cpu")
    info = probe_file(tiny)
    runner.process(tiny, tmp_path / "o.mp4", claim("compact-anime-x2", 2), info, lambda p, t: None, lambda: None)
    assert media.verify_output(info, tmp_path / "o.mp4", 2).width == 2 * W
    assert runner.last_config == {"tile": 0, "batch": 1, "encoder": "libx264", "device": "cpu"}
    for pid, scale in [("span-fast-x2", 2), ("span-balanced-x4", 4), ("plksr-quality-x4", 4), ("realesrgan-x2", 2)]:
        with pytest.raises(WorkerError, match="not supported on cpu") as ei:
            runner.process(tiny, tmp_path / "x.mp4", claim(pid, scale), info, lambda p, t: None, lambda: None)
        assert ei.value.code == "UNSUPPORTED_DEVICE"


def test_cpu_preset_filter_is_the_same_set_the_web_marks_cpu_capable():
    assert AutoRunner(device="cpu").claim_presets() == ("realesrgan-anime-x4", "compact-anime-x2")
    assert set(AutoRunner(device="cuda").claim_presets()) == {
        "realesrgan-x2", "realesrgan-x4", "realesrgan-anime-x4", "realesrgan-fast-x4",
        "span-fast-x2", "compact-anime-x2", "span-balanced-x4", "plksr-quality-x4",
    }


def test_unverified_pickle_weights_are_refused(tmp_path, monkeypatch):
    from enhancer_worker import weights

    monkeypatch.setattr(rr, "ensure_weights", lambda name, d, log=None: tmp_path / "m.pth")
    runner = AutoRunner(tmp_path / "w", engine_factory=FakeEngine, device="cuda")
    pth = ModelSpec("2xNomosUni_span_multijpg", "span", 2, engine="spandrel")
    unpinned = weights.WeightSpec("2xNomosUni_span_multijpg", "m.pth", "https://x/m.pth", None)
    monkeypatch.setattr(rr, "WEIGHTS", {"2xNomosUni_span_multijpg": unpinned})
    with pytest.raises(WorkerError, match="unverified pickle"):
        runner._engine(pth)
    # a pinned .pth (hash verified by ensure_weights) and any .safetensors are fine
    pinned = weights.WeightSpec("2xNomosUni_span_multijpg", "m.pth", "https://x/m.pth", "0" * 64)
    monkeypatch.setattr(rr, "WEIGHTS", {pinned.name: pinned})
    assert runner._engine(pth) is not None


# --- cli / runner registry / presets ------------------------------------------------------------

def test_get_runner_auto_needs_no_torch(tmp_path):
    r = get_runner("auto", str(tmp_path))
    assert r.name == "auto" and set(r.presets) == set(rr.ALL_MODELS)


def test_cli_auto_runs_both_setups_lazily(monkeypatch, tmp_path):
    calls, captured = [], {}
    monkeypatch.setattr(setup_colab, "ensure_realesrgan", lambda *a, **k: calls.append("realesrgan"))
    monkeypatch.setattr(setup_colab, "ensure_spandrel", lambda *a, **k: calls.append("spandrel"))
    monkeypatch.setattr(cli, "run_queue", lambda api, runner, wd, mj: captured.update(runner=runner) or 0)
    base = ["run", "--api", "http://x", "--token", "t", "--work-dir", str(tmp_path / "w")]
    assert cli.main([*base, "--runner", "realesrgan"]) == 0
    assert calls == ["realesrgan"]  # legacy runner: no spandrel install
    calls.clear()
    assert cli.main([*base, "--runner", "auto", "--device", "cpu"]) == 0
    assert calls == ["realesrgan", "spandrel"] and captured["runner"].name == "auto"


def test_cli_spandrel_setup_failure_exits_2(monkeypatch, capsys):
    def boom():
        raise RuntimeError("pip failed at https://x.example/?sig=1")

    monkeypatch.setattr(setup_colab, "ensure_realesrgan", lambda *a, **k: None)
    monkeypatch.setattr(setup_colab, "ensure_spandrel", boom)
    assert cli.main(["run", "--api", "http://x", "--token", "t", "--runner", "auto"]) == 2
    err = capsys.readouterr().err
    assert "spandrel setup failed" in err and "sig=" not in err


def test_default_max_input_per_preset():
    for pid, size in [("span-fast-x2", (1920, 1080)), ("compact-anime-x2", (1920, 1080)),
                      ("span-balanced-x4", (960, 540)), ("plksr-quality-x4", (960, 540))]:
        p = Preset.from_claim({"id": pid, "model": "m", "scale": 2})
        assert (p.max_width, p.max_height) == size


# --- setup_colab.ensure_spandrel -----------------------------------------------------------------

class SetupSpy:
    def __init__(self, monkeypatch, missing=(), installed=False, pip_fail_first=False):
        self.pips, self.missing, self.installed, self.fail = [], set(missing), installed, pip_fail_first
        real = setup_colab.importlib.util.find_spec
        monkeypatch.setattr(setup_colab.importlib.util, "find_spec",
                            lambda m, *a: None if m in self.missing else real("os"))
        monkeypatch.setattr(setup_colab, "_spandrel_installed", lambda: self.installed)
        monkeypatch.setattr(setup_colab, "_pip", self._pip)
        monkeypatch.setattr(setup_colab, "_sh", lambda cmd, **k: types.SimpleNamespace(
            returncode=0, stdout="spandrel 0.4.2", stderr=""))

    def _pip(self, *args, check=True):
        self.pips.append(args)
        rc = 1 if (self.fail and any(a.startswith("spandrel==") for a in args) and len(self.pips) == 1) else 0
        return types.SimpleNamespace(returncode=rc, stdout="", stderr="")


def test_ensure_spandrel_installs_pinned_no_deps_and_only_missing_light_deps(monkeypatch):
    spy = SetupSpy(monkeypatch, missing={"einops"})
    assert setup_colab.ensure_spandrel() == setup_colab.SPANDREL_VERSION == "0.4.2"
    assert spy.pips == [("einops",), ("--no-deps", "spandrel==0.4.2")]
    flat = [a for p in spy.pips for a in p]
    assert not {"torch", "torchvision", "numpy"} & set(flat)  # never touches the Colab torch stack


def test_ensure_spandrel_is_idempotent(monkeypatch):
    spy = SetupSpy(monkeypatch, installed=True)
    setup_colab.ensure_spandrel()
    assert spy.pips == []


def test_ensure_spandrel_refuses_without_colab_torch_and_retries_with_new_pip(monkeypatch):
    SetupSpy(monkeypatch, missing={"torch"})
    with pytest.raises(RuntimeError, match="torch"):
        setup_colab.ensure_spandrel()
    spy = SetupSpy(monkeypatch, pip_fail_first=True)
    setup_colab.ensure_spandrel()
    assert spy.pips == [("--no-deps", "spandrel==0.4.2"), ("-U", "pip"), ("--no-deps", "spandrel==0.4.2")]


# --- numerical checks with a real torch (skipped in the project venv) ---------------------------

def _real_engine(monkeypatch, scale, minimum=0, multiple_of=1, square=False):
    torch = pytest.importorskip("torch")
    nn = torch.nn
    torch.manual_seed(0)

    class Net(nn.Module):
        """Two 5x5 convs (receptive radius 4) + pixel shuffle, standing in for a small SR network."""

        def __init__(self):
            super().__init__()
            self.c1, self.c2 = nn.Conv2d(3, 8, 5, padding=2), nn.Conv2d(8, 3 * scale * scale, 5, padding=2)
            self.up = nn.PixelShuffle(scale)

        def forward(self, x):
            h, w = x.shape[-2:]
            assert min(h, w) >= minimum and h % multiple_of == 0 and w % multiple_of == 0, f"bad size {(h, w)}"
            assert not square or h == w, f"not square {(h, w)}"
            return self.up(self.c2(torch.relu(self.c1(x))))

    descriptor = FakeDescriptor(scale, False, minimum, multiple_of, square)
    descriptor.net = Net().eval()
    spandrel = types.ModuleType("spandrel")
    spandrel.ModelLoader = lambda: types.SimpleNamespace(load_from_file=lambda p: descriptor)
    monkeypatch.setitem(sys.modules, "spandrel", spandrel)
    spec = ModelSpec("m", "span", scale, engine="spandrel")
    return se.SpandrelEngine(spec, Path("w"), "cpu"), torch


@pytest.mark.parametrize("scale,h,w,tile", [(2, 61, 83, 32), (4, 40, 57, 24), (2, 33, 33, 128), (2, 90, 20, 40)])
def test_tiled_equals_whole_frame_real_torch(monkeypatch, scale, h, w, tile):
    e, torch = _real_engine(monkeypatch, scale)
    x = torch.rand(1, 3, h, w)
    with torch.inference_mode():
        whole, tiled = e._forward(x), e._forward_tiled(x, tile)
    assert whole.shape == tiled.shape == (1, 3, h * scale, w * scale)
    assert torch.allclose(whole, tiled, atol=1e-5)  # context >= receptive radius: no seams


def test_size_requirements_are_met_for_whole_frames_and_every_tile_real_torch(monkeypatch):
    e, torch = _real_engine(monkeypatch, 2, minimum=32, multiple_of=8, square=True)  # the net asserts on bad sizes
    x = torch.rand(1, 3, 45, 77)
    with torch.inference_mode():
        assert e._forward(x).shape == (1, 3, 90, 154)
        assert e._forward_tiled(x, 40).shape == (1, 3, 90, 154)


def test_run_real_torch_whole_vs_tiled_and_batching(monkeypatch):
    np = pytest.importorskip("numpy")
    e, _ = _real_engine(monkeypatch, 2)
    h, w = 22, 30
    e.set_size(w, h)
    frame = np.random.default_rng(1).integers(0, 256, (h, w, 3), dtype=np.uint8).tobytes()
    (a,) = e.run(InferConfig(0, 1), [frame])
    (b,) = e.run(InferConfig(16, 1), [frame])
    assert len(a) == 2 * h * 2 * w * 3 and a == b
    assert len(e.run(InferConfig(0, 4), [frame] * 3)) == 3
    with pytest.raises(ValueError, match="one frame"):
        e.run(InferConfig(16, 2), [frame] * 2)
