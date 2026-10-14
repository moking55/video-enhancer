"""Real-ESRGAN runner (GPU, with a CPU fallback for Anime 4x). torch / basicsr / realesrgan / numpy are imported lazily inside
TorchEngine (Colab provides them), so this module imports and its logic tests run without them.

Performance design (SPEC "Runner performance"):
  * decode / GPU / encode run in three threads joined by bounded queues (enhancer_worker.pipeline)
  * with tile=0 the model is called directly on a fp16 batch (N x 3 x H x W) on the GPU
  * AdaptiveUpscaler walks a ladder (tile 0 batch 4/2/1, tile 512/256/128) at job start and again
    on any OOM during the job; RealESRGANer's tiling swallows OOM, so its forward is wrapped to raise
  * encoder: h264_nvenc when a feature test passes, else libx264 CRF 18
  * CPU fallback (device="cpu"): fp32, whole frame batch 1 (ladder: tile 0, 512, 256, 128), libx264,
    and only the presets in CPU_PRESETS are claimed (the rest stay QUEUED for a GPU session)
"""

from __future__ import annotations

import gc
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Sequence

from .. import media
from ..errors import WorkerError
from ..pipeline import run_pipeline
from ..presets import Preset
from ..probe import ProbeInfo
from ..weights import DEFAULT_CACHE_DIR, ensure_weights
from .base import AbortFn, ProgressFn


@dataclass(frozen=True)
class ModelSpec:
    weights: str  # key in weights.WEIGHTS
    arch: str  # "rrdb" | "srvgg"
    scale: int  # native scale == output scale (no resizing, no fallback to another model)
    num_conv: int = 16  # srvgg only: animevideov3 = 16, general-x4v3 = 32 (official inference scripts)


MODELS = {
    "realesrgan-x2": ModelSpec("RealESRGAN_x2plus", "rrdb", 2),
    "realesrgan-x4": ModelSpec("RealESRGAN_x4plus", "rrdb", 4),
    "realesrgan-anime-x4": ModelSpec("realesr-animevideov3", "srvgg", 4),
    "realesrgan-fast-x4": ModelSpec("realesr-general-x4v3", "srvgg", 4, num_conv=32),
}


@dataclass(frozen=True)
class InferConfig:
    tile: int  # 0 = whole frame
    batch: int  # frames per forward (always 1 when tiled)


# Fastest first. Tried in order; the first that does not OOM wins.
LADDER: tuple[InferConfig, ...] = (
    InferConfig(0, 4), InferConfig(0, 2), InferConfig(0, 1),
    InferConfig(512, 1), InferConfig(256, 1), InferConfig(128, 1),
)

# CPU: no tile-0 batching (RAM, and no parallelism to gain); tiles remain as the OOM escape hatch.
CPU_LADDER: tuple[InferConfig, ...] = LADDER[2:]

# Presets the CPU fallback may claim (one place, so more can be added once measured on Colab CPU).
CPU_PRESETS: tuple[str, ...] = ("realesrgan-anime-x4",)

_OOM_HINTS = ("out of memory", "alloc_failed", "not_enough_workspace", "not enough memory",
              "can't allocate memory")


def is_oom(exc: BaseException | None) -> bool:
    """CUDA or host out-of-memory, looking through the __cause__/__context__ chain."""
    depth = 0
    while exc is not None and depth < 8:
        if (type(exc).__name__ == "OutOfMemoryError" or isinstance(exc, MemoryError)
                or any(h in str(exc).lower() for h in _OOM_HINTS)):
            return True
        exc = exc.__cause__ or exc.__context__
        depth += 1
    return False


class AdaptiveUpscaler:
    """Wraps run(config, frames) -> frames and steps down the ladder when it hits OOM."""

    def __init__(
        self,
        run: Callable[[InferConfig, list[bytes]], list[bytes]],
        ladder: Sequence[InferConfig] = LADDER,
        cleanup: Callable[[], None] | None = None,
        log: Callable[[str], None] = lambda m: None,
    ):
        self._run = run
        self._ladder = tuple(ladder)
        self._cleanup = cleanup or (lambda: None)
        self._log = log
        self._i = 0

    @property
    def config(self) -> InferConfig:
        return self._ladder[self._i]

    def batch_size(self) -> int:
        return self.config.batch

    def _step_down(self, exc: BaseException) -> None:
        self._cleanup()
        if self._i + 1 >= len(self._ladder):
            raise WorkerError(
                f"out of memory even at tile {self.config.tile}: {str(exc)[:200]}", code="OOM"
            ) from exc
        self._i += 1
        self._log(f"OOM: falling back to tile={self.config.tile} batch={self.config.batch}")

    def select(self, sample: bytes) -> InferConfig:
        """Pick the first config that can process `sample` frames (job start)."""
        while True:
            cfg = self.config
            try:
                self._run(cfg, [sample] * cfg.batch)
                return cfg
            except Exception as e:  # noqa: BLE001
                if not is_oom(e):
                    raise
                self._step_down(e)

    def __call__(self, frames: list[bytes]) -> list[bytes]:
        out: list[bytes] = []
        i = 0
        while i < len(frames):
            cfg = self.config
            chunk = frames[i : i + cfg.batch]
            try:
                out.extend(self._run(cfg, chunk))
            except Exception as e:  # noqa: BLE001
                if not is_oom(e):
                    raise
                self._step_down(e)
                continue  # retry this chunk with the new config
            i += len(chunk)
        return out


