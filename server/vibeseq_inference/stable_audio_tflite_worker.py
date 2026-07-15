from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import uuid
from pathlib import Path

import numpy as np

from .stable_audio_mlx_worker import _write_protected_pcm16


_PRECISION = "w8a8-dyn"
_SAMPLE_RATE = 44_100


def _write_json(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(
        json.dumps(value, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--seconds", type=float, required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--steps", type=int, required=True)
    parser.add_argument("--threads", type=int, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--progress", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    args = parser.parse_args()

    entrypoint = args.runtime_root / "scripts" / "sa3_tflite.py"
    if not entrypoint.is_file():
        raise RuntimeError("Pinned Stable Audio 3 TFLite entrypoint is missing.")
    spec = importlib.util.spec_from_file_location("vibeseq_sa3_tflite", entrypoint)
    if spec is None or spec.loader is None:
        raise RuntimeError(
            "Could not load the pinned Stable Audio 3 TFLite entrypoint."
        )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    original_stage = module.stage
    started = {"[1/3]": 0.10, "[2/3]": 0.28, "[3/3]": 0.86}
    completed = {"[1/3]": 0.24, "[2/3]": 0.82, "[3/3]": 0.96}

    def stage(index: str, label: str, milliseconds=None):
        values = completed if milliseconds is not None else started
        if index in values:
            _write_json(args.progress, {"progress": values[index]})
        return original_stage(index, label, milliseconds)

    def save_wav(path: str, audio: np.ndarray):
        _write_protected_pcm16(
            path,
            audio,
            _SAMPLE_RATE,
            args.metadata,
            args.steps,
        )
        metadata = json.loads(args.metadata.read_text(encoding="utf-8"))
        metadata.update(
            {
                "precision": _PRECISION,
                "threads": args.threads,
            }
        )
        _write_json(args.metadata, metadata)

    module.stage = stage
    module.P.save_wav = save_wav
    _write_json(args.progress, {"progress": 0.06})
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
            "--precision",
            _PRECISION,
            "--seconds",
            str(args.seconds),
            "--steps",
            str(args.steps),
            "--seed",
            str(args.seed),
            "--cfg",
            "1.0",
            "--threads",
            str(args.threads),
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
