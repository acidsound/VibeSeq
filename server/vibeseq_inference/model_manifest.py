from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType


@dataclass(frozen=True, slots=True)
class ModelArtifact:
    """Immutable provenance for one exact set of model weights and code."""

    key: str
    provider: str
    model: str
    model_id: str
    model_revision: str
    code_repository: str | None
    code_revision: str | None
    license: str
    gated: bool
    files: tuple[str, ...]

    def provenance(self) -> dict[str, str | bool | list[str] | None]:
        return {
            "model": self.model,
            "modelId": self.model_id,
            "modelRevision": self.model_revision,
            "codeRepository": self.code_repository,
            "codeRevision": self.code_revision,
            "license": self.license,
            "gated": self.gated,
            "files": list(self.files),
        }


STABLE_AUDIO_3_MEDIUM = ModelArtifact(
    key="stable-audio-3-medium-pytorch",
    provider="stable-audio-3",
    model="medium",
    model_id="stabilityai/stable-audio-3-medium",
    model_revision="27b5a21b791b1b033d193a9e1e3ce78493f102f9",
    code_repository="https://github.com/Stability-AI/stable-audio-3",
    code_revision="b32763cf3b71c160f10a0daa4fa0e0d471b5772e",
    license="Stability AI Community License + Gemma Terms of Use",
    gated=True,
    files=(
        "model_config.json",
        "model.safetensors",
        "t5gemma-b-b-ul2/config.json",
        "t5gemma-b-b-ul2/model.safetensors",
        "t5gemma-b-b-ul2/special_tokens_map.json",
        "t5gemma-b-b-ul2/tokenizer.json",
        "t5gemma-b-b-ul2/tokenizer.model",
        "t5gemma-b-b-ul2/tokenizer_config.json",
    ),
)


# Stability AI publishes the same medium architecture in this repository for
# MLX and TFLite. VibeSeq records it separately because the exact files differ
# from the PyTorch checkpoint and no runtime is allowed to swap between them.
STABLE_AUDIO_3_MEDIUM_OPTIMIZED = ModelArtifact(
    key="stable-audio-3-medium-optimized",
    provider="stable-audio-3",
    model="medium",
    model_id="stabilityai/stable-audio-3-optimized",
    model_revision="c2949a435de2392fe49c5914c52bc174cfc05a9b",
    code_repository="https://github.com/Stability-AI/stable-audio-3",
    code_revision="b32763cf3b71c160f10a0daa4fa0e0d471b5772e",
    license="Stability AI Community License + Gemma Terms of Use",
    gated=False,
    files=(
        "MLX/dit_medium_f16.npz",
        "MLX/same_l_decoder_f32.npz",
        "MLX/t5gemma_f16.npz",
        "tflite/sa3-m/dit_w8a8-dyn.tflite",
        "tflite/same-l/dec_w8a8-dyn.tflite",
        "tflite/t5gemma/encoder_fp16.tflite",
    ),
)


MUSCRIPTOR_MEDIUM = ModelArtifact(
    key="muscriptor-medium-pytorch",
    provider="muscriptor",
    model="medium",
    model_id="MuScriptor/muscriptor-medium",
    model_revision="f32236969308476e01fd3aae67357de5feb05a2d",
    code_repository="https://github.com/muscriptor/muscriptor",
    code_revision="6c1460cc75e5f120948de7656da05b2c489e8715",
    license="CC BY-NC 4.0",
    gated=True,
    files=("config.json", "model.safetensors"),
)


MODEL_MANIFEST = MappingProxyType(
    {
        artifact.key: artifact
        for artifact in (
            STABLE_AUDIO_3_MEDIUM,
            STABLE_AUDIO_3_MEDIUM_OPTIMIZED,
            MUSCRIPTOR_MEDIUM,
        )
    }
)
