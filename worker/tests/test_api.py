from __future__ import annotations

import json

import pytest
import requests

from enhancer_worker.api import ApiClient, ApiError, StaleAttempt

TOKEN = "ve_" + "A" * 43
JOB = "11111111-1111-4111-8111-111111111111"
ATT = "22222222-2222-4222-8222-222222222222"


class FakeResp:
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


class FakeSession:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, url, json=None, headers=None, timeout=None):
        self.calls.append({"method": method, "url": url, "json": json, "headers": headers, "timeout": timeout})
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def client(*responses):
    s = FakeSession(*responses)
    sleeps = []
    return ApiClient("http://api.test/", TOKEN, session=s, backoff=0.5, sleep=sleeps.append), s, sleeps


def test_claim_204_returns_none():
    c, s, _ = client(FakeResp(204))
    assert c.claim(["mock-x2"], {"name": "T4", "vramMb": 15360}) is None
    call = s.calls[0]
    assert call["url"] == "http://api.test/api/v1/worker/claim"
    assert call["headers"]["Authorization"] == f"Bearer {TOKEN}"
    assert call["json"] == {"presets": ["mock-x2"], "gpu": {"name": "T4", "vramMb": 15360}}
    assert call["timeout"] == (10.0, 60.0)


def test_claim_200_and_empty_body():
    c, s, _ = client(FakeResp(200, {"jobId": JOB}))
    assert c.claim() == {"jobId": JOB}
    assert s.calls[0]["json"] == {}


def test_stale_attempt_raises():
    err = {"error": {"code": "STALE_ATTEMPT", "message": "nope"}}
    c, _, _ = client(FakeResp(409, err))
    with pytest.raises(StaleAttempt):
        c.heartbeat(JOB, ATT, "enhance", 1, 2)


def test_5xx_retried_then_succeeds():
    c, s, sleeps = client(FakeResp(503), FakeResp(500), FakeResp(200, {"cancelRequested": True}))
    assert c.heartbeat(JOB, ATT, "probe", probe={"a": 1}) is True
    assert len(s.calls) == 3 and sleeps == [0.5, 1.0]
    assert s.calls[0]["json"] == {"attemptId": ATT, "stage": "probe", "probe": {"a": 1}}


def test_5xx_exhausted():
    c, s, _ = client(FakeResp(500), FakeResp(500), FakeResp(502))
    with pytest.raises(ApiError, match="3 tries"):
        c.output_url(JOB, ATT)
    assert len(s.calls) == 3


def test_connection_error_retried():
    c, s, _ = client(requests.ConnectionError(f"boom {TOKEN} http://x/?sig=secret"), FakeResp(200, {"putUrl": "u"}))
    assert c.output_url(JOB, ATT) == {"putUrl": "u"}
    assert len(s.calls) == 2


def test_connection_error_exhausted_message_is_clean():
    e = requests.ConnectionError(f"boom {TOKEN} https://x/?sig=secret")
    c, _, _ = client(e, e, e)
    with pytest.raises(ApiError) as ei:
        c.claim()
    assert TOKEN not in str(ei.value) and "sig=" not in str(ei.value)


def test_4xx_not_retried_and_token_not_leaked():
    body = {"error": {"code": "VALIDATION", "message": f"bad {TOKEN} see https://s3/x?X-Amz-Signature=abc"}}
    c, s, _ = client(FakeResp(400, body))
    with pytest.raises(ApiError) as ei:
        c.fail(JOB, ATT, "INTERNAL", "x")
    assert len(s.calls) == 1
    assert ei.value.status == 400 and ei.value.code == "VALIDATION"
    msg = str(ei.value)
    assert TOKEN not in msg and "Signature" not in msg
    assert TOKEN not in repr(c)


def test_401_not_retried():
    c, s, _ = client(FakeResp(401, {"error": {"code": "INVALID_WORKER_TOKEN", "message": "x"}}))
    with pytest.raises(ApiError) as ei:
        c.claim()
    assert ei.value.code == "INVALID_WORKER_TOKEN" and len(s.calls) == 1


def test_complete_states():
    c, s, _ = client(FakeResp(200, {"state": "SUCCEEDED"}),
                     FakeResp(409, {"error": {"code": "CANCELLED", "message": "c"}}),
                     FakeResp(409, {"error": {"code": "OUTPUT_SIZE_MISMATCH", "message": "m"}}))
    meta = {"width": 2, "height": 2, "frames": 1, "fps": 30.0, "durationSec": 0.03, "hasAudio": False, "sizeBytes": 5}
    assert c.complete(JOB, ATT, meta) == "SUCCEEDED"
    assert s.calls[0]["json"] == {"attemptId": ATT, "outputMeta": meta}
    assert c.complete(JOB, ATT, meta) == "CANCELLED"
    with pytest.raises(ApiError) as ei:
        c.complete(JOB, ATT, meta)
    assert ei.value.code == "OUTPUT_SIZE_MISMATCH"


def test_fail_returns_state_and_truncates():
    c, s, _ = client(FakeResp(200, {"state": "FAILED"}))
    assert c.fail(JOB, ATT, "X" * 200, "m" * 5000) == "FAILED"
    body = s.calls[0]["json"]
    assert len(body["code"]) == 100 and len(body["message"]) <= 2000
    json.dumps(body)
