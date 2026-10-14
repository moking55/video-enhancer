"""Spandrel engine: runs any architecture spandrel can load (SPAN, Compact, RealPLKSR, ...) behind the same
`set_size / run(cfg, frames) / cleanup` interface as TorchEngine, so AdaptiveUpscaler and run_pipeline are reused.

torch, numpy and spandrel are imported lazily (setup_colab.ensure_spandrel installs spandrel on Colab); the pure
helpers below (precision choice, size padding, tile grid) need none of them and are unit tested directly.

Spandrel has no tiler, so tiling is implemented here: the frame is cut into non-overlapping *core* blocks, each core
is run with `overlap` pixels of real image context on every side that has neighbours (input space), and only the
core of each result is written. Because the context is cropped away (not blended) there is exactly one writer per
output pixel and no seams from averaging; model edge effects stay inside the discarded margin.
"""

from __future__ import annotations

import gc
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..errors import WorkerError
from .realesrgan import InferConfig, ModelSpec

TILE_OVERLAP = 16  # input pixels of context on each side of a tile core


def use_half(device: str, supports_half: bool) -> bool:
    """fp16 only on CUDA and only when spandrel says the architecture is fp16 safe (RealPLKSR: no)."""
    return device == "cuda" and bool(supports_half)


def padded_size(h: int, w: int, minimum: int = 0, multiple_of: int = 1, square: bool = False) -> tuple[int, int]:
    """Smallest (h, w) >= the input that satisfies spandrel's `size_requirements`."""
    multiple_of = max(int(multiple_of), 1)

    def up(v: int) -> int:
        v = max(v, int(minimum))
        return -(-v // multiple_of) * multiple_of

    ph, pw = up(h), up(w)
    if square:
        ph = pw = max(ph, pw)
    return ph, pw


@dataclass(frozen=True)
class Tile:
    """Core block [y0:y1, x0:x1] of the input and the context-extended block [ey0:ey1, ex0:ex1] fed to the model."""

    y0: int
    y1: int
    x0: int
    x1: int
    ey0: int
    ey1: int
    ex0: int
    ex1: int

    def src_crop(self, scale: int) -> tuple[int, int, int, int]:
        """(y0, y1, x0, x1) of the core inside the model output of the extended block."""
        return ((self.y0 - self.ey0) * scale, (self.y1 - self.ey0) * scale,
                (self.x0 - self.ex0) * scale, (self.x1 - self.ex0) * scale)

    def dst(self, scale: int) -> tuple[int, int, int, int]:
        """(y0, y1, x0, x1) of the core in the full output image."""
        return self.y0 * scale, self.y1 * scale, self.x0 * scale, self.x1 * scale


def _bounds(size: int, tile: int, core: int) -> list[int]:
    """Cut [0, size) into near-equal cores of at most `core`; one block when the whole axis fits in `tile`."""
    if size <= tile:
        return [0, size]
    n = -(-size // core)
    return [i * size // n for i in range(n + 1)]


def plan_tiles(h: int, w: int, tile: int, overlap: int = TILE_OVERLAP) -> list[Tile]:
    """Tile grid for an h x w input. Cores partition the image exactly; every extended block is at most
    `tile` x `tile` and carries `min(overlap, distance to the border)` pixels of context per side."""
    if h < 1 or w < 1 or tile < 1:
        raise ValueError("h, w and tile must be positive")
    overlap = max(0, min(overlap, tile // 4))
    core = tile - 2 * overlap
    ys, xs = _bounds(h, tile, core), _bounds(w, tile, core)
    return [
        Tile(y0, y1, x0, x1, max(0, y0 - overlap), min(h, y1 + overlap), max(0, x0 - overlap), min(w, x1 + overlap))
        for y0, y1 in zip(ys, ys[1:])
        for x0, x1 in zip(xs, xs[1:])
    ]


class SpandrelEngine:
    """Spandrel model on CUDA (fp16 when the architecture supports it) or CPU (fp32)."""

    def __init__(self, spec: ModelSpec, weights_path: Path, device: str = "cuda"):
        import torch
        import spandrel

        if device not in ("cuda", "cpu"):
            raise WorkerError(f"unknown device {device!r}")
        if device == "cuda" and not torch.cuda.is_available():
            raise WorkerError("no CUDA GPU available", code="NO_GPU")
        if device == "cuda":
            torch.backends.cudnn.benchmark = True  # fixed input size within a job (tiles: a handful of shapes)
        else:
            torch.set_num_threads(os.cpu_count() or 1)
        self.torch = torch
        self.spec = spec
        self.device = device

        # .safetensors loads without unpickling; a .pth reaches here only after ensure_weights verified its SHA-256
        model = spandrel.ModelLoader().load_from_file(str(weights_path))
        if getattr(model, "scale", spec.scale) != spec.scale:
            raise WorkerError(f"{spec.weights}: model scale {model.scale} != preset scale {spec.scale}")
        model.eval()
        model.to(torch.device(device))
        self.half = use_half(device, getattr(model, "supports_half", False))
        if self.half:
            model.half()
        else:
            model.float()
        self.precision = "fp16" if self.half else "fp32"
        self.model = model
        req = getattr(model, "size_requirements", None)
        self.size_req = (int(getattr(req, "minimum", 0)), int(getattr(req, "multiple_of", 1)),
                         bool(getattr(req, "square", False)))
        self.overlap = TILE_OVERLAP
        self.width = self.height = 0

    def set_size(self, width: int, height: int) -> None:
        self.width, self.height = width, height

    def cleanup(self) -> None:
        gc.collect()
        if self.device == "cuda":
            self.torch.cuda.empty_cache()

    def _forward(self, x: Any) -> Any:
        """Model on one BCHW block, honouring size_requirements (reflect pad, crop after)."""
        F = self.torch.nn.functional
        h, w = x.shape[-2:]
        th, tw = padded_size(h, w, *self.size_req)
        if (th, tw) != (h, w):
            ph, pw = th - h, tw - w
            # reflect needs pad < dimension; replicate for tiny blocks
            mode = "reflect" if ph < h and pw < w else "replicate"
            x = F.pad(x, (0, pw, 0, ph), mode=mode)
        y = self.model(x)
        s = self.spec.scale
        return y[:, :, : h * s, : w * s]

    def _forward_tiled(self, x: Any, tile: int) -> Any:
        s = self.spec.scale
        h, w = x.shape[-2:]
        out = None
        for t in plan_tiles(h, w, tile, self.overlap):
            y = self._forward(x[:, :, t.ey0 : t.ey1, t.ex0 : t.ex1].contiguous())
            if out is None:
                out = self.torch.empty((1, y.shape[1], h * s, w * s), dtype=y.dtype, device=y.device)
            sy0, sy1, sx0, sx1 = t.src_crop(s)
            dy0, dy1, dx0, dx1 = t.dst(s)
            out[:, :, dy0:dy1, dx0:dx1] = y[:, :, sy0:sy1, sx0:sx1]
        return out

    def run(self, cfg: InferConfig, frames: list[bytes]) -> list[bytes]:
        import numpy as np

        torch = self.torch
        n, h, w, s = len(frames), self.height, self.width, self.spec.scale
        host = np.empty((n, h, w, 3), np.uint8)
        for i, f in enumerate(frames):
            host[i] = np.frombuffer(f, np.uint8).reshape(h, w, 3)
        with torch.inference_mode():
            x = torch.from_numpy(host).to(self.device).permute(0, 3, 1, 2).contiguous()
            x = (x.half() if self.half else x.float()).div_(255)
            if cfg.tile > 0:
                if n != 1:
                    raise ValueError("tiled inference processes one frame at a time")
                y = self._forward_tiled(x, cfg.tile)
            else:
                y = self._forward(x)
            y = y.clamp_(0, 1)
            out = torch.empty((n, h * s, w * s, 3), dtype=torch.uint8, device=y.device)
            for i in range(n):  # per frame: keeps the float32 intermediate small
                out[i] = y[i].permute(1, 2, 0).float().mul_(255).round_().to(torch.uint8)
            res = out.cpu().numpy()
        return [res[i].tobytes() for i in range(n)]
