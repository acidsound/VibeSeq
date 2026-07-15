from __future__ import annotations

import wave
from pathlib import Path

import numpy as np


class AudioFormatError(ValueError):
    pass


def _as_channels_first(audio: np.ndarray) -> np.ndarray:
    value = np.asarray(audio, dtype=np.float32)
    if value.ndim == 1:
        value = value[np.newaxis, :]
    if value.ndim != 2:
        raise AudioFormatError("Audio must have one or two dimensions.")
    if value.shape[0] > 8 and value.shape[1] <= 8:
        value = value.T
    if value.shape[0] > 8:
        raise AudioFormatError("Audio has an unsupported channel layout.")
    return value


def write_pcm16_wave(path: Path, audio: np.ndarray, sample_rate: int) -> None:
    channels_first = _as_channels_first(audio)
    if sample_rate <= 0:
        raise AudioFormatError("Sample rate must be positive.")
    pcm = np.clip(channels_first, -1.0, 1.0)
    pcm = (pcm.T * 32767.0).round().astype("<i2", copy=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(channels_first.shape[0])
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())


def read_wave(path: Path) -> tuple[np.ndarray, int]:
    try:
        with wave.open(str(path), "rb") as handle:
            channels = handle.getnchannels()
            sample_width = handle.getsampwidth()
            sample_rate = handle.getframerate()
            frames = handle.readframes(handle.getnframes())
    except (wave.Error, EOFError) as exc:
        raise AudioFormatError(
            "signal-demo accepts uncompressed PCM WAV audio. "
            "Use the muscriptor provider for other supported audio formats."
        ) from exc

    if channels < 1 or sample_rate < 1:
        raise AudioFormatError("The WAV file has invalid stream metadata.")
    if sample_width == 1:
        samples = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128) / 128
    elif sample_width == 2:
        samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768
    elif sample_width == 3:
        raw = np.frombuffer(frames, dtype=np.uint8).reshape(-1, 3)
        values = (
            raw[:, 0].astype(np.int32)
            | (raw[:, 1].astype(np.int32) << 8)
            | (raw[:, 2].astype(np.int32) << 16)
        )
        values = np.where(values & 0x800000, values - 0x1000000, values)
        samples = values.astype(np.float32) / 8388608
    elif sample_width == 4:
        samples = np.frombuffer(frames, dtype="<i4").astype(np.float32) / 2147483648
    else:
        raise AudioFormatError(
            f"Unsupported PCM sample width: {sample_width * 8} bits."
        )

    if samples.size % channels:
        raise AudioFormatError("The WAV frame data is truncated.")
    return samples.reshape(-1, channels).T.copy(), sample_rate


def peak_envelope(audio: np.ndarray, points: int = 256) -> list[float]:
    channels_first = _as_channels_first(audio)
    mono_peak = np.max(np.abs(channels_first), axis=0)
    if mono_peak.size == 0:
        return []
    points = max(1, min(points, mono_peak.size))
    edges = np.linspace(0, mono_peak.size, points + 1, dtype=np.int64)
    return [
        round(float(np.max(mono_peak[edges[index] : edges[index + 1]])), 5)
        for index in range(points)
    ]
