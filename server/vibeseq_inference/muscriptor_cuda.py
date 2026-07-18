from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from .models import NoteResult
from .security import safe_error_message
from .storage_paths import cuda_runtime_python


def _worker_creation_flags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _terminate(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def run_cuda_transcription(
    *,
    input_path: Path,
    output_path: Path,
    progress,
    cancelled,
) -> list[NoteResult]:
    python = cuda_runtime_python(require_flash_attention=False)
    if python is None:
        raise RuntimeError("The managed VibeSeq CUDA runtime is not verified.")

    input_path = input_path.resolve()
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    work_dir = Path(
        tempfile.mkdtemp(prefix="vibeseq-muscriptor-cuda-", dir=output_path.parent)
    )
    progress_path = work_dir / "progress.json"
    metadata_path = work_dir / "result.json"
    log_path = work_dir / "runtime.log"
    command = [
        str(python),
        "-m",
        "vibeseq_inference.muscriptor_cuda_worker",
        "--input",
        str(input_path),
        "--out",
        str(output_path),
        "--progress",
        str(progress_path),
        "--metadata",
        str(metadata_path),
    ]
    environment = os.environ.copy()
    environment["PYTHONUNBUFFERED"] = "1"
    progress(0.04)
    try:
        with log_path.open("w", encoding="utf-8") as log:
            process = subprocess.Popen(
                command,
                stdout=log,
                stderr=subprocess.STDOUT,
                text=True,
                env=environment,
                creationflags=_worker_creation_flags(),
            )
            while process.poll() is None:
                if cancelled():
                    _terminate(process)
                    from .providers.base import JobCancelled

                    raise JobCancelled("Transcription was cancelled.")
                state = _read_json(progress_path)
                if state is not None:
                    try:
                        progress(float(state["progress"]))
                    except (KeyError, TypeError, ValueError):
                        pass
                time.sleep(0.05)
            if process.returncode != 0:
                tail = log_path.read_text(encoding="utf-8", errors="replace")[-4000:]
                raise RuntimeError(
                    "MuScriptor medium CUDA runtime failed: "
                    + safe_error_message(tail, limit=1000)
                )
        metadata = _read_json(metadata_path)
        if metadata is None or not output_path.is_file():
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-2000:]
            raise RuntimeError(
                "MuScriptor medium CUDA runtime did not produce a complete result. "
                + safe_error_message(tail, limit=600)
            )
        raw_notes = metadata.get("notes")
        if not isinstance(raw_notes, list):
            raise RuntimeError("MuScriptor CUDA metadata did not contain notes.")
        return [NoteResult.model_validate(note) for note in raw_notes]
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
