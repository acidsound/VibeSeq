from __future__ import annotations

from ..config import Settings
from .base import GenerationProvider, TranscriptionProvider
from .procedural import ProceduralDemoProvider
from .signal import SignalDemoProvider


def generation_provider(name: str, settings: Settings) -> GenerationProvider:
    if name == "procedural-demo":
        return ProceduralDemoProvider()
    if name == "stable-audio-3":
        from .stable_audio import StableAudio3Provider

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
        from .muscriptor import MuScriptorProvider

        return MuScriptorProvider(
            settings.muscriptor_model,
            force_cpu=settings.force_cpu,
        )
    raise ValueError(f"Unsupported transcription provider: {name}")
