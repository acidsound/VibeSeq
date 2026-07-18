from __future__ import annotations

from pathlib import Path

from vibeseq_inference.config import Settings
from vibeseq_inference.devices import HardwareProbe
from vibeseq_inference.model_manifest import (
    MODEL_MANIFEST,
    MUSCRIPTOR_MEDIUM,
    STABLE_AUDIO_3_MEDIUM,
)
from vibeseq_inference.readiness import (
    generation_capability,
    transcription_capability,
)
from vibeseq_inference.storage_paths import CUDA_RUNTIME_BUNDLE


def real_settings(tmp_path: Path, **overrides) -> Settings:
    values = {
        "data_dir": tmp_path,
        "generation_provider": "stable-audio-3",
        "transcription_provider": "muscriptor",
    }
    values.update(overrides)
    return Settings(**values).validate()


def test_exact_medium_manifest_is_immutable_and_pinned() -> None:
    assert STABLE_AUDIO_3_MEDIUM.model_id == "stabilityai/stable-audio-3-medium"
    assert STABLE_AUDIO_3_MEDIUM.model_revision == (
        "27b5a21b791b1b033d193a9e1e3ce78493f102f9"
    )
    assert STABLE_AUDIO_3_MEDIUM.code_revision == (
        "b32763cf3b71c160f10a0daa4fa0e0d471b5772e"
    )
    assert MUSCRIPTOR_MEDIUM.model_id == "MuScriptor/muscriptor-medium"
    assert MUSCRIPTOR_MEDIUM.model_revision == (
        "f32236969308476e01fd3aae67357de5feb05a2d"
    )
    assert MUSCRIPTOR_MEDIUM.code_revision == (
        "6c1460cc75e5f120948de7656da05b2c489e8715"
    )
    assert set(MODEL_MANIFEST) == {
        "stable-audio-3-medium-pytorch",
        "stable-audio-3-medium-optimized",
        "muscriptor-medium-pytorch",
    }


