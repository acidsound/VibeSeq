from __future__ import annotations

import os
from pathlib import Path

from platformdirs import user_cache_path, user_data_path


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


def model_config_dir() -> Path:
    home = vibeseq_home()
    if home is not None:
        return home / "cache" / "model-configs"
    return Path(user_cache_path("VibeSeq", appauthor=False)) / "model-configs"
