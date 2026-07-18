from __future__ import annotations

import argparse
import json
import os
import uuid
from pathlib import Path
from typing import Any

import numpy as np

from .stable_audio_config import install_pinned_model_config
from .stable_audio_mlx_worker import _write_protected_pcm16


STABLE_AUDIO_STEPS = 8
# The official optimized MLX and TensorRT paths derive the latent length from
# the requested duration alone. Avoid the eager API's legacy +6 second tail.
CUDA_DURATION_PADDING_SECONDS = 0.0


def _write_progress(path: Path, value: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(
        json.dumps({"progress": value}, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def verify_cuda_runtime() -> None:
    import torch
    from flash_attn import flash_attn_func, flash_attn_kvpacked_func

    if torch.version.cuda != "12.6" or not torch.cuda.is_available():
        raise RuntimeError("The pinned PyTorch CUDA 12.6 runtime is unavailable.")
    major, _ = torch.cuda.get_device_capability(0)
    if major < 8:
        raise RuntimeError("FlashAttention 2 requires an Ampere-or-newer NVIDIA GPU.")
    if not callable(flash_attn_func) or not callable(flash_attn_kvpacked_func):
        raise RuntimeError("FlashAttention 2 entrypoints are unavailable.")


def load_stable_audio_model(*, progress):
    from stable_audio_3 import StableAudioModel

    verify_cuda_runtime()
    install_pinned_model_config()
    progress(0.08)
    return StableAudioModel.from_pretrained(
        "medium",
        device="cuda",
        model_half=True,
    )


def generate_with_model(
    model,
    *,
    prompt: str,
    duration: float,
    seed: int,
    output_path: Path,
    progress,
    chunked_decode: bool,
) -> dict[str, Any]:
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_path = output_path.with_name(f".{output_path.name}.{uuid.uuid4().hex}.json")
    try:
        progress(0.30)
        generated = model.generate(
            prompt=prompt,
            duration=duration,
            steps=STABLE_AUDIO_STEPS,
            seed=seed,
            duration_padding_sec=CUDA_DURATION_PADDING_SECONDS,
            chunked_decode=chunked_decode,
        )
        progress(0.88)
        audio = np.asarray(generated.detach().float().cpu().numpy(), dtype=np.float32)
        if audio.ndim == 3:
            audio = audio[0]
        if audio.ndim == 1:
            audio = audio[np.newaxis, :]
        sample_rate = int(getattr(model, "model_config", {}).get("sample_rate", 44_100))
        _write_protected_pcm16(
            str(output_path),
            audio,
            sample_rate,
            metadata_path,
            steps=STABLE_AUDIO_STEPS,
        )
        progress(0.98)
        value = json.loads(metadata_path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise RuntimeError("Stable Audio CUDA metadata was invalid.")
        return value
    finally:
        metadata_path.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--seconds", type=float, required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--progress", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    args = parser.parse_args()

    model = load_stable_audio_model(
        progress=lambda value: _write_progress(args.progress, value)
    )
    result = generate_with_model(
        model,
        prompt=args.prompt,
        duration=args.seconds,
        seed=args.seed,
        output_path=args.out,
        progress=lambda value: _write_progress(args.progress, value),
        chunked_decode=False,
    )
    # Preserve the old CLI contract for release smoke tests.
    args.metadata.write_text(
        json.dumps(result, separators=(",", ":")),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
