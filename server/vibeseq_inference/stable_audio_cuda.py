from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .cuda_service_client import CUDA_SERVICE, _worker_creation_flags
from .storage_paths import cuda_runtime_python


@dataclass(frozen=True, slots=True)
class CudaGenerationResult:
    source_peak: float
    output_peak: float
    peak_protection_applied: bool
    peak_attenuation_db: float


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
    progress(0.04)
    result = CUDA_SERVICE.request(
        python=python,
        operation="generate",
        payload={
            "prompt": prompt,
            "duration": duration,
            "seed": seed,
            "outputPath": str(output_path),
        },
        progress=progress,
        cancelled=cancelled,
    )
    if not output_path.is_file():
        raise RuntimeError("The persistent CUDA service did not produce audio.")
    return CudaGenerationResult(
        source_peak=float(result["sourcePeak"]),
        output_peak=float(result["outputPeak"]),
        peak_protection_applied=bool(result["peakProtectionApplied"]),
        peak_attenuation_db=float(result["peakAttenuationDb"]),
    )


__all__ = [
    "CudaGenerationResult",
    "run_cuda_generation",
    "_worker_creation_flags",
]
