"""Command line: `python -m enhancer_worker run --api URL --runner mock|realesrgan`.

Processes the queue once (claim until 204) and exits. No sleeping, polling or keepalive.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from . import media, probe, transfer
from .api import ApiClient, ApiError, StaleAttempt
from .errors import WorkerError, sanitize
from .heartbeat import Cancelled, Heartbeat, LeaseLost
from .presets import Preset
from .runners import RUNNER_NAMES, get_runner
from .runners.base import Runner
from .weights import DEFAULT_CACHE_DIR


def log(msg: str) -> None:
    print(msg, flush=True)


def detect_gpu() -> dict[str, Any] | None:
    """{"name", "vramMb"} from nvidia-smi, or None."""
    try:
        p = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=15,
        )
        if p.returncode != 0:
            return None
        name, mem = [x.strip() for x in p.stdout.splitlines()[0].split(",")]
        return {"name": name, "vramMb": int(float(mem))}
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None


def _pipeline(
    api: ApiClient, runner: Runner, claim: dict[str, Any], preset: Preset, job_dir: Path, hb: Heartbeat
) -> dict[str, Any]:
    """download -> probe -> limits -> process -> verify -> upload. Returns outputMeta."""
    job_id, attempt_id = claim["jobId"], claim["attemptId"]
    in_path, out_path = job_dir / "input.mp4", job_dir / "output.mp4"

    def stage(name: str, **kw: Any) -> None:
        hb.set_stage(name, **kw)
        hb.check()

    stage("download")
    transfer.download(claim["inputUrl"], in_path, claim.get("input", {}).get("sizeBytes"))
    hb.check()

    stage("probe")
    info = probe.probe_file(in_path)
    stage("probe", probe=info.to_summary())
    probe.check_input_limits(info, preset)

    stage("enhance")
    hb.set_progress(0, info.frames)
    runner.process(in_path, out_path, preset, info, hb.set_progress, hb.check)
    hb.check()

    stage("encode")  # final verification of the encoded file
    out_info = media.verify_output(info, out_path, preset.scale)
    meta = media.output_meta(out_info)

    stage("upload")
    target = api.output_url(job_id, attempt_id)
    transfer.upload(target["putUrl"], target.get("headers", {}), out_path)
    hb.check()
    return meta


def run_job(api: ApiClient, runner: Runner, claim: dict[str, Any], work_dir: Path) -> str:
    """Process one claimed job and report the result. Returns 'succeeded', 'failed', 'cancelled' or 'lost'."""
    job_id, attempt_id = claim["jobId"], claim["attemptId"]
    preset = Preset.from_claim(claim["preset"])
    job_dir = work_dir / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    log(f"job {job_id}: preset {preset.id}")
    hb = Heartbeat(api, job_id, attempt_id).start()
    try:
        try:
            meta = _pipeline(api, runner, claim, preset, job_dir, hb)
        finally:
            hb.stop()
        state = api.complete(job_id, attempt_id, meta)
        if state == "CANCELLED":
            log(f"job {job_id}: cancelled by user, output discarded")
            return "cancelled"
        log(f"job {job_id}: succeeded")
        return "succeeded"
    except (LeaseLost, StaleAttempt):
        log(f"job {job_id}: attempt is stale, stopping without reporting")
        return "lost"
    except Cancelled:
        return _report_fail(api, job_id, attempt_id, "CANCELLED", "cancelled by user", "cancelled")
    except WorkerError as e:
        return _report_fail(api, job_id, attempt_id, e.code, str(e), "failed")
    except Exception as e:  # noqa: BLE001 - every failure must be reported, not crash the loop
        return _report_fail(api, job_id, attempt_id, "INTERNAL", f"{type(e).__name__}: {e}", "failed")
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


def _report_fail(api: ApiClient, job_id: str, attempt_id: str, code: str, message: str, outcome: str) -> str:
    message = sanitize(message)
    log(f"job {job_id}: {outcome} ({code}): {message[:200]}")
    try:
        api.fail(job_id, attempt_id, code, message)
    except StaleAttempt:
        return "lost"
    except ApiError as e:
        log(f"job {job_id}: could not report failure: {e}")
    return outcome


def run_queue(api: ApiClient, runner: Runner, work_dir: Path, max_jobs: int | None = None) -> int:
    """Claim and process jobs until the queue is empty (or max_jobs). Returns an exit code."""
    gpu = None if runner.name == "mock" else detect_gpu()
    done = 0
    while max_jobs is None or done < max_jobs:
        try:
            claim = api.claim(presets=list(runner.presets), gpu=gpu)
        except ApiError as e:
            if e.code == "ASSET_MISSING":
                log("input asset missing for a job (server failed it); claiming again")
                continue
            log(f"claim failed: {e}")
            return 1
        if claim is None:
            log("queue empty")
            return 0
        run_job(api, runner, claim, work_dir)
        done += 1
    log(f"max jobs ({max_jobs}) reached")
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="enhancer-worker")
    sub = ap.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="process the queue once, then exit")
    run.add_argument("--api", default=os.environ.get("ENHANCER_API"), help="web app base URL (or env ENHANCER_API)")
    run.add_argument("--token", default=None, help="worker token (or env ENHANCER_TOKEN)")
    run.add_argument("--runner", choices=RUNNER_NAMES, default="mock")
    run.add_argument("--work-dir", default=None, help="scratch directory (default: a temp dir)")
    run.add_argument("--max-jobs", type=int, default=None, help="stop after this many jobs")
    run.add_argument("--weights-dir", default=str(DEFAULT_CACHE_DIR),
                     help="model weights cache (Colab: a Google Drive path); default %(default)s")
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    token = args.token or os.environ.get("ENHANCER_TOKEN")
    if not args.api:
        print("error: --api (or env ENHANCER_API) is required", file=sys.stderr)
        return 2
    if not token:
        print("error: --token (or env ENHANCER_TOKEN) is required", file=sys.stderr)
        return 2
    if args.runner == "realesrgan":
        from .setup_colab import ensure_realesrgan  # lazy: only this runner needs torch & co

        try:
            ensure_realesrgan()
        except Exception as e:  # noqa: BLE001
            print(f"error: Real-ESRGAN setup failed: {sanitize(str(e), limit=1500)}", file=sys.stderr)
            return 2
    runner = get_runner(args.runner, args.weights_dir)

    api = ApiClient(args.api, token)
    if args.work_dir:
        work_dir = Path(args.work_dir)
        work_dir.mkdir(parents=True, exist_ok=True)
        return run_queue(api, runner, work_dir, args.max_jobs)
    with tempfile.TemporaryDirectory(prefix="enhancer-") as tmp:
        return run_queue(api, runner, Path(tmp), args.max_jobs)


if __name__ == "__main__":
    sys.exit(main())
