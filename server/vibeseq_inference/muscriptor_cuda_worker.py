from __future__ import annotations

import argparse
import json
import os
import uuid
from pathlib import Path

from .model_manifest import MUSCRIPTOR_MEDIUM
from .providers.muscriptor import (
    _prepare_audio_with_zero_preroll,
    _transcribe_loaded_model,
)


def _write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(
        json.dumps(value, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _write_progress(path: Path, value: float) -> None:
    _write_json(path, {"progress": value})


def _cached_file(filename: str) -> str:
    from huggingface_hub import try_to_load_from_cache

    cached = try_to_load_from_cache(
        MUSCRIPTOR_MEDIUM.model_id,
        filename,
        revision=MUSCRIPTOR_MEDIUM.model_revision,
    )
    if not isinstance(cached, str):
        raise RuntimeError(
            f"The exact MuScriptor {filename} is not present in the shared cache."
        )
    return cached


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--progress", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    args = parser.parse_args()

    import torch
    from muscriptor import TranscriptionModel

    if torch.version.cuda != "12.6" or not torch.cuda.is_available():
        raise RuntimeError("The pinned PyTorch CUDA 12.6 runtime is unavailable.")
    _cached_file("config.json")
    weights_path = _cached_file("model.safetensors")

    _write_progress(args.progress, 0.08)
    prepared_audio, original_duration_seconds = _prepare_audio_with_zero_preroll(
        args.input
    )
    model = TranscriptionModel.load_model(weights_path, device="cuda")
    _write_progress(args.progress, 0.2)
    notes = _transcribe_loaded_model(
        model,
        prepared_audio,
        original_duration_seconds,
        args.out,
        lambda value: _write_progress(args.progress, value),
        lambda: False,
    )
    _write_json(
        args.metadata,
        {"notes": [note.model_dump(by_alias=True) for note in notes]},
    )
    _write_progress(args.progress, 0.98)


if __name__ == "__main__":
    main()
