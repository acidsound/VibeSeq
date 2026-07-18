from __future__ import annotations

import json
import os
from pathlib import Path

from .model_manifest import STABLE_AUDIO_3_MEDIUM
from .storage_paths import model_config_dir


def pinned_stable_audio_files() -> tuple[str, str]:
    from huggingface_hub import hf_hub_download

    artifact = STABLE_AUDIO_3_MEDIUM
    resolved = {
        filename: hf_hub_download(
            repo_id=artifact.model_id,
            filename=filename,
            revision=artifact.model_revision,
        )
        for filename in artifact.files
    }

    # The upstream config points Transformers at a moving default branch for
    # T5Gemma. Rewrite only the locally resolved config so every file stays on
    # the exact model revision recorded by VibeSeq.
    config_data = json.loads(Path(resolved["model_config.json"]).read_text())
    text_encoder_dir = str(Path(resolved["t5gemma-b-b-ul2/config.json"]).parent)
    for conditioner in config_data["model"]["conditioning"]["configs"]:
        if conditioner.get("type") == "t5gemma":
            config = conditioner["config"]
            config["model_path"] = text_encoder_dir
            config.pop("repo_id", None)
            config.pop("subfolder", None)

    cache_dir = model_config_dir()
    cache_dir.mkdir(parents=True, exist_ok=True)
    pinned_config = cache_dir / (
        f"stable-audio-3-medium-{artifact.model_revision}-v1.json"
    )
    temporary = pinned_config.with_suffix(f".tmp-{os.getpid()}")
    temporary.write_text(
        json.dumps(config_data, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(temporary, pinned_config)
    return str(pinned_config), resolved["model.safetensors"]


class _PinnedStableAudioConfig:
    def resolve(self) -> tuple[str, str]:
        return pinned_stable_audio_files()


def install_pinned_model_config() -> None:
    from stable_audio_3.model_configs import all_models

    # StableAudioModel.from_pretrained accepts an alias rather than a revision.
    # Replacing just this resolver keeps both downloads revision-exact.
    all_models["medium"] = _PinnedStableAudioConfig()