def test_apple_mlx_is_ready_with_exact_code_packages_and_weights(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr("vibeseq_inference.readiness.module_installed", lambda _: True)
    monkeypatch.setattr(
        "vibeseq_inference.readiness.cached_files",
        lambda *_: (True, ()),
    )
    monkeypatch.setattr(
        "vibeseq_inference.readiness.mlx_code_cached",
        lambda: True,
    )
    status = generation_capability(
        real_settings(tmp_path),
        probe=HardwareProbe("Darwin", "arm64", False, None, None, True),
    )
    assert status["model"] == "medium"
    assert status["route"] == "apple-mlx"
    assert status["packageInstalled"] is True
    assert status["weightsCached"] is True
    assert status["accessGranted"] is True
    assert status["runtimeCompatible"] is True
    assert status["adapterImplemented"] is True
    assert status["codeCached"] is True
    assert status["ready"] is True
    assert status["bootstrap"] == {
        "kind": "huggingface-files",
        "modelId": "stabilityai/stable-audio-3-optimized",
        "revision": "c2949a435de2392fe49c5914c52bc174cfc05a9b",
        "files": [
            "MLX/dit_medium_f16.npz",
            "MLX/same_l_decoder_f32.npz",
            "MLX/t5gemma_f16.npz",
        ],
        "accessUrl": "https://huggingface.co/stabilityai/stable-audio-3-optimized",
        "requiresApproval": False,
    }


def test_apple_mlx_discloses_missing_exact_source_checkout(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr("vibeseq_inference.readiness.module_installed", lambda _: True)
    monkeypatch.setattr(
        "vibeseq_inference.readiness.cached_files",
        lambda *_: (True, ()),
    )
    monkeypatch.setattr(
        "vibeseq_inference.readiness.mlx_code_cached",
        lambda: False,
    )
    monkeypatch.setattr(
        "vibeseq_inference.readiness.tflite_code_cached",
        lambda: False,
    )
    status = generation_capability(
        real_settings(tmp_path),
        probe=HardwareProbe("Darwin", "arm64", False, None, None, True),
    )
    assert status["codeCached"] is False
    assert status["ready"] is False
    assert "first generation bootstraps" in status["reason"]


def test_apple_selects_ready_cpu_fallback_when_preferred_mlx_is_unavailable(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr("vibeseq_inference.readiness.module_installed", lambda _: True)
    monkeypatch.setattr(
        "vibeseq_inference.readiness.cached_files",
        lambda *_: (True, ()),
    )
    monkeypatch.setattr(
        "vibeseq_inference.readiness.mlx_code_cached",
        lambda: False,
    )
    monkeypatch.setattr(
        "vibeseq_inference.readiness.tflite_code_cached",
        lambda: True,
    )
    status = generation_capability(
        real_settings(tmp_path),
        probe=HardwareProbe("Darwin", "arm64", False, None, None, True),
    )
    assert status["preferredRoute"] == "apple-mlx"
    assert status["route"] == "cpu-tflite"
    assert status["runtime"] == "tflite-w8a8-dyn"
    assert status["ready"] is True
    assert status["available"] is True
    assert status["routePriority"] == ["apple-mlx", "cpu-tflite"]


def test_cpu_tflite_is_ready_only_with_exact_code_packages_and_weights(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr("vibeseq_inference.readiness.module_installed", lambda _: True)
    monkeypatch.setattr(
        "vibeseq_inference.readiness.cached_files",
        lambda *_: (True, ()),
    )
    monkeypatch.setattr(
        "vibeseq_inference.readiness.tflite_code_cached",
        lambda: True,
    )
    status = generation_capability(
        real_settings(tmp_path),
        probe=HardwareProbe("Linux", "x86_64", False, None, None, False),
    )
    assert status["model"] == "medium"
    assert status["route"] == "cpu-tflite"
    assert status["runtime"] == "tflite-w8a8-dyn"
    assert status["adapterImplemented"] is True
    assert status["executionEnabled"] is True
    assert status["codeCached"] is True
    assert status["ready"] is True
    assert status["bootstrap"]["files"] == [
        "tflite/sa3-m/dit_w8a8-dyn.tflite",
        "tflite/same-l/dec_w8a8-dyn.tflite",
        "tflite/t5gemma/encoder_fp16.tflite",
    ]


def test_cpu_tflite_reports_only_the_packages_that_are_actually_missing(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "vibeseq_inference.readiness.module_installed",
        lambda name: name != "sentencepiece",
    )
    monkeypatch.setattr(
        "vibeseq_inference.readiness.cached_files",
        lambda *_: (True, ()),
    )
    monkeypatch.setattr(
        "vibeseq_inference.readiness.tflite_code_cached",
        lambda: True,
    )
    status = generation_capability(
        real_settings(tmp_path),
        probe=HardwareProbe("Windows", "AMD64", False, None, None, False),
    )
    assert status["route"] == "cpu-tflite"
    assert status["packageInstalled"] is False
    assert status["missingPackages"] == ["sentencepiece"]
    assert status["reason"] == "Missing runtime package(s): sentencepiece"


def test_force_cpu_readiness_exposes_only_cpu_routes_on_apple_silicon(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr("vibeseq_inference.readiness.module_installed", lambda _: True)
    monkeypatch.setattr(
        "vibeseq_inference.readiness.cached_files",
        lambda *_: (True, ()),
    )
    monkeypatch.setattr(
        "vibeseq_inference.readiness.tflite_code_cached",
        lambda: True,
    )
    probe = HardwareProbe("Darwin", "arm64", False, None, None, True)
    settings = real_settings(tmp_path, force_cpu=True)

    generation = generation_capability(settings, probe=probe)
    transcription = transcription_capability(settings, probe=probe)

    assert generation["route"] == "cpu-tflite"
    assert generation["preferredRoute"] == "cpu-tflite"
    assert generation["routePriority"] == ["cpu-tflite"]
    assert generation["device"] == "cpu"
    assert transcription["route"] == "cpu-pytorch"
    assert transcription["runtime"] == "pytorch-cpu"
    assert transcription["device"] == "cpu"


def test_ampere_route_becomes_ready_only_with_exact_cached_weights(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr("vibeseq_inference.readiness.module_installed", lambda _: True)
    monkeypatch.setattr(
        "vibeseq_inference.readiness.cached_files",
        lambda *_: (True, ()),
    )
    status = generation_capability(
        real_settings(tmp_path, target="colab-cuda"),
        probe=HardwareProbe("Linux", "x86_64", True, (8, 0), "A100", False),
    )
    assert status["route"] == "cuda-ampere-fa2"
    assert status["runtime"] == "pytorch-fa2"
    assert status["modelRevision"] == STABLE_AUDIO_3_MEDIUM.model_revision
    assert status["codeRevision"] == STABLE_AUDIO_3_MEDIUM.code_revision
    assert status["ready"] is True
    assert status["available"] is True


def test_windows_4090_selects_ready_flash_attention_route(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr("vibeseq_inference.readiness.module_installed", lambda _: True)
    monkeypatch.setattr(
        "vibeseq_inference.readiness.cached_files",
        lambda *_: (True, ()),
    )
    status = generation_capability(
        real_settings(tmp_path),
        probe=HardwareProbe(
            "Windows", "AMD64", True, (8, 9), "NVIDIA GeForce RTX 4090", False
        ),
    )
    assert status["preferredRoute"] == "cuda-ampere-fa2"
    assert status["routePriority"] == ["cuda-ampere-fa2"]
    assert status["route"] == "cuda-ampere-fa2"
    assert status["runtime"] == "pytorch-fa2"
    assert status["device"] == "cuda"
    assert status["ready"] is True


def test_windows_4090_blocks_instead_of_silently_falling_back_without_fa2(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "vibeseq_inference.readiness.module_installed",
        lambda name: name != "flash_attn",
    )
    monkeypatch.setattr(
        "vibeseq_inference.readiness.cached_files",
        lambda *_: (True, ()),
    )
    status = generation_capability(
        real_settings(tmp_path),
        probe=HardwareProbe(
            "Windows", "AMD64", True, (8, 9), "NVIDIA GeForce RTX 4090", False
        ),
    )
    assert status["routePriority"] == ["cuda-ampere-fa2"]
    assert status["route"] == "cuda-ampere-fa2"
    assert status["device"] == "cuda"
    assert status["missingPackages"] == ["flash_attn"]
    assert status["ready"] is False
    assert status["available"] is False


def test_windows_4090_blocks_when_bundle_contains_cpu_only_torch(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr("vibeseq_inference.readiness.module_installed", lambda _: True)
    monkeypatch.setattr(
        "vibeseq_inference.readiness.cached_files",
        lambda *_: (True, ()),
    )
    status = generation_capability(
        real_settings(tmp_path),
        probe=HardwareProbe(
            "Windows",
            "AMD64",
            False,
            (8, 9),
            "NVIDIA GeForce RTX 4090",
            False,
            cuda_hardware_detected=True,
            cuda_runtime=None,
        ),
    )
    assert status["routePriority"] == ["cuda-ampere-fa2"]
    assert status["route"] == "cuda-ampere-fa2"
    assert status["runtimeCompatible"] is False
    assert status["ready"] is False
    assert "CPU fallback is intentionally disabled" in status["reason"]


def test_windows_4090_uses_verified_isolated_cuda_runtime(
    tmp_path: Path, monkeypatch
) -> None:
    project_digest = "a" * 64
    runtime = (
        tmp_path
        / "runtimes"
        / CUDA_RUNTIME_BUNDLE
    )
    python = runtime / "venv" / "Scripts" / "python.exe"
    python.parent.mkdir(parents=True)
    python.write_bytes(b"fixture")
    (runtime / ".vibeseq-runtime.json").write_text(
        '{"bundleId":"%s","projectDigest":"%s"}'
        % (CUDA_RUNTIME_BUNDLE, project_digest),
        encoding="utf-8",
    )
    monkeypatch.setenv("VIBESEQ_HOME", str(tmp_path))
    monkeypatch.setenv("VIBESEQ_CUDA_RUNTIME_PROJECT_DIGEST", project_digest)
    monkeypatch.setattr("vibeseq_inference.readiness.module_installed", lambda _: False)
    monkeypatch.setattr(
        "vibeseq_inference.readiness.cached_files",
        lambda *_: (True, ()),
    )

    status = generation_capability(
        real_settings(tmp_path),
        probe=HardwareProbe(
            "Windows",
            "AMD64",
            False,
            (8, 9),
            "NVIDIA GeForce RTX 4090",
            False,
            cuda_hardware_detected=True,
        ),
    )
    assert status["routePriority"] == ["cuda-ampere-fa2"]
    assert status["runtimeCompatible"] is True
    assert status["packageInstalled"] is True
    assert status["missingPackages"] == []
    assert status["ready"] is True

    monkeypatch.setenv("VIBESEQ_CUDA_RUNTIME_PROJECT_DIGEST", "b" * 64)
    stale = generation_capability(
        real_settings(tmp_path),
        probe=HardwareProbe(
            "Windows",
            "AMD64",
            False,
            (8, 9),
            "NVIDIA GeForce RTX 4090",
            False,
            cuda_hardware_detected=True,
        ),
    )
    assert stale["runtimeCompatible"] is False
    assert stale["ready"] is False


def test_t4_sdpa_is_provisional_and_disabled_by_default(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr("vibeseq_inference.readiness.module_installed", lambda _: True)
    monkeypatch.setattr(
        "vibeseq_inference.readiness.cached_files",
        lambda *_: (True, ()),
    )
    status = generation_capability(
        real_settings(tmp_path, target="colab-t4"),
        probe=HardwareProbe("Linux", "x86_64", True, (7, 5), "T4", False),
    )
    assert status["route"] == "cuda-t4-sdpa"
    assert status["runtime"] == "pytorch-sdpa"
    assert status["provisional"] is True
    assert status["executionEnabled"] is False
    assert status["ready"] is False


def test_uncached_gated_muscriptor_access_is_unknown_not_assumed(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr("vibeseq_inference.readiness.module_installed", lambda _: True)
    monkeypatch.setattr(
        "vibeseq_inference.readiness.cached_files",
        lambda *_: (False, ("config.json", "model.safetensors")),
    )
    status = transcription_capability(
        real_settings(tmp_path),
        probe=HardwareProbe("Linux", "x86_64", False, None, None, False),
    )
    assert status["model"] == "medium"
    assert status["packageInstalled"] is True
    assert status["weightsCached"] is False
    assert status["accessGranted"] is None
    assert status["ready"] is False
