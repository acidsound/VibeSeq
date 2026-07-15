from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from huggingface_hub import hf_hub_download

from .model_manifest import STABLE_AUDIO_3_MEDIUM_OPTIMIZED
from .security import safe_error_message
from .stable_audio_mlx import (
    ensure_pinned_source_checkout,
    runtime_checkout,
    source_checkout_cached,
)


_WEIGHT_LINKS = {
    "tflite/sa3-m/dit_w8a8-dyn.tflite": ("models/tflite/sa3-m/dit_w8a8-dyn.tflite"),
    "tflite/same-l/dec_w8a8-dyn.tflite": ("models/tflite/same-l/dec_w8a8-dyn.tflite"),
    "tflite/t5gemma/encoder_fp16.tflite": ("models/tflite/t5gemma/encoder_fp16.tflite"),
}
_BOOTSTRAP_LOCK = threading.Lock()


@dataclass(frozen=True, slots=True)
class TfliteGenerationResult:
    source_peak: float
    output_peak: float
    peak_protection_applied: bool
    peak_attenuation_db: float
    steps: int
    precision: str
    threads: int


def runtime_root() -> Path:
    return runtime_checkout() / "optimized" / "tflite"


def tflite_code_cached() -> bool:
    root = runtime_root()
    return bool(
        source_checkout_cached()
        and (root / "scripts" / "sa3_tflite.py").is_file()
        and (root / "models" / "tokenizer.model").is_file()
    )


def _materialize_exact_weight(cached: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        if target.exists() and target.resolve() == cached.resolve():
            return
    except OSError:
        pass

    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    temporary.unlink(missing_ok=True)
    try:
        try:
            temporary.symlink_to(cached)
        except OSError:
            try:
                os.link(cached, temporary)
            except OSError:
                shutil.copy2(cached, temporary)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def _link_exact_weights() -> None:
    artifact = STABLE_AUDIO_3_MEDIUM_OPTIMIZED
    root = runtime_root()
    for remote_name, local_name in _WEIGHT_LINKS.items():
        cached = Path(
            hf_hub_download(
                repo_id=artifact.model_id,
                filename=remote_name,
                revision=artifact.model_revision,
            )
        )
        _materialize_exact_weight(cached, root / local_name)


def ensure_tflite_runtime() -> Path:
    ensure_pinned_source_checkout()
    with _BOOTSTRAP_LOCK:
        _link_exact_weights()
    return runtime_root()


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
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


def run_tflite_generation(
    *,
    prompt: str,
    duration: float,
    seed: int,
    output_path: Path,
    progress,
    cancelled,
    steps: int = 8,
    threads: int | None = None,
) -> TfliteGenerationResult:
    """Run the exact official medium CPU graphs in an interruptible process."""

    root = ensure_tflite_runtime()
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    work_dir = Path(tempfile.mkdtemp(prefix="vibeseq-tflite-", dir=output_path.parent))
    progress_path = work_dir / "progress.json"
    metadata_path = work_dir / "result.json"
    log_path = work_dir / "runtime.log"
    thread_count = threads or min(8, max(1, os.cpu_count() or 1))
    command = [
        sys.executable,
        "-m",
        "vibeseq_inference.stable_audio_tflite_worker",
        "--runtime-root",
        str(root),
        "--prompt",
        prompt,
        "--seconds",
        str(duration),
        "--seed",
        str(seed),
        "--steps",
        str(steps),
        "--threads",
        str(thread_count),
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
                    "Stable Audio 3 medium TFLite runtime failed: "
                    + safe_error_message(tail, limit=1000)
                )
        metadata = _read_json(metadata_path)
        if metadata is None or not output_path.is_file():
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-2000:]
            raise RuntimeError(
                "Stable Audio 3 medium TFLite runtime did not produce a complete "
                "result. " + safe_error_message(tail, limit=600)
            )
        return TfliteGenerationResult(
            source_peak=float(metadata["sourcePeak"]),
            output_peak=float(metadata["outputPeak"]),
            peak_protection_applied=bool(metadata["peakProtectionApplied"]),
            peak_attenuation_db=float(metadata["peakAttenuationDb"]),
            steps=int(metadata["steps"]),
            precision=str(metadata["precision"]),
            threads=int(metadata["threads"]),
        )
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
