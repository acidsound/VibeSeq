from __future__ import annotations

import atexit
import json
import os
import queue
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any

from .security import safe_error_message
from .storage_paths import inference_data_dir


def _worker_creation_flags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


class CudaServiceClient:
    """One long-lived managed-CUDA process shared by generation and transcription."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._process: subprocess.Popen[str] | None = None
        self._python: Path | None = None
        self._messages: queue.Queue[dict[str, Any]] | None = None
        self._log_handle = None
        self._log_path: Path | None = None

    def _read_messages(
        self,
        process: subprocess.Popen[str],
        messages: queue.Queue[dict[str, Any]],
    ) -> None:
        assert process.stdout is not None
        try:
            for line in process.stdout:
                try:
                    value = json.loads(line)
                except (TypeError, ValueError):
                    messages.put(
                        {
                            "event": "protocol-error",
                            "message": "The CUDA service emitted an invalid response.",
                        }
                    )
                    continue
                if isinstance(value, dict):
                    messages.put(value)
        finally:
            messages.put({"event": "closed"})

    def _start_unlocked(self, python: Path) -> None:
        self._stop_unlocked()
        log_path = inference_data_dir() / "logs" / "cuda-service.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_handle = log_path.open("a", encoding="utf-8", buffering=1)
        environment = os.environ.copy()
        environment["PYTHONUNBUFFERED"] = "1"
        process = subprocess.Popen(
            [str(python), "-u", "-m", "vibeseq_inference.cuda_service"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=log_handle,
            text=True,
            bufsize=1,
            env=environment,
            creationflags=_worker_creation_flags(),
        )
        messages: queue.Queue[dict[str, Any]] = queue.Queue()
        reader = threading.Thread(
            target=self._read_messages,
            args=(process, messages),
            name="vibeseq-cuda-service-reader",
            daemon=True,
        )
        reader.start()
        self._process = process
        self._python = python
        self._messages = messages
        self._log_handle = log_handle
        self._log_path = log_path

    def _stop_unlocked(self) -> None:
        process = self._process
        self._process = None
        self._python = None
        self._messages = None
        if process is not None:
            if process.stdin is not None:
                try:
                    process.stdin.close()
                except OSError:
                    pass
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
        if self._log_handle is not None:
            self._log_handle.close()
            self._log_handle = None

    def close(self) -> None:
        with self._lock:
            self._stop_unlocked()

    def _log_tail(self) -> str:
        try:
            assert self._log_path is not None
            return self._log_path.read_text(encoding="utf-8", errors="replace")[-4000:]
        except (AssertionError, OSError):
            return ""

    def request(
        self,
        *,
        python: Path,
        operation: str,
        payload: dict[str, Any],
        progress,
        cancelled,
    ) -> dict[str, Any]:
        with self._lock:
            if (
                self._process is None
                or self._process.poll() is not None
                or self._python != python
            ):
                self._start_unlocked(python)
            process = self._process
            messages = self._messages
            assert process is not None and messages is not None and process.stdin is not None

            request_id = uuid.uuid4().hex
            request = {"id": request_id, "operation": operation, **payload}
            try:
                process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
                process.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                tail = self._log_tail()
                self._stop_unlocked()
                raise RuntimeError(
                    "The persistent CUDA service could not accept a request. "
                    + safe_error_message(tail or exc, limit=1000)
                ) from exc

            while True:
                if cancelled():
                    self._stop_unlocked()
                    from .providers.base import JobCancelled

                    raise JobCancelled(f"CUDA {operation} was cancelled.")
                try:
                    message = messages.get(timeout=0.05)
                except queue.Empty:
                    if process.poll() is None:
                        continue
                    message = {"event": "closed"}

                if message.get("id") not in {None, request_id}:
                    continue
                event = message.get("event")
                if event == "progress":
                    try:
                        progress(float(message["value"]))
                    except (KeyError, TypeError, ValueError):
                        pass
                    continue
                if event == "result":
                    result = message.get("result")
                    if isinstance(result, dict):
                        return result
                    raise RuntimeError("The CUDA service returned an invalid result.")
                if event == "error":
                    raise RuntimeError(
                        safe_error_message(
                            message.get("message") or "The CUDA service request failed.",
                            limit=1000,
                        )
                    )
                if event in {"closed", "protocol-error"}:
                    tail = self._log_tail()
                    self._stop_unlocked()
                    raise RuntimeError(
                        "The persistent CUDA service stopped unexpectedly. "
                        + safe_error_message(tail or message.get("message"), limit=1000)
                    )


CUDA_SERVICE = CudaServiceClient()
atexit.register(CUDA_SERVICE.close)
