"""Install recipes for the Colab runtime (from the T3 spike). Idempotent; call before the worker runs.

    from enhancer_worker.setup_colab import ensure_realesrgan, ensure_spandrel
    ensure_realesrgan()
    ensure_spandrel()   # only for the spandrel presets (--runner auto)

Never touches torch / torchvision / numpy: Colab's own versions are used. The Real-ESRGAN repo is
cloned at a pinned commit and put on sys.path (not pip-installed, so its setup.py cannot break);
basicsr is installed with --no-deps and patched for torchvision >= 0.17.
"""

from __future__ import annotations

import hashlib
import importlib
import importlib.util
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

REPO_URL = "https://github.com/xinntao/Real-ESRGAN"
REPO_COMMIT = "a4abfb2979a7bbff3f69f58f58ae324608821e27"
BASICSR_VERSION = "1.4.2"
OLD_MOD = "torchvision.transforms.functional_tensor"
NEW_MOD = "torchvision.transforms.functional"

# pip name -> import name (light deps basicsr needs; torch/torchvision/numpy/opencv come from Colab)
LIGHT_DEPS = {
    "addict": "addict", "future": "future", "lmdb": "lmdb", "pyyaml": "yaml",
    "scikit-image": "skimage", "scipy": "scipy", "tqdm": "tqdm", "yapf": "yapf", "requests": "requests",
}

# spandrel (pip, wheel only): pinned to the version the models were verified with (docs/research/spandrel-models.md)
SPANDREL_VERSION = "0.4.2"
# spandrel's dependencies: Colab provides the first three (never installed or upgraded here: that could swap torch);
# the rest are small pure-Python wheels installed only when missing. pip name -> import name.
SPANDREL_COLAB_DEPS = ("torch", "torchvision", "numpy")
SPANDREL_LIGHT_DEPS = {"safetensors": "safetensors", "einops": "einops", "typing_extensions": "typing_extensions"}

_ready_dir: Path | None = None


def _say(msg: str) -> None:
    print(f"[setup] {msg}", flush=True)


def _sh(cmd: list[str], check: bool = True, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    p = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if check and p.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:4])} failed ({p.returncode}): {(p.stdout + p.stderr)[-1500:]}")
    return p


