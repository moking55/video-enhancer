# enhancer-worker

GPU-side worker for the Video Enhancer. It claims queued jobs from the web app's `/api/v1/worker/*` API
(contract: `../docs/worker-contract.md`), enhances each video, uploads the result, and **exits when the queue is empty**.
No polling, keep-alive or daemon: run it by hand, once per session.

## Run locally with the mock runner

Needs Python 3.10+ and `ffmpeg`/`ffprobe` on PATH. The mock runner needs no GPU.

```
python -m venv .venv
.venv/Scripts/pip install -e ".[dev]"      # Windows; use .venv/bin/pip on Linux/macOS
.venv/Scripts/python -m pytest             # unit tests

export ENHANCER_TOKEN=ve_...               # worker token from the web app Settings page
python -m enhancer_worker run --api http://localhost:3000 --runner mock --max-jobs 1
```

The token is read from `ENHANCER_TOKEN` (preferred, keeps it out of the process list) or `--token`.
Exit codes: `0` queue empty / max jobs reached, `1` API or auth error (regenerate the token), `2` setup error.

## Run on Colab (production)

Open `colab_runner.ipynb` in Google Colab, then:

1. **Runtime -> Change runtime type -> T4 GPU**.
2. Add two **Colab Secrets** (key icon in the sidebar) with **Notebook access** enabled:
   - `ENHANCER_TOKEN`: the worker token from the web app Settings page (operator only; a new token revokes the old one).
   - `ENHANCER_API`: base URL of the web app, e.g. `https://your-app.vercel.app`.
3. **Runtime -> Run all.** Approve the Google Drive prompt if `USE_DRIVE_CACHE` is on (model weights are cached there).
4. The notebook processes the whole queue and ends. To process new jobs, run it again, then
   **Runtime -> Disconnect and delete runtime** to free the GPU.

Form fields in the settings cell: `REPO_REF` (branch/tag/commit to install), `USE_DRIVE_CACHE`, `WEIGHTS_DIR_DRIVE`,
`MAX_JOBS` (0 = until empty), `RUNNER` (`realesrgan` or `mock`). Secrets are never printed; only a masked token and the API host.
