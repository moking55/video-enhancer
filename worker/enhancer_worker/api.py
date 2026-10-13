"""HTTP client for /api/v1/worker/* (contract: docs/worker-contract.md)."""

from __future__ import annotations

import time
from typing import Any, Callable

import requests

from .errors import sanitize

CONNECT_TIMEOUT = 10.0
READ_TIMEOUT = 60.0
TRIES = 3
API_PREFIX = "/api/v1/worker"


class ApiError(Exception):
    """Non-retryable (or retries exhausted) API failure. Message never holds the token or URLs."""

    def __init__(self, message: str, status: int = 0, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


class StaleAttempt(ApiError):
    """409 STALE_ATTEMPT: the job was restarted/requeued; stop working on it and do not report."""


class ApiClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        session: Any | None = None,
        *,
        tries: int = TRIES,
        backoff: float = 1.0,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self._base = base_url.rstrip("/")
        self._token = token
        self._session = session if session is not None else requests.Session()
        self._tries = max(1, tries)
        self._backoff = backoff
        self._sleep = sleep

    def __repr__(self) -> str:  # never show the token
        return f"ApiClient(base_url={self._base!r})"

    def _clean(self, text: str) -> str:
        return sanitize(text, (self._token,), 500)

    def _request(self, path: str, body: dict[str, Any]) -> Any:
        """POST JSON; returns the response (status already checked). Retries connection errors and 5xx."""
        url = f"{self._base}{API_PREFIX}{path}"
        headers = {"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"}
        last = "no attempt made"
        for attempt in range(self._tries):
            if attempt:
                self._sleep(self._backoff * (2 ** (attempt - 1)))
            try:
                resp = self._session.request(
                    "POST", url, json=body, headers=headers, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT)
                )
            except (requests.ConnectionError, requests.Timeout) as e:
                last = type(e).__name__
                continue
            if resp.status_code >= 500:
                last = f"HTTP {resp.status_code}"
                continue
            if resp.status_code >= 400:
                raise self._to_error(path, resp)
            return resp
        raise ApiError(f"POST {path} failed after {self._tries} tries: {last}", status=0, code="UNAVAILABLE")

    def _to_error(self, path: str, resp: Any) -> ApiError:
        code, message = None, ""
        try:
            err = resp.json().get("error", {})
            code, message = err.get("code"), str(err.get("message", ""))
        except Exception:  # noqa: BLE001 - body is not JSON
            pass
        text = self._clean(f"POST {path} -> HTTP {resp.status_code} {code or ''} {message}".strip())
        if resp.status_code == 409 and code == "STALE_ATTEMPT":
            return StaleAttempt(text, status=409, code=code)
        return ApiError(text, status=resp.status_code, code=code)

    def claim(self, presets: list[str] | None = None, gpu: dict[str, Any] | None = None) -> dict[str, Any] | None:
        body: dict[str, Any] = {}
        if presets is not None:
            body["presets"] = presets
        if gpu is not None:
            body["gpu"] = gpu
        resp = self._request("/claim", body)
        if resp.status_code == 204:
            return None
        return resp.json()

    def heartbeat(
        self,
        job_id: str,
        attempt_id: str,
        stage: str,
        processed: int | None = None,
        total: int | None = None,
        probe: dict[str, Any] | None = None,
    ) -> bool:
        body: dict[str, Any] = {"attemptId": attempt_id, "stage": stage}
        if processed is not None:
            body["processedFrames"] = int(processed)
        if total is not None:
            body["totalFrames"] = int(total)
        if probe is not None:
            body["probe"] = probe
        resp = self._request(f"/jobs/{job_id}/heartbeat", body)
        return bool(resp.json().get("cancelRequested", False))

    def output_url(self, job_id: str, attempt_id: str) -> dict[str, Any]:
        """Returns {"putUrl", "headers", "expiresAt"}. The URL is signed: never log it."""
        return self._request(f"/jobs/{job_id}/output-url", {"attemptId": attempt_id}).json()

    def complete(self, job_id: str, attempt_id: str, output_meta: dict[str, Any]) -> str:
        """Returns the resulting job state ("SUCCEEDED", or "CANCELLED" on 409 CANCELLED, which means
        the user cancelled and the output was discarded). Safe to repeat. 409 OUTPUT_MISSING /
        OUTPUT_SIZE_MISMATCH / STALE_ATTEMPT raise ApiError / StaleAttempt."""
        body = {"attemptId": attempt_id, "outputMeta": output_meta}
        try:
            return str(self._request(f"/jobs/{job_id}/complete", body).json().get("state", ""))
        except ApiError as e:
            if e.status == 409 and e.code == "CANCELLED":
                return "CANCELLED"
            raise

    def fail(self, job_id: str, attempt_id: str, code: str, message: str) -> str:
        """Returns the resulting job state ("FAILED" or "CANCELLED")."""
        body = {"attemptId": attempt_id, "code": (code or "INTERNAL")[:100], "message": self._clean(message)[:2000]}
        return str(self._request(f"/jobs/{job_id}/fail", body).json().get("state", ""))
