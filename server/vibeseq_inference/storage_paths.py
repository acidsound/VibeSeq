from __future__ import annotations

import os
from pathlib import Path

from platformdirs import user_cache_path, user_data_path


CUDA_RUNTIME_BUNDLE = "windows-cuda-fa2-py312-torch271-cu126-fa283-v1"


def vibeseq_home() -> Path | None:
    configured = os.getenv("VIBESEQ_HOME")
    return Path(configured).expanduser() if configured else None


def inference_data_dir() -> Path:
    configured = os.getenv("VIBESEQ_DATA_DIR")
    if configured:
        return Path(configured).expanduser()
    home = vibeseq_home()
    if home is not None:
        return home / "inference"
    return Path(user_data_path("VibeSeq", appauthor=False)) / "inference"


def model_runtime_dir() -> Path:
    configured = os.getenv("VIBESEQ_RUNTIME_DIR")
    if configured:
        return Path(configured).expanduser()
    home = vibeseq_home()
    if home is not None:
        return home / "runtimes"
    return Path(user_cache_path("VibeSeq", appauthor=False)) / "model-runtimes"


def model_cache_dir() -> Path:
    configured = os.getenv("HUGGINGFACE_HUB_CACHE")
    if configured:
        return Path(configured).expanduser()
    huggingface_home = os.getenv("HF_HOME")
    if huggingface_home:
        return Path(huggingface_home).expanduser() / "hub"
    home = vibeseq_home()
    if home is not None:
        return home / "models" / "huggingface" / "hub"
    return Path(user_cache_path("huggingface", appauthor=False)) / "hub"


def model_config_dir() -> Path:
    home = vibeseq_home()
    if home is not None:
        return home / "cache" / "model-configs"
    return Path(user_cache_path("VibeSeq", appauthor=False)) / "model-configs"


def cuda_runtime_root() -> Path:
    return model_runtime_dir() / CUDA_RUNTIME_BUNDLE


def cuda_runtime_python() -> Path | None:
    root = cuda_runtime_root()
    marker = root / ".vibeseq-runtime.json"
    python = root / "venv" / "Scripts" / "python.exe"
    try:
        import json

        value = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError):
        return None
    expected_project = os.getenv("VIBESEQ_CUDA_RUNTIME_PROJECT_DIGEST")
    if (
        value.get("bundleId") != CUDA_RUNTIME_BUNDLE
        or not expected_project
        or value.get("projectDigest") != expected_project
        or not python.is_file()
    ):
        return None
    return python


def cuda_runtime_ready() -> bool:
    return cuda_runtime_python() is not None
