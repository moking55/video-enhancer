"""Three-stage streaming pipeline: decoder thread -> bounded queue -> inference (calling thread)
-> bounded queue -> encoder thread. Pure Python (no torch/numpy): inference is an injected callable
operating on raw rgb24 `bytes` frames, so ordering, back-pressure, abort and error propagation can
be tested without a GPU.

ffmpeg stderr goes to temp files (never a PIPE) so a full pipe can't deadlock. On any failure or
abort both ffmpeg processes (our own children only) are killed and both threads are joined.
"""

from __future__ import annotations

import queue
import subprocess
import tempfile
import threading
from typing import Callable

from .errors import MediaError

QUEUE_SIZE = 8
_POLL_SEC = 0.1

_END = object()  # normal end of stream
_STOPPED = object()  # pipeline is shutting down

Upscale = Callable[[list[bytes]], list[bytes]]


class _Proc:
    def __init__(self, cmd: list[str], **popen_kw):
        self.err = tempfile.TemporaryFile()
        try:
            self.p = subprocess.Popen(cmd, stderr=self.err, **popen_kw)
        except FileNotFoundError as e:
            self.err.close()
            raise MediaError(f"{cmd[0]} not found") from e

    def tail(self) -> str:
        try:
            self.err.seek(0)
            return self.err.read().decode("utf-8", "replace").strip()[-500:]
        except (OSError, ValueError):
            return ""

    def kill(self) -> None:
        if self.p.poll() is None:
            self.p.kill()
        self.p.wait()

    def close(self) -> None:
        self.kill()
        for f in (self.p.stdin, self.p.stdout):
            if f is not None:
                try:
                    f.close()
                except OSError:
                    pass
        self.err.close()


def _put(q: queue.Queue, item: object, stop: threading.Event) -> bool:
    while not stop.is_set():
        try:
            q.put(item, timeout=_POLL_SEC)
            return True
        except queue.Full:
            pass
    return False


def _get(q: queue.Queue, stop: threading.Event) -> object:
    while True:
        try:
            return q.get(timeout=_POLL_SEC)
        except queue.Empty:
            if stop.is_set():
                return _STOPPED


def run_pipeline(
    *,
    decode_cmd: list[str],
    encode_cmd: list[str],
    in_frame_bytes: int,
    out_frame_bytes: int,
    upscale: Upscale,
    batch_size: Callable[[], int],
    on_progress: Callable[[int], None],
    check_abort: Callable[[], None],
    queue_size: int = QUEUE_SIZE,
) -> int:
    """Run decode -> upscale -> encode. Returns the number of frames written to the encoder.
    Raises the first failure (thread error, or whatever check_abort / upscale raised)."""
    stop = threading.Event()
    errors: list[BaseException] = []
    err_lock = threading.Lock()
    q_in: queue.Queue = queue.Queue(maxsize=queue_size)
    q_out: queue.Queue = queue.Queue(maxsize=queue_size)
    written = [0]

    def fail(e: BaseException) -> None:
        with err_lock:
            errors.append(e)
        stop.set()

    dec = _Proc(decode_cmd, stdout=subprocess.PIPE)
    try:
        enc = _Proc(encode_cmd, stdin=subprocess.PIPE)
    except BaseException:
        dec.close()
        raise

    def decoder() -> None:
        try:
            assert dec.p.stdout is not None
            while not stop.is_set():
                buf = dec.p.stdout.read(in_frame_bytes)
                if len(buf) < in_frame_bytes:
                    if buf:
                        raise MediaError(f"decoder produced a truncated frame ({len(buf)} of {in_frame_bytes} bytes)")
                    break
                if not _put(q_in, buf, stop):
                    return
            else:
                return
            rc = dec.p.wait()
            if rc != 0:
                raise MediaError(f"ffmpeg decode failed ({rc}): {dec.tail()}")
            _put(q_in, _END, stop)
        except BaseException as e:  # noqa: BLE001 - propagated to the caller
            fail(e)

    def encoder() -> None:
        try:
            assert enc.p.stdin is not None
            while True:
                item = _get(q_out, stop)
                if item is _STOPPED:
                    return
                if item is _END:
                    break
                try:
                    enc.p.stdin.write(item)
                except (BrokenPipeError, OSError, ValueError) as e:
                    enc.p.wait()
                    raise MediaError(f"ffmpeg encode failed ({enc.p.returncode}): {enc.tail()}") from e
                written[0] += 1
            enc.p.stdin.close()
            rc = enc.p.wait()
            if rc != 0:
                raise MediaError(f"ffmpeg encode failed ({rc}): {enc.tail()}")
        except BaseException as e:  # noqa: BLE001
            fail(e)

    t_dec = threading.Thread(target=decoder, name="decode", daemon=True)
    t_enc = threading.Thread(target=encoder, name="encode", daemon=True)
    t_dec.start()
    t_enc.start()

    ok = False
    try:
        processed = 0
        ended = False
        while not ended:
            check_abort()
            if stop.is_set():
                break
            first = _get(q_in, stop)
            if first is _STOPPED:
                break
            if first is _END:
                break
            batch = [first]
            want = max(1, batch_size())
            while len(batch) < want:
                try:
                    item = q_in.get_nowait()
                except queue.Empty:
                    break
                if item is _END:
                    ended = True
                    break
                batch.append(item)
            outs = upscale(batch)
            if len(outs) != len(batch) or any(len(o) != out_frame_bytes for o in outs):
                raise MediaError("upscaler returned frames of the wrong count or size")
            for o in outs:
                if not _put(q_out, o, stop):
                    break
            processed += len(batch)
            on_progress(processed)
        if not stop.is_set():
            _put(q_out, _END, stop)
            while t_enc.is_alive():  # encoder flush can take a while: stay cancellable
                t_enc.join(_POLL_SEC)
                check_abort()
        if errors:
            raise errors[0]
        ok = True
        return written[0]
    finally:
        stop.set()
        if not ok:
            dec.kill()
            enc.kill()
        t_dec.join(10)
        t_enc.join(10)
        dec.close()
        enc.close()
