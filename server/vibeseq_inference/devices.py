from __future__ import annotations

import platform
import subprocess
from dataclasses import dataclass

from .storage_paths import cuda_runtime_ready


@dataclass(frozen=True, slots=True)
class HardwareProbe:
    system: str
    machine: str
    cuda_available: bool
    cuda_capability: tuple[int, int] | None
    cuda_name: str | None
    mps_available: bool
    cuda_hardware_detected: bool = False
    cuda_runtime: str | None = None

    @classmethod
    def detect(cls) -> "HardwareProbe":
        cuda_available = False
        cuda_capability: tuple[int, int] | None = None
        cuda_name: str | None = None
        mps_available = False
        cuda_hardware_detected = False
        cuda_runtime: str | None = None
        try:
            import torch

            cuda_available = bool(torch.cuda.is_available())
            cuda_runtime = getattr(torch.version, "cuda", None)
            if cuda_available:
                cuda_hardware_detected = True
                cuda_capability = tuple(torch.cuda.get_device_capability(0))
                cuda_name = str(torch.cuda.get_device_name(0))
            mps = getattr(torch.backends, "mps", None)
            mps_available = bool(mps is not None and mps.is_available())
        except (ImportError, RuntimeError, TypeError):
            pass
        if not cuda_hardware_detected and platform.system() in {"Linux", "Windows"}:
            try:
                completed = subprocess.run(
                    [
                        "nvidia-smi",
                        "--query-gpu=name,compute_cap",
                        "--format=csv,noheader",
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=5,
                    creationflags=(
                        subprocess.CREATE_NO_WINDOW
                        if platform.system() == "Windows"
                        else 0
                    ),
                )
                first_gpu = completed.stdout.strip().splitlines()[0]
                name, capability = (part.strip() for part in first_gpu.rsplit(",", 1))
                major, minor = (int(part) for part in capability.split(".", 1))
                cuda_hardware_detected = True
                cuda_capability = (major, minor)
                cuda_name = name
            except (
                FileNotFoundError,
                IndexError,
                OSError,
                subprocess.SubprocessError,
                ValueError,
            ):
                pass
        return cls(
            system=platform.system(),
            machine=platform.machine(),
            cuda_available=cuda_available,
            cuda_capability=cuda_capability,
            cuda_name=cuda_name,
            mps_available=mps_available,
            cuda_hardware_detected=cuda_hardware_detected,
            cuda_runtime=cuda_runtime,
        )


@dataclass(frozen=True, slots=True)
class RuntimeRoute:
    id: str
    runtime: str
    device: str
    artifact_key: str
    required_modules: tuple[str, ...]
    required_files: tuple[str, ...]
    hardware_compatible: bool = True
    runtime_compatible: bool = True
    adapter_implemented: bool = True
    provisional: bool = False
    execution_enabled: bool = True
    isolated: bool = False
    reason: str | None = None


STABLE_AUDIO_PYTORCH_FILES = (
    "model_config.json",
    "model.safetensors",
    "t5gemma-b-b-ul2/config.json",
    "t5gemma-b-b-ul2/model.safetensors",
    "t5gemma-b-b-ul2/special_tokens_map.json",
    "t5gemma-b-b-ul2/tokenizer.json",
    "t5gemma-b-b-ul2/tokenizer.model",
    "t5gemma-b-b-ul2/tokenizer_config.json",
)


def available_devices(
    probe: HardwareProbe | None = None,
    *,
    force_cpu: bool = False,
) -> list[str]:
    """Return usable Torch devices in the product's required fallback order."""
    if force_cpu:
        return ["cpu"]
    hardware = probe or HardwareProbe.detect()
    devices: list[str] = []
    if hardware.cuda_available:
        devices.append("cuda")
    if hardware.mps_available:
        devices.append("mps")
    devices.append("cpu")
    return devices


def stable_audio_runtime_routes(
    target: str,
    *,
    probe: HardwareProbe | None = None,
    enable_provisional_t4: bool = False,
    force_cpu: bool = False,
) -> tuple[RuntimeRoute, ...]:
    """Describe medium-only Stable Audio routes in execution priority order.

    Route description is intentionally separate from readiness. A compatible
    device may still be missing packages or cached weights, and an official
    weight format is not considered executable until VibeSeq has a verified
    adapter for it.
    """

    hardware = probe or HardwareProbe.detect()
    routes: list[RuntimeRoute] = []
    # The Linux AppImage deliberately bundles CPU-only PyTorch and LiteRT. An
    # NVIDIA driver may still make nvidia-smi report the GPU, but unlike the
    # Windows package there is no managed Linux CUDA runtime to activate. Keep
    # the hardware facts visible without selecting an unusable CUDA route.
    # Linux CUDA targets such as Colab remain eligible when their own PyTorch
    # runtime has actually passed torch.cuda.is_available().
    cuda_hardware_available = bool(
        hardware.cuda_available
        or (
            hardware.system == "Windows"
            and (
                hardware.cuda_hardware_detected
                or hardware.cuda_capability is not None
            )
        )
    )
    cuda_fa2_hardware = False

    if not force_cpu and hardware.system == "Darwin" and hardware.machine == "arm64":
        routes.append(
            RuntimeRoute(
                id="apple-mlx",
                runtime="mlx",
                device="metal",
                artifact_key="stable-audio-3-medium-optimized",
                required_modules=("mlx", "sentencepiece", "huggingface_hub"),
                required_files=(
                    "MLX/dit_medium_f16.npz",
                    "MLX/same_l_decoder_f32.npz",
                    "MLX/t5gemma_f16.npz",
                ),
                adapter_implemented=True,
                execution_enabled=True,
                reason=(
                    "The verified Apple MLX adapter runs the exact medium DiT "
                    "with the SAME-L decoder in an isolated process."
                ),
            )
        )
    elif (
        not force_cpu
        and cuda_hardware_available
        and hardware.cuda_capability is not None
    ):
        major, minor = hardware.cuda_capability
        if major >= 8:
            cuda_fa2_hardware = True
            cuda_runtime_available = hardware.cuda_available or cuda_runtime_ready()
            routes.append(
                RuntimeRoute(
                    id="cuda-ampere-fa2",
                    runtime="pytorch-fa2",
                    device="cuda",
                    artifact_key="stable-audio-3-medium-pytorch",
                    required_modules=("torch", "stable_audio_3", "flash_attn"),
                    required_files=STABLE_AUDIO_PYTORCH_FILES,
                    runtime_compatible=cuda_runtime_available,
                    isolated=hardware.system == "Windows" and not hardware.cuda_available,
                    reason=(
                        None
                        if cuda_runtime_available
                        else (
                            "A FlashAttention-compatible NVIDIA GPU was detected, "
                            "but the isolated VibeSeq CUDA/FlashAttention runtime "
                            "has not passed its on-device kernel check. CPU fallback "
                            "is intentionally disabled on this hardware."
                        )
                    ),
                )
            )
        elif target == "colab-t4" and (major, minor) == (7, 5):
            routes.append(
                RuntimeRoute(
                    id="cuda-t4-sdpa",
                    runtime="pytorch-sdpa",
                    device="cuda",
                    artifact_key="stable-audio-3-medium-pytorch",
                    required_modules=("stable_audio_3",),
                    required_files=STABLE_AUDIO_PYTORCH_FILES,
                    provisional=True,
                    execution_enabled=enable_provisional_t4,
                    reason=(
                        "T4 uses the upstream SDPA/chunked path provisionally; "
                        "execution requires VIBESEQ_ENABLE_PROVISIONAL_T4=1."
                    ),
                )
            )

    if target == "local" and (force_cpu or not cuda_fa2_hardware):
        routes.append(
            RuntimeRoute(
                id="cpu-tflite",
                runtime="tflite-w8a8-dyn",
                device="cpu",
                artifact_key="stable-audio-3-medium-optimized",
                required_modules=(
                    "ai_edge_litert",
                    "sentencepiece",
                    "huggingface_hub",
                ),
                required_files=(
                    "tflite/sa3-m/dit_w8a8-dyn.tflite",
                    "tflite/same-l/dec_w8a8-dyn.tflite",
                    "tflite/t5gemma/encoder_fp16.tflite",
                ),
                adapter_implemented=True,
                execution_enabled=True,
                reason=(
                    "The portable desktop CPU fallback uses the official medium "
                    "DiT and SAME-L decoder with the fastest published w8a8-dyn "
                    "precision. Colab targets never downgrade to this CPU route."
                ),
            )
        )
    return tuple(routes)


def stable_audio_execution_routes(
    target: str,
    *,
    probe: HardwareProbe | None = None,
    enable_provisional_t4: bool = False,
    force_cpu: bool = False,
) -> tuple[RuntimeRoute, ...]:
    return tuple(
        route
        for route in stable_audio_runtime_routes(
            target,
            probe=probe,
            enable_provisional_t4=enable_provisional_t4,
            force_cpu=force_cpu,
        )
        if route.hardware_compatible
        and route.runtime_compatible
        and route.adapter_implemented
        and route.execution_enabled
    )


def muscriptor_runtime_route(
    probe: HardwareProbe | None = None,
    *,
    force_cpu: bool = False,
) -> RuntimeRoute:
    hardware = probe or HardwareProbe.detect()
    if force_cpu:
        route_id, runtime, device = "cpu-pytorch", "pytorch-cpu", "cpu"
    elif hardware.cuda_available:
        route_id, runtime, device = "cuda-pytorch", "pytorch-cuda", "cuda"
    elif (
        hardware.system == "Windows"
        and (
            hardware.cuda_hardware_detected
            or hardware.cuda_capability is not None
        )
    ):
        runtime_ready = cuda_runtime_ready(
            require_flash_attention=False,
            require_muscriptor=True,
        )
        return RuntimeRoute(
            id="cuda-pytorch",
            runtime="pytorch-cuda",
            device="cuda",
            artifact_key="muscriptor-medium-pytorch",
            required_modules=("muscriptor",),
            required_files=("config.json", "model.safetensors"),
            runtime_compatible=runtime_ready,
            isolated=True,
            reason=(
                None
                if runtime_ready
                else (
                    "An NVIDIA GPU was detected, but the managed VibeSeq CUDA "
                    "runtime for MuScriptor has not passed its on-device check."
                )
            ),
        )
    elif hardware.mps_available:
        route_id, runtime, device = "apple-mps", "pytorch-mps", "mps"
    else:
        route_id, runtime, device = "cpu-pytorch", "pytorch-cpu", "cpu"
    return RuntimeRoute(
        id=route_id,
        runtime=runtime,
        device=device,
        artifact_key="muscriptor-medium-pytorch",
        required_modules=("muscriptor",),
        required_files=("config.json", "model.safetensors"),
    )
