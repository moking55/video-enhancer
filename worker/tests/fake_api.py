"""In-process fake of the worker API + signed-URL storage (http.server on a thread)."""

from __future__ import annotations

import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

TOKEN = "ve_" + "T" * 43
PREFIX = "/api/v1/worker"


class FakeApi:
    def __init__(self) -> None:
        self.queue: list[dict[str, Any]] = []
        self.jobs: dict[str, dict[str, Any]] = {}
        self.calls: list[tuple[str, str, dict[str, Any]]] = []  # (endpoint, jobId, body)
        self.uploads: dict[str, bytes] = {}
        self.cancel_on_heartbeat = False
        self.stale_on_heartbeat = False
        self.complete_status: tuple[int, dict[str, Any]] | None = None  # force a response
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.base_url = f"http://127.0.0.1:{self._server.server_address[1]}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def start(self) -> "FakeApi":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def add_job(self, input_file: Path, preset: dict[str, Any]) -> str:
        job_id, attempt_id = str(uuid.uuid4()), str(uuid.uuid4())
        self.jobs[job_id] = {"attemptId": attempt_id, "state": "QUEUED", "input": input_file, "preset": preset}
        self.queue.append({"jobId": job_id, "attemptId": attempt_id})
        return job_id

    def endpoints(self, name: str) -> list[dict[str, Any]]:
        return [b for (e, _, b) in self.calls if e == name]

    def _handler(self):
        api = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a: Any) -> None:
                pass

            def _send(self, status: int, body: Any = None, raw: bytes | None = None) -> None:
                data = raw if raw is not None else (json.dumps(body).encode() if body is not None else b"")
                self.send_response(status)
                if status != 204:
                    self.send_header("Content-Length", str(len(data)))
                    if raw is None:
                        self.send_header("Content-Type", "application/json")
                else:
                    self.send_header("Content-Length", "0")
                self.end_headers()
                if status != 204:
                    self.wfile.write(data)

            def _err(self, status: int, code: str) -> None:
                self._send(status, {"error": {"code": code, "message": code}})

            def do_GET(self) -> None:  # noqa: N802 - storage download
                path = self.path.split("?")[0]
                if path.startswith("/storage/in/"):
                    job = api.jobs.get(path.rsplit("/", 1)[1])
                    if job:
                        self._send(200, raw=job["input"].read_bytes())
                        return
                self._send(404, {})

            def do_PUT(self) -> None:  # noqa: N802 - storage upload
                n = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(n)
                path = self.path.split("?")[0]
                if self.headers.get("Content-Type") != "video/mp4" or not path.startswith("/storage/out/"):
                    self._send(403, {})
                    return
                api.uploads[path.rsplit("/", 1)[1]] = body
                self._send(200, raw=b"")

            def do_POST(self) -> None:  # noqa: N802
                n = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(n) or b"{}")
                if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                    self._err(401, "INVALID_WORKER_TOKEN")
                    return
                path = self.path[len(PREFIX):]
                if path == "/claim":
                    api.calls.append(("claim", "", body))
                    if not api.queue:
                        self._send(204)
                        return
                    c = api.queue.pop(0)
                    job = api.jobs[c["jobId"]]
                    job["state"] = "RUNNING"
                    self._send(200, {
                        **c, "preset": job["preset"],
                        "inputUrl": f"{api.base_url}/storage/in/{c['jobId']}?sig=secret",
                        "input": {"assetId": str(uuid.uuid4()), "sizeBytes": job["input"].stat().st_size,
                                  "filename": "clip.mp4"},
                    })
                    return
                parts = path.strip("/").split("/")  # jobs/{id}/{endpoint}
                job_id, endpoint = parts[1], parts[2]
                job = api.jobs.get(job_id)
                api.calls.append((endpoint, job_id, body))
                if job is None:
                    self._err(404, "NOT_FOUND")
                    return
                if body.get("attemptId") != job["attemptId"] or job["state"] != "RUNNING" \
                        or (endpoint == "heartbeat" and api.stale_on_heartbeat):
                    self._err(409, "STALE_ATTEMPT")
                    return
                if endpoint == "heartbeat":
                    self._send(200, {"cancelRequested": api.cancel_on_heartbeat})
                elif endpoint == "output-url":
                    self._send(200, {"putUrl": f"{api.base_url}/storage/out/{job_id}.mp4?sig=secret",
                                     "headers": {"Content-Type": "video/mp4"},
                                     "expiresAt": "2030-01-01T00:00:00.000Z"})
                elif endpoint == "complete":
                    if api.complete_status:
                        self._send(*api.complete_status)
                        return
                    up = api.uploads.get(f"{job_id}.mp4")
                    if up is None:
                        self._err(409, "OUTPUT_MISSING")
                    elif len(up) != body["outputMeta"]["sizeBytes"]:
                        self._err(409, "OUTPUT_SIZE_MISMATCH")
                    else:
                        job["state"] = "SUCCEEDED"
                        self._send(200, {"state": "SUCCEEDED"})
                elif endpoint == "fail":
                    job["state"] = "CANCELLED" if body["code"] == "CANCELLED" else "FAILED"
                    self._send(200, {"state": job["state"]})
                else:
                    self._err(404, "NOT_FOUND")

        return H
