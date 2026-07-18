from __future__ import annotations

import math
import threading
from pathlib import Path
from typing import Any

from ..devices import available_devices, muscriptor_runtime_route
from ..model_manifest import MUSCRIPTOR_MEDIUM
from ..models import NoteResult
from ..muscriptor_cuda import run_cuda_transcription
from .base import (
    JobCancelled,
    ProviderError,
    ProviderUnavailable,
    TranscriptionArtifact,
)
from .stable_audio import _short_error


_MUSCRIPTOR_SAMPLE_RATE = 16_000
# MuScriptor's centered 2048-sample STFT and fixed five-second model window have
# no left context when an onset is placed at input sample zero. Half a second
# supplies silence-only context without leaking audio outside the selected clip;
# this duration recovered the boundary onset in the pinned medium-model probe.
_MUSCRIPTOR_ZERO_PREROLL_SECONDS = 0.5
_EVENT_TIME_EPSILON_SECONDS = 1e-9


def _prepare_audio_with_zero_preroll(input_path: Path):
    try:
        import torch
        from muscriptor.utils.audio import load_audio
    except ImportError as exc:
        raise ProviderUnavailable(
            "MuScriptor audio preparation requires its pinned torch runtime."
        ) from exc

    try:
        waveform = load_audio(input_path, target_sr=_MUSCRIPTOR_SAMPLE_RATE)
    except Exception as exc:
        raise ProviderError(
            f"MuScriptor could not decode the selected audio ({_short_error(exc)})."
        ) from exc
    if waveform.shape[-1] <= 0:
        raise ProviderError("MuScriptor cannot transcribe empty audio.")

    preroll_frames = round(_MUSCRIPTOR_ZERO_PREROLL_SECONDS * _MUSCRIPTOR_SAMPLE_RATE)
    silence = torch.zeros(
        (*waveform.shape[:-1], preroll_frames),
        dtype=waveform.dtype,
        device=waveform.device,
    )
    padded = torch.cat((silence, waveform), dim=-1)
    return (
        (padded, _MUSCRIPTOR_SAMPLE_RATE),
        waveform.shape[-1] / _MUSCRIPTOR_SAMPLE_RATE,
    )


def _restore_event_timeline(
    events: list[Any],
    original_duration_seconds: float,
) -> list[Any]:
    """Remove synthetic pre-roll time from both JSON notes and MIDI events."""
    corrected_by_start: dict[int, tuple[float, float]] = {}
    for event in events:
        start_event = getattr(event, "start_event", None)
        end_time = getattr(event, "end_time", None)
        if start_event is None or end_time is None:
            continue
        raw_start = float(start_event.start_time)
        raw_end = float(end_time)
        if not math.isfinite(raw_start) or not math.isfinite(raw_end):
            continue
        start_time = max(
            0.0,
            round(raw_start - _MUSCRIPTOR_ZERO_PREROLL_SECONDS, 9),
        )
        end_value = min(
            original_duration_seconds,
            max(0.0, round(raw_end - _MUSCRIPTOR_ZERO_PREROLL_SECONDS, 9)),
        )
        if end_value - start_time <= _EVENT_TIME_EPSILON_SECONDS:
            continue
        corrected_by_start[id(start_event)] = (start_time, end_value)

    corrected: list[Any] = []
    for event in events:
        start_event = getattr(event, "start_event", None)
        if start_event is not None:
            timing = corrected_by_start.get(id(start_event))
            if timing is None:
                continue
            start_event.start_time, event.end_time = timing
            corrected.append(event)
            continue
        if hasattr(event, "start_time"):
            timing = corrected_by_start.get(id(event))
            if timing is None:
                continue
            event.start_time = timing[0]
        corrected.append(event)
    return corrected


def _transcribe_loaded_model(
    model,
    prepared_audio,
    original_duration_seconds: float,
    output_path: Path,
    progress,
    cancelled,
) -> list[NoteResult]:
    events = []
    for event in model.transcribe(prepared_audio):
        if cancelled():
            raise JobCancelled("Transcription was cancelled.")
        events.append(event)
        completed = getattr(event, "completed", None)
        total = getattr(event, "total", None)
        if completed is not None and total:
            progress(0.2 + 0.65 * completed / total)

    corrected_events = _restore_event_timeline(events, original_duration_seconds)
    notes: list[NoteResult] = []
    for event in corrected_events:
        start_event = getattr(event, "start_event", None)
        end_time = getattr(event, "end_time", None)
        if start_event is None or end_time is None:
            continue
        start_time = float(start_event.start_time)
        end_value = float(end_time)
        if end_value <= start_time:
            continue
        notes.append(
            NoteResult(
                pitch=int(start_event.pitch),
                start_time=start_time,
                end_time=end_value,
                velocity=100,
                instrument=str(start_event.instrument).replace("_", " "),
            )
        )
    output_path.write_bytes(model.events_to_midi_bytes(iter(corrected_events)))
    return notes


