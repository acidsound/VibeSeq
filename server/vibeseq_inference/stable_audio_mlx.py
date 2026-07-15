from __future__ import annotations

import json
import math
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
from platformdirs import user_cache_path

from .model_manifest import STABLE_AUDIO_3_MEDIUM_OPTIMIZED
from .security import safe_error_message


_SOURCE_URL = "https://github.com/Stability-AI/stable-audio-3.git"
_SOURCE_MARKER = ".vibeseq-source.json"
_WEIGHT_LINKS = {
    "MLX/dit_medium_f16.npz": "dit_medium_f16.npz",
    "MLX/same_l_decoder_f32.npz": "same_l_decoder_f32.npz",
    "MLX/t5gemma_f16.npz": "t5gemma_f16.npz",
}
_BOOTSTRAP_LOCK = threading.Lock()


@dataclass(frozen=True, slots=True)
class MlxGenerationResult:
    source_peak: float
    output_peak: float
    peak_protection_applied: bool
    peak_attenuation_db: float
    steps: int


def runtime_checkout() -> Path:
    revision = STABLE_AUDIO_3_MEDIUM_OPTIMIZED.code_revision
    if revision is None:
        raise RuntimeError("Stable Audio MLX code revision is not pinned.")
    return (
        Path(user_cache_path("VibeSeq", appauthor=False))
        / "model-runtimes"
        / "stable-audio-3"
        / revision
    )


def runtime_root() -> Path:
    return runtime_checkout() / "optimized" / "mlx"


def source_checkout_cached() -> bool:
    """Return whether the shared upstream checkout is the exact pinned source."""

    checkout = runtime_checkout()
    marker = checkout / _SOURCE_MARKER
    try:
        value = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return False
    return bool(
        (checkout / ".git").is_dir()
        and value.get("repository") == _SOURCE_URL
        and value.get("revision") == STABLE_AUDIO_3_MEDIUM_OPTIMIZED.code_revision
    )


def mlx_code_cached() -> bool:
    entrypoint = runtime_root() / "scripts" / "sa3_mlx.py"
    return source_checkout_cached() and entrypoint.is_file()


def _run_checked(command: list[str], *, cwd: Path | None = None) -> str:
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            check=True,
            capture_output=True,
            text=True,
            timeout=180,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            "git is required once to install the exact Stable Audio 3 runtime source."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Stable Audio 3 source bootstrap timed out.") from exc
    except subprocess.CalledProcessError as exc:
        detail = safe_error_message(exc.stderr or exc.stdout or str(exc), limit=500)
        raise RuntimeError(f"Stable Audio 3 source bootstrap failed: {detail}") from exc
    return completed.stdout.strip()


def _install_exact_source() -> None:
    checkout = runtime_checkout()
    if source_checkout_cached():
        return
    checkout.parent.mkdir(parents=True, exist_ok=True)
    temporary = checkout.with_name(f".{checkout.name}.{uuid.uuid4().hex}.tmp")
    shutil.rmtree(temporary, ignore_errors=True)
    try:
        _run_checked(
            [
                "git",
                "clone",
                "--filter=blob:none",
                "--no-checkout",
                _SOURCE_URL,
                str(temporary),
            ]
        )
        revision = STABLE_AUDIO_3_MEDIUM_OPTIMIZED.code_revision
        assert revision is not None
        _run_checked(["git", "checkout", "--detach", revision], cwd=temporary)
        resolved = _run_checked(["git", "rev-parse", "HEAD"], cwd=temporary)
        if resolved != revision:
            raise RuntimeError(
                "Stable Audio 3 MLX checkout did not resolve to the pinned revision."
            )
        marker = {
            "repository": _SOURCE_URL,
            "revision": revision,
        }
        (temporary / _SOURCE_MARKER).write_text(
            json.dumps(marker, sort_keys=True, separators=(",", ":")),
            encoding="utf-8",
        )
        if checkout.exists():
            shutil.rmtree(checkout)
        os.replace(temporary, checkout)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def ensure_pinned_source_checkout() -> Path:
    """Install once and return the source shared by the MLX and TFLite routes."""

    with _BOOTSTRAP_LOCK:
        _install_exact_source()
    return runtime_checkout()


def _link_exact_weights() -> None:
    target_dir = runtime_root() / "models" / "mlx"
    target_dir.mkdir(parents=True, exist_ok=True)
    artifact = STABLE_AUDIO_3_MEDIUM_OPTIMIZED
    for remote_name, local_name in _WEIGHT_LINKS.items():
        cached = Path(
            hf_hub_download(
                repo_id=artifact.model_id,
                filename=remote_name,
                revision=artifact.model_revision,
            )
        )
        target = target_dir / local_name
        if target.exists() and target.resolve() == cached.resolve():
            continue
        temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
        temporary.unlink(missing_ok=True)
        temporary.symlink_to(cached)
        os.replace(temporary, target)


def ensure_mlx_runtime() -> Path:
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


def run_mlx_generation(
    *,
    prompt: str,
    duration: float,
    seed: int,
    output_path: Path,
    progress,
    cancelled,
    steps: int = 8,
) -> MlxGenerationResult:
    root = ensure_mlx_runtime()
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    work_dir = Path(tempfile.mkdtemp(prefix="vibeseq-mlx-", dir=output_path.parent))
    progress_path = work_dir / "progress.json"
    metadata_path = work_dir / "result.json"
    log_path = work_dir / "runtime.log"
    command = [
        sys.executable,
        "-m",
        "vibeseq_inference.stable_audio_mlx_worker",
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
                    "Stable Audio 3 medium MLX runtime failed: "
                    + safe_error_message(tail, limit=1000)
                )
        metadata = _read_json(metadata_path)
        if metadata is None or not output_path.is_file():
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-2000:]
            raise RuntimeError(
                "Stable Audio 3 medium MLX runtime did not produce a complete result. "
                + safe_error_message(tail, limit=600)
            )
        return MlxGenerationResult(
            source_peak=float(metadata["sourcePeak"]),
            output_peak=float(metadata["outputPeak"]),
            peak_protection_applied=bool(metadata["peakProtectionApplied"]),
            peak_attenuation_db=float(metadata["peakAttenuationDb"]),
            steps=int(metadata["steps"]),
        )
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def peak_target_linear(decibels_full_scale: float = -0.18) -> float:
    return math.pow(10.0, decibels_full_scale / 20.0)
