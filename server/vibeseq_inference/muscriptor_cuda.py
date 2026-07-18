from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .cuda_service_client import CUDA_SERVICE, _worker_creation_flags
from .models import NoteResult
from .storage_paths import cuda_runtime_python


@dataclass(frozen=True, slots=True)
class CudaTranscriptionResult:
    notes: list[NoteResult]
    device: str


def run_cuda_transcription(
    *,
    input_path: Path,
    output_path: Path,
    progress,
    cancelled,
) -> CudaTranscriptionResult:
    python = cuda_runtime_python(
        require_flash_attention=False,
        require_muscriptor=True,
    )
    if python is None:
        raise RuntimeError("The managed VibeSeq CUDA runtime is not verified.")
    input_path = input_path.resolve()
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    progress(0.04)
    result = CUDA_SERVICE.request(
        python=python,
        operation="transcribe",
        payload={
            "inputPath": str(input_path),
            "outputPath": str(output_path),
        },
        progress=progress,
        cancelled=cancelled,
    )
    if not output_path.is_file():
        raise RuntimeError("The persistent CUDA service did not produce MIDI.")
    raw_notes = result.get("notes")
    if not isinstance(raw_notes, list):
        raise RuntimeError("MuScriptor CUDA metadata did not contain notes.")
    return CudaTranscriptionResult(
        notes=[NoteResult.model_validate(note) for note in raw_notes],
        device=str(result.get("device") or "cuda"),
    )


__all__ = [
    "CudaTranscriptionResult",
    "run_cuda_transcription",
    "_worker_creation_flags",
]
