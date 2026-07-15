from __future__ import annotations

import json
import wave
from pathlib import Path

import numpy as np

from vibeseq_inference.stable_audio_mlx_worker import _write_protected_pcm16


def test_mlx_writer_applies_disclosed_peak_protection_without_clipping(
    tmp_path: Path,
) -> None:
    output = tmp_path / "protected.wav"
    metadata = tmp_path / "protected.json"
    audio = np.array([[0.0, 0.5, 1.2, -1.2], [0.0, -0.5, -1.1, 1.1]], dtype=np.float32)
    _write_protected_pcm16(output, audio, 44_100, metadata, 8)

    value = json.loads(metadata.read_text(encoding="utf-8"))
    assert value["sourcePeak"] > 1.0
    assert value["outputPeak"] < 1.0
    assert value["peakProtectionApplied"] is True
    assert value["peakAttenuationDb"] > 0
    with wave.open(str(output), "rb") as handle:
        pcm = np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2")
    assert np.max(np.abs(pcm.astype(np.int32))) < 32767


def test_mlx_writer_leaves_safe_audio_at_unity_gain(tmp_path: Path) -> None:
    output = tmp_path / "safe.wav"
    metadata = tmp_path / "safe.json"
    audio = np.array([[0.0, 0.25, -0.25]], dtype=np.float32)
    _write_protected_pcm16(output, audio, 48_000, metadata, 8)
    value = json.loads(metadata.read_text(encoding="utf-8"))
    assert value["peakProtectionApplied"] is False
    assert value["peakAttenuationDb"] == 0.0
