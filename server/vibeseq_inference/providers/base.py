from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from ..models import GenerateRequest, NoteResult


ProgressCallback = Callable[[float], None]
CancelCallback = Callable[[], bool]


class ProviderError(RuntimeError):
    pass


class ProviderUnavailable(ProviderError):
    pass


class JobCancelled(ProviderError):
    pass


@dataclass(slots=True)
class GenerationArtifact:
    duration: float
    sample_rate: int
    provider: str
    device: str
    peaks: list[float]
    model: str | None = None
    model_id: str | None = None
    model_revision: str | None = None
    code_revision: str | None = None
    runtime: str | None = None
    route: str | None = None
    source_peak: float | None = None
    output_peak: float | None = None
    peak_protection_applied: bool = False
    peak_attenuation_db: float = 0.0


@dataclass(slots=True)
class TranscriptionArtifact:
    notes: list[NoteResult]
    provider: str
    device: str
    model: str | None = None
    model_id: str | None = None
    model_revision: str | None = None
    code_revision: str | None = None
    runtime: str | None = None
    route: str | None = None


class GenerationProvider(Protocol):
    name: str

    def generate(
        self,
        request: GenerateRequest,
        output_path: Path,
        progress: ProgressCallback,
        cancelled: CancelCallback,
    ) -> GenerationArtifact: ...


class TranscriptionProvider(Protocol):
    name: str

    def transcribe(
        self,
        input_path: Path,
        output_path: Path,
        progress: ProgressCallback,
        cancelled: CancelCallback,
    ) -> TranscriptionArtifact: ...
