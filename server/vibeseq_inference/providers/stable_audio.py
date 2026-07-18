from __future__ import annotations

import math
import threading
from pathlib import Path

import numpy as np

from ..audio import peak_envelope, read_wave, write_pcm16_wave
from ..devices import RuntimeRoute, stable_audio_execution_routes
from ..model_manifest import MODEL_MANIFEST
from ..models import GenerateRequest
from ..security import safe_error_message
from ..stable_audio_config import (
    install_pinned_model_config as _install_pinned_model_config,
    pinned_stable_audio_files,
)
from ..stable_audio_cuda import run_cuda_generation
from ..stable_audio_mlx import run_mlx_generation
from ..stable_audio_tflite import run_tflite_generation
from ..storage_paths import cuda_runtime_python
from .base import (
    GenerationArtifact,
    JobCancelled,
    ProviderError,
    ProviderUnavailable,
)


def _short_error(exc: BaseException) -> str:
    text = safe_error_message(exc, limit=260)
    return f"{type(exc).__name__}: {text}"[:300]


def _pinned_stable_audio_files() -> tuple[str, str]:
    """Compatibility entrypoint for tests and external server integrations."""

    return pinned_stable_audio_files()


class StableAudio3Provider:
    name = "stable-audio-3"

    def __init__(
        self,
        model_name: str,
        *,
        target: str = "local",
        enable_provisional_t4: bool = False,
        force_cpu: bool = False,
    ) -> None:
        if model_name != "medium":
            raise ValueError(
                "StableAudio3Provider only accepts the medium model; small-model "
                "fallback is forbidden."
            )
        self.model_name = model_name
        self.target = target
        self.enable_provisional_t4 = enable_provisional_t4
        self.force_cpu = force_cpu
        self._models: dict[str, object] = {}
        self._lock = threading.RLock()

    def _routes(self) -> tuple[RuntimeRoute, ...]:
        return stable_audio_execution_routes(
            self.target,
            enable_provisional_t4=self.enable_provisional_t4,
            force_cpu=self.force_cpu,
        )

    def _load(self, route: RuntimeRoute):
        with self._lock:
            if route.id in self._models:
                return self._models[route.id]
            try:
                from stable_audio_3 import StableAudioModel
            except ImportError as exc:
                raise ProviderUnavailable(
                    "Stable Audio 3 is not installed. Install the server's "
                    "'stable-audio' optional dependency and accept/authenticate "
                    "the medium model license before selecting provider "
                    "'stable-audio-3'."
                ) from exc
            if route.id == "cuda-ampere-fa2":
                try:
                    from flash_attn import flash_attn_func, flash_attn_kvpacked_func
                except (ImportError, OSError, RuntimeError) as exc:
                    raise ProviderUnavailable(
                        "The Ampere Stable Audio 3 medium route requires a "
                        "loadable FlashAttention 2 CUDA extension."
                    ) from exc
                if not callable(flash_attn_func) or not callable(
                    flash_attn_kvpacked_func
                ):
                    raise ProviderUnavailable(
                        "The bundled FlashAttention 2 extension is incomplete."
                    )
            _install_pinned_model_config()
            model = StableAudioModel.from_pretrained(
                "medium",
                device=route.device,
                model_half=route.device == "cuda",
            )
            self._models[route.id] = model
            return model

    def _evict(self, route: RuntimeRoute) -> None:
        with self._lock:
            self._models.pop(route.id, None)
        try:
            import torch

            if route.device == "cuda" and torch.cuda.is_available():
                torch.cuda.empty_cache()
        except (ImportError, RuntimeError):
            pass

    def generate(
        self,
        request: GenerateRequest,
        output_path: Path,
        progress,
        cancelled,
    ) -> GenerationArtifact:
        failures: list[str] = []
        routes = self._routes()
        if not routes:
            raise ProviderUnavailable(
                "No implemented Stable Audio 3 medium route is executable on "
                "this machine. Check /api/health for the MLX, CUDA, T4 SDPA, "
                "and TFLite route states. No small or demo model was substituted."
            )

        for index, route in enumerate(routes):
            if cancelled():
                raise JobCancelled("Generation was cancelled.")
            progress(0.05 + 0.12 * index / max(1, len(routes)))
            try:
                if route.id == "cuda-ampere-fa2" and cuda_runtime_python() is not None:
                    result = run_cuda_generation(
                        prompt=(
                            request.prompt
                            if "bpm" in request.prompt.lower()
                            else f"{request.prompt}, {request.bpm:g} BPM"
                        ),
                        duration=request.duration,
                        seed=request.seed,
                        output_path=output_path,
                        progress=progress,
                        cancelled=cancelled,
                    )
                    audio, sample_rate = read_wave(output_path)
                    sample_count = audio.shape[-1]
                    artifact = MODEL_MANIFEST[route.artifact_key]
                    return GenerationArtifact(
                        duration=sample_count / sample_rate,
                        sample_rate=sample_rate,
                        provider=self.name,
                        device=route.device,
                        peaks=peak_envelope(audio),
                        model=artifact.model,
                        model_id=artifact.model_id,
                        model_revision=artifact.model_revision,
                        code_revision=artifact.code_revision,
                        runtime=route.runtime,
                        route=route.id,
                        source_peak=result.source_peak,
                        output_peak=result.output_peak,
                        peak_protection_applied=result.peak_protection_applied,
                        peak_attenuation_db=result.peak_attenuation_db,
                    )
                if route.id == "apple-mlx":
                    result = run_mlx_generation(
                        prompt=(
                            request.prompt
                            if "bpm" in request.prompt.lower()
                            else f"{request.prompt}, {request.bpm:g} BPM"
                        ),
                        duration=request.duration,
                        seed=request.seed,
                        output_path=output_path,
                        progress=progress,
                        cancelled=cancelled,
                    )
                    audio, sample_rate = read_wave(output_path)
                    sample_count = audio.shape[-1]
                    artifact = MODEL_MANIFEST[route.artifact_key]
                    return GenerationArtifact(
                        duration=sample_count / sample_rate,
                        sample_rate=sample_rate,
                        provider=self.name,
                        device=route.device,
                        peaks=peak_envelope(audio),
                        model=artifact.model,
                        model_id=artifact.model_id,
                        model_revision=artifact.model_revision,
                        code_revision=artifact.code_revision,
                        runtime=route.runtime,
                        route=route.id,
                        source_peak=result.source_peak,
                        output_peak=result.output_peak,
                        peak_protection_applied=result.peak_protection_applied,
                        peak_attenuation_db=result.peak_attenuation_db,
                    )
                if route.id == "cpu-tflite":
                    result = run_tflite_generation(
                        prompt=(
                            request.prompt
                            if "bpm" in request.prompt.lower()
                            else f"{request.prompt}, {request.bpm:g} BPM"
                        ),
                        duration=request.duration,
                        seed=request.seed,
                        output_path=output_path,
                        progress=progress,
                        cancelled=cancelled,
                    )
                    audio, sample_rate = read_wave(output_path)
                    sample_count = audio.shape[-1]
                    artifact = MODEL_MANIFEST[route.artifact_key]
                    return GenerationArtifact(
                        duration=sample_count / sample_rate,
                        sample_rate=sample_rate,
                        provider=self.name,
                        device=route.device,
                        peaks=peak_envelope(audio),
                        model=artifact.model,
                        model_id=artifact.model_id,
                        model_revision=artifact.model_revision,
                        code_revision=artifact.code_revision,
                        runtime=route.runtime,
                        route=route.id,
                        source_peak=result.source_peak,
                        output_peak=result.output_peak,
                        peak_protection_applied=result.peak_protection_applied,
                        peak_attenuation_db=result.peak_attenuation_db,
                    )
                model = self._load(route)
                if cancelled():
                    raise JobCancelled("Generation was cancelled.")
                progress(0.25)
                prompt = request.prompt
                if "bpm" not in prompt.lower():
                    prompt = f"{prompt}, {request.bpm:g} BPM"
                generated = model.generate(
                    prompt=prompt,
                    duration=request.duration,
                    seed=request.seed,
                    chunked_decode=True if route.provisional else None,
                )
                progress(0.88)
                tensor = generated.detach().float().cpu()
                audio = np.asarray(tensor.numpy(), dtype=np.float32)
                if audio.ndim == 3:
                    audio = audio[0]
                if audio.ndim not in {1, 2}:
                    raise ProviderError(
                        f"Stable Audio 3 returned an unexpected shape: {audio.shape}."
                    )
                model_config = getattr(model, "model_config", {})
                sample_rate = int(model_config.get("sample_rate", 44_100))
                source_peak = float(np.max(np.abs(audio))) if audio.size else 0.0
                peak_target = math.pow(10.0, -0.18 / 20.0)
                gain = min(1.0, peak_target / source_peak) if source_peak > 0 else 1.0
                protected_audio = audio * gain
                write_pcm16_wave(output_path, protected_audio, sample_rate)
                progress(0.98)
                sample_count = audio.shape[-1]
                artifact = MODEL_MANIFEST[route.artifact_key]
                return GenerationArtifact(
                    duration=sample_count / sample_rate,
                    sample_rate=sample_rate,
                    provider=self.name,
                    device=route.device,
                    peaks=peak_envelope(protected_audio),
                    model=artifact.model,
                    model_id=artifact.model_id,
                    model_revision=artifact.model_revision,
                    code_revision=artifact.code_revision,
                    runtime=route.runtime,
                    route=route.id,
                    source_peak=source_peak,
                    output_peak=source_peak * gain,
                    peak_protection_applied=gain < 1.0,
                    peak_attenuation_db=round(-20.0 * math.log10(gain), 6),
                )
            except JobCancelled:
                raise
            except Exception as exc:
                failures.append(f"{route.id} ({_short_error(exc)})")
                self._evict(route)
                if route.id == "cuda-ampere-fa2":
                    raise ProviderUnavailable(
                        "Stable Audio 3 medium failed on the required "
                        "FlashAttention 2 CUDA route "
                        f"({failures[-1]}). CPU fallback is disabled on "
                        "FlashAttention-compatible NVIDIA hardware."
                    ) from exc

        raise ProviderUnavailable(
            "Stable Audio 3 medium failed on every executable route "
            f"({'; '.join(failures)}). No small or demo model was substituted."
        )
