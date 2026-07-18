from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .security import safe_error_message
from .storage_paths import cuda_runtime_python


@dataclass(frozen=True, slots=True)
class CudaGenerationResult:
    source_peak: float
    output_peak: float
    peak_protection_applied: bool
    peak_attenuation_db: float


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


def run_cuda_generation(
    *,
    prompt: str,
    duration: float,
    seed: int,
    output_path: Path,
    progress,
    cancelled,
) -> CudaGenerationResult:
    python = cuda_runtime_python()
    if python is None:
        raise RuntimeError(
            "The isolated Windows CUDA/FlashAttention runtime is not verified."
        )

    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    work_dir = Path(tempfile.mkdtemp(prefix="vibeseq-cuda-", dir=output_path.parent))
    progress_path = work_dir / "progress.json"
    metadata_path = work_dir / "result.json"
    log_path = work_dir / "runtime.log"
    command = [
        str(python),
        "-m",
        "vibeseq_inference.stable_audio_cuda_worker",
        "--prompt",
        prompt,
        "--seconds",
        str(duration),
        "--seed",
        str(seed),
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
            )
            while process.poll() is None:
                if cancelled():
                    _terminate(process)
                    from .providers.base import JobCancelled

                    raise JobCancelled("Generation was cancelled.")
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
                    "Stable Audio 3 medium CUDA/FlashAttention runtime failed: "
                    + safe_error_message(tail, limit=1000)
                )
        metadata = _read_json(metadata_path)
        if metadata is None or not output_path.is_file():
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-2000:]
            raise RuntimeError(
                "Stable Audio 3 medium CUDA runtime did not produce a complete "
                "result. "
                + safe_error_message(tail, limit=600)
            )
        return CudaGenerationResult(
            source_peak=float(metadata["sourcePeak"]),
            output_peak=float(metadata["outputPeak"]),
            peak_protection_applied=bool(metadata["peakProtectionApplied"]),
            peak_attenuation_db=float(metadata["peakAttenuationDb"]),
        )
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
