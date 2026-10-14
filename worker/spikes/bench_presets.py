"""Colab T4 benchmark of the 8 GPU presets (paste into a cell or `!python bench_presets.py`). Weights are loaded before timing."""
import gc, subprocess, sys, time
from pathlib import Path
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "git+https://github.com/moking55/video-enhancer@main#subdirectory=worker"], check=True)
import torch
from enhancer_worker import probe
from enhancer_worker.presets import Preset
from enhancer_worker.runners import get_runner
from enhancer_worker.runners.realesrgan import ALL_MODELS
from enhancer_worker.setup_colab import ensure_realesrgan, ensure_spandrel
ensure_realesrgan(); ensure_spandrel()
work = Path("/content/bench"); work.mkdir(exist_ok=True); clip = work / "in.mp4"
subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "5",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip)], check=True)
info, rows = probe.probe_file(clip), []
for pid, spec in ALL_MODELS.items():
    gc.collect(); torch.cuda.empty_cache()
    runner = get_runner("auto", "/content/weights", "cuda")
    runner._engine(spec)  # download + load outside the timed region
    torch.cuda.reset_peak_memory_stats(); t0 = time.time()
    preset = Preset.from_claim({"id": pid, "model": spec.weights, "scale": spec.scale})
    runner.process(clip, work / f"{pid}.mp4", preset, info, lambda n, t: None, lambda: None)
    rows.append((pid, (time.time() - t0) / info.frames, torch.cuda.max_memory_allocated() / 2**30, runner.last_config))
print(f"{'preset':20}{'s/frame':>9}{'peak GiB':>9}  effective config")
for pid, spf, gib, cfg in rows:
    print(f"{pid:20}{spf:9.3f}{gib:9.2f}  {cfg}")
