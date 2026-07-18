from __future__ import annotations

import argparse
import json
import os
import uuid
from pathlib import Path

import numpy as np

from .stable_audio_config import install_pinned_model_config
from .stable_audio_mlx_worker import _write_protected_pcm16


def _write_progress(path: Path, value: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(
        json.dumps({"progress": value}, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--seconds", type=float, required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--progress", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    args = parser.parse_args()

    import torch
    from flash_attn import flash_attn_func, flash_attn_kvpacked_func
    from stable_audio_3 import StableAudioModel

    if torch.version.cuda != "12.6" or not torch.cuda.is_available():
        raise RuntimeError("The pinned PyTorch CUDA 12.6 runtime is unavailable.")
    major, _ = torch.cuda.get_device_capability(0)
    if major < 8:
        raise RuntimeError("FlashAttention 2 requires an Ampere-or-newer NVIDIA GPU.")
    if not callable(flash_attn_func) or not callable(flash_attn_kvpacked_func):
        raise RuntimeError("FlashAttention 2 entrypoints are unavailable.")

    _write_progress(args.progress, 0.08)
    install_pinned_model_config()
    model = StableAudioModel.from_pretrained(
        "medium",
        device="cuda",
        model_half=True,
    )
    _write_progress(args.progress, 0.28)
    generated = model.generate(
        prompt=args.prompt,
        duration=args.seconds,
        seed=args.seed,
        chunked_decode=None,
    )
    _write_progress(args.progress, 0.88)
    audio = np.asarray(generated.detach().float().cpu().numpy(), dtype=np.float32)
    if audio.ndim == 3:
        audio = audio[0]
    if audio.ndim == 1:
        audio = audio[np.newaxis, :]
    sample_rate = int(getattr(model, "model_config", {}).get("sample_rate", 44_100))
    _write_protected_pcm16(
        str(args.out),
        audio,
        sample_rate,
        args.metadata,
        steps=0,
    )
    _write_progress(args.progress, 0.98)


if __name__ == "__main__":
    main()