class ModelForwardError(Exception):
    """Raised by the wrapped model.forward. Deliberately not a RuntimeError: RealESRGANer.tile_process
    catches RuntimeError (incl. CUDA OOM), prints it and carries on with a black tile."""


class TorchEngine:
    """Model + inference on CUDA (fp16) or CPU (fp32). Needs torch, basicsr and realesrgan (see setup_colab)."""

    def __init__(self, spec: ModelSpec, weights_path: Path, device: str = "cuda"):
        import torch
        from realesrgan import RealESRGANer

        if device not in ("cuda", "cpu"):
            raise WorkerError(f"unknown device {device!r}")
        if device == "cuda" and not torch.cuda.is_available():
            raise WorkerError("no CUDA GPU available", code="NO_GPU")
        if device == "cuda":
            torch.backends.cudnn.benchmark = True  # fixed input size within a job
        else:
            torch.set_num_threads(os.cpu_count() or 1)
        self.torch = torch
        self.spec = spec
        self.device = device
        self.half = device == "cuda"
        if spec.arch == "rrdb":
            from basicsr.archs.rrdbnet_arch import RRDBNet

            model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=spec.scale)
        else:
            from realesrgan.archs.srvgg_arch import SRVGGNetCompact

            model = SRVGGNetCompact(num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=spec.num_conv, upscale=spec.scale,
                                    act_type="prelu")
        self.up = RealESRGANer(scale=spec.scale, model_path=str(weights_path), model=model, tile=0, tile_pad=10,
                               pre_pad=0, half=self.half, device=torch.device(device))
        self.model = self.up.model
        orig_forward = self.model.forward

        def forward(*a: Any, **k: Any) -> Any:
            try:
                return orig_forward(*a, **k)
            except RuntimeError as e:
                raise ModelForwardError(str(e)) from e

        self.model.forward = forward
        # RRDBNet(scale=2) pixel-unshuffles its input: H and W must be even (scale 1: multiple of 4).
        self.mod = 2 if spec.arch == "rrdb" and spec.scale == 2 else 1
        self.width = self.height = 0

    def set_size(self, width: int, height: int) -> None:
        self.width, self.height = width, height

    def cleanup(self) -> None:
        gc.collect()
        if self.device == "cuda":
            self.torch.cuda.empty_cache()

    def run(self, cfg: InferConfig, frames: list[bytes]) -> list[bytes]:
        import numpy as np

        torch = self.torch
        n, h, w, s = len(frames), self.height, self.width, self.spec.scale
        host = np.empty((n, h, w, 3), np.uint8)
        for i, f in enumerate(frames):
            host[i] = np.frombuffer(f, np.uint8).reshape(h, w, 3)
        with torch.inference_mode():
            x = torch.from_numpy(host).to(self.device).permute(0, 3, 1, 2)
            x = (x.half() if self.half else x.float()).div_(255)
            ph, pw = (-h) % self.mod, (-w) % self.mod
            if ph or pw:
                x = torch.nn.functional.pad(x, (0, pw, 0, ph), mode="reflect")
            if cfg.tile > 0:
                if n != 1:
                    raise ValueError("tiled inference processes one frame at a time")
                self.up.tile_size = cfg.tile
                self.up.img = x
                self.up.tile_process()
                y = self.up.output
            else:
                y = self.model(x)
            y = y[:, :, : h * s, : w * s].clamp_(0, 1)
            out = torch.empty((n, h * s, w * s, 3), dtype=torch.uint8, device=y.device)
            for i in range(n):  # per frame: keeps the float32 intermediate small
                out[i] = y[i].permute(1, 2, 0).float().mul_(255).round_().to(torch.uint8)
            res = out.cpu().numpy()
        return [res[i].tobytes() for i in range(n)]


