from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import sys
import uuid
import wave
from pathlib import Path

import numpy as np

from .stable_audio_mlx import peak_target_linear


def _write_json(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(
        json.dumps(value, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _write_protected_pcm16(
    path: str,
    audio: np.ndarray,
    sample_rate: int,
    metadata_path: Path,
    steps: int,
) -> None:
    value = np.asarray(audio, dtype=np.float32)
    if value.ndim != 2 or value.shape[0] not in {1, 2}:
        raise RuntimeError(f"Unexpected Stable Audio output shape: {value.shape}.")
    if not np.isfinite(value).all():
        count = int((~np.isfinite(value)).sum())
        raise RuntimeError(
            f"Refusing to write generated audio with {count} non-finite samples."
        )
    source_peak = float(np.max(np.abs(value))) if value.size else 0.0
    target = peak_target_linear()
    gain = min(1.0, target / source_peak) if source_peak > 0 else 1.0
    protected = value * gain
    output_peak = float(np.max(np.abs(protected))) if protected.size else 0.0
    pcm = np.rint(protected.T * 32767.0).astype("<i2", copy=False)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(value.shape[0])
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())
    _write_json(
        metadata_path,
        {
            "sourcePeak": source_peak,
            "outputPeak": output_peak,
            "peakProtectionApplied": gain < 1.0,
            "peakAttenuationDb": round(-20.0 * math.log10(gain), 6),
            "steps": steps,
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--seconds", type=float, required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--steps", type=int, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--progress", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    args = parser.parse_args()

    entrypoint = args.runtime_root / "scripts" / "sa3_mlx.py"
    if not entrypoint.is_file():
        raise RuntimeError("Pinned Stable Audio 3 MLX entrypoint is missing.")
    spec = importlib.util.spec_from_file_location("vibeseq_sa3_mlx", entrypoint)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the pinned Stable Audio 3 MLX entrypoint.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    stage_progress = {
        "[1/5]": 0.14,
        "[2/5]": 0.28,
        "[3/5]": 0.42,
        "[4/5]": 0.82,
        "[5/5]": 0.94,
    }
    original_stage = module.stage

    def stage(label: str, *stage_args, **stage_kwargs):
        if label in stage_progress:
            _write_json(args.progress, {"progress": stage_progress[label]})
        return original_stage(label, *stage_args, **stage_kwargs)

    def save_wav(path: str, audio: np.ndarray, sample_rate: int = 44_100):
        _write_protected_pcm16(
            path,
            audio,
            sample_rate,
            args.metadata,
            args.steps,
        )

    module.stage = stage
    module.save_wav = save_wav
    _write_json(args.progress, {"progress": 0.08})
    previous_argv = sys.argv
    try:
        sys.argv = [
            str(entrypoint),
            "--prompt",
            args.prompt,
            "--dit",
            "medium",
            "--decoder",
            "same-l",
            "--seconds",
            str(args.seconds),
            "--steps",
            str(args.steps),
            "--seed",
            str(args.seed),
            "--cfg",
            "1.0",
            "--free-models",
            "--out",
            str(args.out),
        ]
        module.main()
    finally:
        sys.argv = previous_argv
    _write_json(args.progress, {"progress": 0.98})


if __name__ == "__main__":
    main()