class MuScriptorProvider:
    name = "muscriptor"

    def __init__(self, model_name: str, *, force_cpu: bool = False) -> None:
        if model_name != "medium":
            raise ValueError(
                "MuScriptorProvider only accepts the medium model; small-model "
                "fallback is forbidden."
            )
        self.model_name = model_name
        self.force_cpu = force_cpu
        self._models: dict[str, object] = {}
        self._weights_path: str | None = None
        self._lock = threading.RLock()

    @staticmethod
    def _import_model():
        try:
            from muscriptor import TranscriptionModel
        except ImportError as exc:
            raise ProviderUnavailable(
                "MuScriptor is not installed. Install the server's 'muscriptor' "
                "optional dependency and accept/authenticate the model license "
                "before selecting provider 'muscriptor'."
            ) from exc
        return TranscriptionModel

    def _load(self, device: str):
        with self._lock:
            if device in self._models:
                return self._models[device]
            model_class = self._import_model()
            try:
                from huggingface_hub import hf_hub_download
            except ImportError as exc:
                raise ProviderUnavailable(
                    "huggingface-hub is required to resolve the exact MuScriptor "
                    "medium revision."
                ) from exc
            artifact = MUSCRIPTOR_MEDIUM
            if self._weights_path is None:
                # Download the config into the same exact snapshot before loading
                # the local checkpoint; MuScriptor then reads the matching model.
                hf_hub_download(
                    repo_id=artifact.model_id,
                    filename="config.json",
                    revision=artifact.model_revision,
                )
                self._weights_path = hf_hub_download(
                    repo_id=artifact.model_id,
                    filename="model.safetensors",
                    revision=artifact.model_revision,
                )
            model = model_class.load_model(self._weights_path, device=device)
            self._models[device] = model
            return model

    def _evict(self, device: str) -> None:
        with self._lock:
            self._models.pop(device, None)
        try:
            import torch

            if device == "cuda" and torch.cuda.is_available():
                torch.cuda.empty_cache()
            mps = getattr(torch, "mps", None)
            if device == "mps" and mps is not None:
                mps.empty_cache()
        except (ImportError, RuntimeError):
            pass

    def _devices(self) -> list[str]:
        return available_devices(force_cpu=self.force_cpu)

    def _route(self):
        return muscriptor_runtime_route(force_cpu=self.force_cpu)

    def transcribe(
        self,
        input_path: Path,
        output_path: Path,
        progress,
        cancelled,
    ) -> TranscriptionArtifact:
        route = self._route()
        if route.isolated:
            if not route.runtime_compatible:
                raise ProviderUnavailable(
                    route.reason
                    or "The managed VibeSeq CUDA runtime for MuScriptor is unavailable."
                )
            result = run_cuda_transcription(
                input_path=input_path,
                output_path=output_path,
                progress=progress,
                cancelled=cancelled,
            )
            actual_device = result.device
            return TranscriptionArtifact(
                notes=result.notes,
                provider=self.name,
                device=actual_device,
                model=MUSCRIPTOR_MEDIUM.model,
                model_id=MUSCRIPTOR_MEDIUM.model_id,
                model_revision=MUSCRIPTOR_MEDIUM.model_revision,
                code_revision=MUSCRIPTOR_MEDIUM.code_revision,
                runtime=("pytorch-cuda" if actual_device == "cuda" else "pytorch-cpu"),
                route=("cuda-pytorch" if actual_device == "cuda" else "cpu-pytorch"),
            )

        self._import_model()
        if cancelled():
            raise JobCancelled("Transcription was cancelled.")
        prepared_audio, original_duration_seconds = _prepare_audio_with_zero_preroll(
            input_path
        )
        failures: list[str] = []
        devices = self._devices()
        for index, device in enumerate(devices):
            if cancelled():
                raise JobCancelled("Transcription was cancelled.")
            progress(0.04 + 0.12 * index / max(1, len(devices)))
            try:
                model = self._load(device)
                progress(0.2)
                notes = _transcribe_loaded_model(
                    model,
                    prepared_audio,
                    original_duration_seconds,
                    output_path,
                    progress,
                    cancelled,
                )
                progress(0.98)
                return TranscriptionArtifact(
                    notes=notes,
                    provider=self.name,
                    device=device,
                    model=MUSCRIPTOR_MEDIUM.model,
                    model_id=MUSCRIPTOR_MEDIUM.model_id,
                    model_revision=MUSCRIPTOR_MEDIUM.model_revision,
                    code_revision=MUSCRIPTOR_MEDIUM.code_revision,
                    runtime={
                        "cuda": "pytorch-cuda",
                        "mps": "pytorch-mps",
                        "cpu": "pytorch-cpu",
                    }[device],
                    route={
                        "cuda": "cuda-pytorch",
                        "mps": "apple-mps",
                        "cpu": "cpu-pytorch",
                    }[device],
                )
            except JobCancelled:
                raise
            except ProviderUnavailable:
                raise
            except Exception as exc:
                failures.append(f"{device} ({_short_error(exc)})")
                self._evict(device)

        raise ProviderUnavailable(
            f"MuScriptor model '{self.model_name}' failed on all available devices "
            f"({'; '.join(failures)}). No demo provider was substituted."
        )