def _log(msg: str) -> None:
    print(msg, flush=True)


def cuda_available() -> bool:
    try:
        import torch
    except ImportError:
        return False
    return bool(torch.cuda.is_available())


def resolve_device(device: str = "auto") -> str:
    """"auto" -> "cuda" if torch sees a GPU, else "cpu". "cuda" / "cpu" are taken as given."""
    if device == "auto":
        return "cuda" if cuda_available() else "cpu"
    if device not in ("cuda", "cpu"):
        raise ValueError(f"device must be auto, cuda or cpu, got {device!r}")
    return device


def supported_presets(device: str) -> tuple[str, ...]:
    """Preset ids this runner can run on `device` (what it sends as the claim filter)."""
    return CPU_PRESETS if device == "cpu" else tuple(MODELS)


class RealEsrganRunner:
    name = "realesrgan"
    presets = tuple(MODELS)  # every preset the runner knows; see supported_presets for one device

    def __init__(self, weights_dir: str | Path | None = None,
                 engine_factory: Callable[..., Any] = TorchEngine, device: str = "auto"):
        self.weights_dir = Path(weights_dir) if weights_dir else DEFAULT_CACHE_DIR
        self._engine_factory = engine_factory
        self.device = resolve_device(device)
        self._engines: dict[str, Any] = {}
        self.last_config: dict[str, Any] | None = None  # effective config of the last job

    def supported_presets(self, device: str | None = None) -> tuple[str, ...]:
        return supported_presets(device or self.device)

    def claim_presets(self) -> tuple[str, ...]:
        """What to send as the claim `presets` filter for the resolved device."""
        return self.supported_presets()

    def _engine(self, spec: ModelSpec) -> Any:
        if spec.weights not in self._engines:
            path = ensure_weights(spec.weights, self.weights_dir, log=_log)
            self._engines[spec.weights] = self._engine_factory(spec, path, self.device)
        return self._engines[spec.weights]

    def process(
        self,
        input_path: Path,
        output_path: Path,
        preset: Preset,
        info: ProbeInfo,
        on_progress: ProgressFn,
        check_abort: AbortFn,
    ) -> None:
        spec = MODELS.get(preset.id)
        if spec is None:
            raise WorkerError(f"preset {preset.id!r} is not supported by the realesrgan runner")
        if preset.scale != spec.scale:
            raise WorkerError(f"preset scale {preset.scale} != native model scale {spec.scale}")

        if preset.id not in self.supported_presets():
            raise WorkerError(
                f"preset {preset.id!r} is not supported on {self.device} (the CPU fallback runs only "
                f"{', '.join(CPU_PRESETS)}); it needs a GPU session",
                code="UNSUPPORTED_DEVICE",
            )

        engine = self._engine(spec)
        check_abort()
        engine.set_size(info.width, info.height)
        upscaler = AdaptiveUpscaler(engine.run, ladder=CPU_LADDER if self.device == "cpu" else LADDER,
                                    cleanup=engine.cleanup, log=_log)
        cfg = upscaler.select(bytes(info.width * info.height * 3))
        nvenc = self.device == "cuda" and media.nvenc_available()
        codec_args = media.nvenc_args() if nvenc else media.x264_args()
        encoder = "h264_nvenc" if nvenc else "libx264"
        self.last_config = {"tile": cfg.tile, "batch": cfg.batch, "encoder": encoder, "device": self.device}
        _log(f"realesrgan {preset.id}: device={self.device} tile={cfg.tile} batch={cfg.batch} encoder={encoder}")

        ow, oh = media.expected_size(info, spec.scale)
        video_only = output_path.with_suffix(".video.mp4")
        try:
            frames = run_pipeline(
                decode_cmd=media.decode_cmd(input_path),
                encode_cmd=media.encode_cmd(video_only, ow, oh, info.fps, codec_args=codec_args),
                in_frame_bytes=info.width * info.height * 3,
                out_frame_bytes=ow * oh * 3,
                upscale=upscaler,
                batch_size=upscaler.batch_size,
                on_progress=lambda n: on_progress(n, info.frames),
                check_abort=check_abort,
            )
            final = upscaler.config
            if final != cfg:
                self.last_config.update(tile=final.tile, batch=final.batch)
                _log(f"effective config changed during the job: tile={final.tile} batch={final.batch}")
            check_abort()
            media.run(media.mux_cmd(video_only, input_path, output_path))
        finally:
            video_only.unlink(missing_ok=True)
        on_progress(frames, info.frames)