def _pip(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return _sh([sys.executable, "-m", "pip", "install", "-q", *args], check=check)


def _clone(repo_dir: Path) -> None:
    def git(*a: str, check: bool = True) -> subprocess.CompletedProcess:
        return _sh(["git", "-C", str(repo_dir), *a], check=check)

    if not (repo_dir / ".git").exists():
        repo_dir.mkdir(parents=True, exist_ok=True)
        _sh(["git", "init", "-q", str(repo_dir)])
        git("remote", "add", "origin", REPO_URL)
    head = git("rev-parse", "HEAD", check=False)
    if head.returncode == 0 and head.stdout.strip() == REPO_COMMIT:
        return
    if git("fetch", "--depth", "1", "origin", REPO_COMMIT, check=False).returncode != 0:
        git("fetch", "origin")  # server refused fetch-by-sha: full fetch
    git("checkout", "-q", "--force", REPO_COMMIT)
    got = git("rev-parse", "HEAD").stdout.strip()
    if got != REPO_COMMIT:
        raise RuntimeError(f"checked out {got}, pinned {REPO_COMMIT}")


def _write_version_py(repo_dir: Path) -> None:
    """realesrgan/__init__.py does `from .version import *`; setup.py normally generates it."""
    ver_file = repo_dir / "VERSION"
    version = ver_file.read_text().strip() if ver_file.exists() else "0.0.0"
    (repo_dir / "realesrgan" / "version.py").write_text(
        f"__version__ = {version!r}\n__gitsha__ = {REPO_COMMIT[:7]!r}\n"
        f"version_info = tuple(int(x) for x in {version!r}.split('.') if x.isdigit())\n"
    )


def _install_basicsr_patched_sdist(work: Path) -> None:
    """pip's sdist build breaks on new Pythons (KeyError '__version__'): patch setup.py and install."""
    import requests

    meta = requests.get(f"https://pypi.org/pypi/basicsr/{BASICSR_VERSION}/json", timeout=60).json()
    sdist = next(u for u in meta["urls"] if u["packagetype"] == "sdist")
    dl = work / "basicsr_sdist"
    dl.mkdir(exist_ok=True)
    archive = dl / sdist["filename"]
    archive.write_bytes(requests.get(sdist["url"], timeout=120).content)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != sdist["digests"]["sha256"]:
        raise RuntimeError("basicsr sdist hash mismatch")
    with tarfile.open(archive) as tf:
        if hasattr(tarfile, "data_filter"):
            tf.extractall(dl, filter="data")
        else:
            tf.extractall(dl)
    src = next(p for p in dl.iterdir() if p.is_dir() and (p / "setup.py").exists())
    text = (src / "setup.py").read_text()
    needle = "return locals()['__version__']"
    if needle not in text:
        raise RuntimeError("basicsr setup.py layout changed; patch needs updating")
    (src / "setup.py").write_text(text.replace(needle, f"return '{BASICSR_VERSION}'"))
    _pip("--no-deps", str(src))


def _ensure_basicsr(work: Path) -> str:
    if importlib.util.find_spec("basicsr") is not None:
        return "present"
    if _pip("--no-deps", f"basicsr=={BASICSR_VERSION}", check=False).returncode == 0:
        method = "pip"
    else:
        _install_basicsr_patched_sdist(work)
        method = "patched sdist"
    importlib.invalidate_caches()
    return method


def _patch_functional_tensor() -> int:
    """basicsr imports torchvision.transforms.functional_tensor (removed in torchvision 0.17)."""
    spec = importlib.util.find_spec("basicsr")
    if not spec or not spec.submodule_search_locations:
        raise RuntimeError("basicsr not installed")
    n = 0
    for py in sorted(Path(list(spec.submodule_search_locations)[0]).rglob("*.py")):
        text = py.read_text(encoding="utf-8")
        if OLD_MOD in text:
            py.write_text(text.replace(OLD_MOD, NEW_MOD), encoding="utf-8")
            n += 1
    return n


def _import_check(repo_dir: Path) -> str:
    """Import everything in a fresh interpreter so stale modules cannot hide a failure."""
    env = dict(os.environ, PYTHONPATH=os.pathsep.join(filter(None, [str(repo_dir), os.environ.get("PYTHONPATH", "")])))
    code = (
        "import basicsr, realesrgan, numpy, cv2;"
        "from basicsr.archs.rrdbnet_arch import RRDBNet;"
        "from realesrgan import RealESRGANer;"
        "from realesrgan.archs.srvgg_arch import SRVGGNetCompact;"
        "print('basicsr', basicsr.__version__, 'numpy', numpy.__version__)"
    )
    p = _sh([sys.executable, "-c", code], check=False, env=env)
    if p.returncode != 0:
        raise RuntimeError(f"Real-ESRGAN import check failed:\n{p.stderr[-2000:]}")
    return p.stdout.strip()


def ensure_realesrgan(work_dir: str | Path | None = None) -> Path:
    """Install/verify Real-ESRGAN + basicsr, put the repo on sys.path. Returns the repo directory."""
    global _ready_dir
    if _ready_dir is not None and str(_ready_dir) in sys.path:
        return _ready_dir
    work = Path(work_dir) if work_dir else Path(
        "/content/enhancer-setup" if Path("/content").exists() else Path(tempfile.gettempdir()) / "enhancer-setup"
    )
    work.mkdir(parents=True, exist_ok=True)
    repo_dir = work / "Real-ESRGAN"

    _clone(repo_dir)
    _write_version_py(repo_dir)
    if str(repo_dir) not in sys.path:
        sys.path.insert(0, str(repo_dir))

    missing = [pip for pip, mod in LIGHT_DEPS.items() if importlib.util.find_spec(mod) is None]
    if missing:
        _pip(*missing)
        importlib.invalidate_caches()
    basicsr = _ensure_basicsr(work)
    patched = _patch_functional_tensor()
    summary = _import_check(repo_dir)
    _say(f"Real-ESRGAN {REPO_COMMIT[:7]} ready (basicsr: {basicsr}, patched files: {patched}, {summary})")
    _ready_dir = repo_dir
    return repo_dir


def _spandrel_installed() -> bool:
    from importlib import metadata

    try:
        return metadata.version("spandrel") == SPANDREL_VERSION
    except metadata.PackageNotFoundError:
        return False


def ensure_spandrel() -> str:
    """Install/verify spandrel (pinned) without touching torch. Returns the installed version."""
    for mod in SPANDREL_COLAB_DEPS:
        if importlib.util.find_spec(mod) is None:
            raise RuntimeError(f"spandrel needs {mod}, which the Colab image should provide (not installing it)")
    missing = [pip for pip, mod in SPANDREL_LIGHT_DEPS.items() if importlib.util.find_spec(mod) is None]
    if missing:
        _pip(*missing)
    if not _spandrel_installed():
        # --no-deps: every dependency was checked/installed above, so pip cannot replace torch or numpy
        if _pip("--no-deps", f"spandrel=={SPANDREL_VERSION}", check=False).returncode != 0:
            _pip("-U", "pip")  # the build backend of an sdist fallback needs a recent pip
            _pip("--no-deps", f"spandrel=={SPANDREL_VERSION}")
    importlib.invalidate_caches()
    code = ("import spandrel; from spandrel import ModelLoader, ImageModelDescriptor;"
            "print('spandrel', spandrel.__version__ if hasattr(spandrel, '__version__') else '?')")
    p = _sh([sys.executable, "-c", code], check=False)
    if p.returncode != 0:
        raise RuntimeError(f"spandrel import check failed: {p.stderr[-2000:]}")
    _say(f"spandrel {SPANDREL_VERSION} ready ({p.stdout.strip()})")
    return SPANDREL_VERSION
