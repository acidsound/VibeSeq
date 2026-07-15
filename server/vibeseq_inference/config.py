from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

GENERATION_PROVIDERS = frozenset({"procedural-demo", "stable-audio-3"})
TRANSCRIPTION_PROVIDERS = frozenset({"signal-demo", "muscriptor"})


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    return default if value is None else int(value)


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean value.")


@dataclass(frozen=True, slots=True)
class Settings:
    data_dir: Path
    target: str = "local"
    generation_provider: str = "procedural-demo"
    transcription_provider: str = "signal-demo"
    max_upload_bytes: int = 200 * 1024 * 1024
    job_workers: int = 1
    studio_dist: Path | None = None
    cors_origins: tuple[str, ...] = ()
    stable_audio_model_override: str | None = None
    muscriptor_model_override: str | None = None
    enable_provisional_t4: bool = False
    force_cpu: bool = False

    @property
    def stable_audio_model(self) -> str:
        return "medium"

    @property
    def muscriptor_model(self) -> str:
        return "medium"

    def validate(self) -> "Settings":
        if self.target not in {"local", "colab-t4", "colab-cuda"}:
            raise ValueError(
                "VIBESEQ_TARGET must be 'local', 'colab-t4', or 'colab-cuda'."
            )
        if self.generation_provider not in GENERATION_PROVIDERS:
            raise ValueError(
                "VIBESEQ_GENERATION_PROVIDER must be 'procedural-demo' or "
                "'stable-audio-3'."
            )
        if self.transcription_provider not in TRANSCRIPTION_PROVIDERS:
            raise ValueError(
                "VIBESEQ_TRANSCRIPTION_PROVIDER must be 'signal-demo' or 'muscriptor'."
            )
        if self.job_workers < 1:
            raise ValueError("VIBESEQ_JOB_WORKERS must be at least 1.")
        if self.force_cpu and self.target != "local":
            raise ValueError(
                "VIBESEQ_FORCE_CPU is supported only when VIBESEQ_TARGET=local."
            )
        if self.stable_audio_model_override not in {None, "medium"}:
            raise ValueError(
                "VIBESEQ_STABLE_AUDIO_MODEL must be 'medium'; VibeSeq does not "
                "silently downgrade generation to a small model."
            )
        if self.muscriptor_model_override not in {None, "medium"}:
            raise ValueError(
                "VIBESEQ_MUSCRIPTOR_MODEL must be 'medium'; VibeSeq does not "
                "silently downgrade transcription to a small model."
            )
        return self

    @classmethod
    def from_env(cls) -> "Settings":
        from .storage_paths import inference_data_dir

        data_dir = inference_data_dir()
        studio_dist = os.getenv("VIBESEQ_STUDIO_DIST")
        origins = tuple(
            item.strip()
            for item in os.getenv("VIBESEQ_CORS_ORIGINS", "").split(",")
            if item.strip()
        )
        return cls(
            data_dir=data_dir,
            target=os.getenv("VIBESEQ_TARGET", "local"),
            generation_provider=os.getenv(
                "VIBESEQ_GENERATION_PROVIDER", "procedural-demo"
            ),
            transcription_provider=os.getenv(
                "VIBESEQ_TRANSCRIPTION_PROVIDER", "signal-demo"
            ),
            max_upload_bytes=_env_int("VIBESEQ_MAX_UPLOAD_BYTES", 200 * 1024 * 1024),
            job_workers=_env_int("VIBESEQ_JOB_WORKERS", 1),
            studio_dist=Path(studio_dist).expanduser() if studio_dist else None,
            cors_origins=origins,
            stable_audio_model_override=os.getenv("VIBESEQ_STABLE_AUDIO_MODEL"),
            muscriptor_model_override=os.getenv("VIBESEQ_MUSCRIPTOR_MODEL"),
            enable_provisional_t4=_env_bool("VIBESEQ_ENABLE_PROVISIONAL_T4"),
            force_cpu=_env_bool("VIBESEQ_FORCE_CPU"),
        ).validate()
