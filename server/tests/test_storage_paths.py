from __future__ import annotations

from pathlib import Path

from vibeseq_inference.storage_paths import (
    model_cache_dir,
    model_config_dir,
    model_runtime_dir,
)


def test_vibeseq_home_owns_model_runtime_and_config_paths(
    tmp_path: Path, monkeypatch
) -> None:
    root = tmp_path / "VibeSeq Data"
    monkeypatch.setenv("VIBESEQ_HOME", str(root))
    monkeypatch.delenv("VIBESEQ_RUNTIME_DIR", raising=False)

    assert model_runtime_dir() == root / "runtimes"
    assert model_config_dir() == root / "cache" / "model-configs"
    assert model_cache_dir() == root / "models" / "huggingface" / "hub"


def test_explicit_runtime_path_overrides_vibeseq_home(
    tmp_path: Path, monkeypatch
) -> None:
    root = tmp_path / "VibeSeq Data"
    runtime = tmp_path / "external-runtime"
    monkeypatch.setenv("VIBESEQ_HOME", str(root))
    monkeypatch.setenv("VIBESEQ_RUNTIME_DIR", str(runtime))

    assert model_runtime_dir() == runtime


def test_explicit_hugging_face_cache_path_is_reported(
    tmp_path: Path, monkeypatch
) -> None:
    cache = tmp_path / "model-cache"
    monkeypatch.setenv("HUGGINGFACE_HUB_CACHE", str(cache))

    assert model_cache_dir() == cache
