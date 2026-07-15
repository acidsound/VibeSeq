from __future__ import annotations

from pathlib import Path

import pytest
from uvicorn import Config

from vibeseq_inference.config import Settings


def test_uvicorn_env_file_does_not_override_process_environment(
    tmp_path: Path, monkeypatch
) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "VIBESEQ_GENERATION_PROVIDER=stable-audio-3\n"
        "VIBESEQ_TRANSCRIPTION_PROVIDER=muscriptor\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("VIBESEQ_GENERATION_PROVIDER", "procedural-demo")
    monkeypatch.delenv("VIBESEQ_TRANSCRIPTION_PROVIDER", raising=False)

    Config(lambda: None, env_file=env_file)
    settings = Settings.from_env()

    assert settings.generation_provider == "procedural-demo"
    assert settings.transcription_provider == "muscriptor"


def test_force_cpu_is_loaded_from_env_and_restricted_to_local(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("VIBESEQ_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("VIBESEQ_TARGET", "local")
    monkeypatch.setenv("VIBESEQ_FORCE_CPU", "1")

    assert Settings.from_env().force_cpu is True

    with pytest.raises(ValueError, match="supported only.*TARGET=local"):
        Settings(data_dir=tmp_path, target="colab-t4", force_cpu=True).validate()
