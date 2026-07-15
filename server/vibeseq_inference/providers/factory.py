from __future__ import annotations

from ..config import Settings
from .base import GenerationProvider, TranscriptionProvider
from .muscriptor import MuScriptorProvider
from .procedural import ProceduralDemoProvider
from .signal import SignalDemoProvider
from .stable_audio import StableAudio3Provider


def generation_provider(name: str, settings: Settings) -> GenerationProvider:
    if name == "procedural-demo":
        return ProceduralDemoProvider()
    if name == "stable-audio-3":
        return StableAudio3Provider(
            settings.stable_audio_model,
            target=settings.target,
            enable_provisional_t4=settings.enable_provisional_t4,
            force_cpu=settings.force_cpu,
        )
    raise ValueError(f"Unsupported generation provider: {name}")


def transcription_provider(name: str, settings: Settings) -> TranscriptionProvider:
    if name == "signal-demo":
        return SignalDemoProvider()
    if name == "muscriptor":
        return MuScriptorProvider(
            settings.muscriptor_model,
            force_cpu=settings.force_cpu,
        )
    raise ValueError(f"Unsupported transcription provider: {name}")
