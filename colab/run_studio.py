from __future__ import annotations

import argparse
import importlib.util
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


MODEL_SIZE = "medium"


@dataclass(frozen=True, slots=True)
class DetectedGpu:
    name: str
    capability: tuple[int, int]


@dataclass(frozen=True, slots=True)
class GpuTarget:
    target: str
    route: str
    runtime: str
    provisional: bool


@dataclass(frozen=True, slots=True)
class ModelPins:
    stable_id: str
    stable_revision: str
    stable_code_revision: str
    muscriptor_id: str
    muscriptor_revision: str
    muscriptor_code_revision: str


def load_model_pins(server: Path) -> ModelPins:
    """Read the server manifest without maintaining a second revision source."""
    manifest_path = server / "vibeseq_inference" / "model_manifest.py"
    spec = importlib.util.spec_from_file_location(
        "_vibeseq_colab_model_manifest", manifest_path
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the server model manifest.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop(spec.name, None)
    stable = module.STABLE_AUDIO_3_MEDIUM
    muscriptor = module.MUSCRIPTOR_MEDIUM
    if not stable.code_revision or not muscriptor.code_revision:
        raise RuntimeError("The server model manifest must pin both code revisions.")
    return ModelPins(
        stable_id=stable.model_id,
        stable_revision=stable.model_revision,
        stable_code_revision=stable.code_revision,
        muscriptor_id=muscriptor.model_id,
        muscriptor_revision=muscriptor.model_revision,
        muscriptor_code_revision=muscriptor.code_revision,
    )


def run(command: list[str], cwd: Path, env: dict[str, str] | None = None) -> None:
    subprocess.run(command, cwd=cwd, env=env, check=True)


def gpu_info() -> DetectedGpu:
    if shutil.which("nvidia-smi") is None:
        raise RuntimeError("The colab-t4 target requires an NVIDIA runtime.")
    result = subprocess.run(
        [
            "nvidia-smi",
            "--query-gpu=name,compute_cap",
            "--format=csv,noheader,nounits",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    lines = result.stdout.strip().splitlines()
    if not lines:
        raise RuntimeError("nvidia-smi returned no GPU rows.")
    first_line = lines[0]
    try:
        name, raw_capability = (part.strip() for part in first_line.rsplit(",", 1))
        major, minor = (int(part) for part in raw_capability.split(".", 1))
    except (ValueError, IndexError) as exc:
        raise RuntimeError(
            f"Could not parse NVIDIA GPU name and compute capability: {first_line!r}"
        ) from exc
    return DetectedGpu(name=name, capability=(major, minor))


def validate_gpu_target(detected_gpu: DetectedGpu, allow_other_cuda: bool) -> GpuTarget:
    is_t4 = "T4" in detected_gpu.name.upper()
    if not is_t4 and not allow_other_cuda:
        raise RuntimeError(
            f"Expected a T4 runtime, found '{detected_gpu.name}'. "
            "Pass --allow-other-cuda only for an intentional compatible target."
        )
    if is_t4:
        if detected_gpu.capability != (7, 5):
            raise RuntimeError(
                "A T4-named runtime must report compute capability 7.5; "
                f"found {detected_gpu.capability[0]}.{detected_gpu.capability[1]} "
                f"on '{detected_gpu.name}'."
            )
        return GpuTarget(
            target="colab-t4",
            route="cuda-t4-sdpa",
            runtime="pytorch-sdpa",
            provisional=True,
        )
    if detected_gpu.capability < (8, 0):
        raise RuntimeError(
            "The alternate CUDA route requires Ampere or newer compute capability "
            f"8.0+, found {detected_gpu.capability[0]}.{detected_gpu.capability[1]} "
            f"on '{detected_gpu.name}'."
        )
    return GpuTarget(
        target="colab-cuda",
        route="cuda-ampere-fa2",
        runtime="pytorch-fa2",
        provisional=False,
    )


def inference_environment(
    base: dict[str, str],
    plan: GpuTarget,
    *,
    enable_provisional_t4: bool,
) -> dict[str, str]:
    env = base.copy()
    env["VIBESEQ_TARGET"] = plan.target
    env["VIBESEQ_GENERATION_PROVIDER"] = "stable-audio-3"
    env["VIBESEQ_TRANSCRIPTION_PROVIDER"] = "muscriptor"
    # These assignments intentionally override any inherited small-model value.
    env["VIBESEQ_STABLE_AUDIO_MODEL"] = MODEL_SIZE
    env["VIBESEQ_MUSCRIPTOR_MODEL"] = MODEL_SIZE
    env["VIBESEQ_ENABLE_PROVISIONAL_T4"] = (
        "1" if plan.provisional and enable_provisional_t4 else "0"
    )
    return env


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build and serve the complete VibeSeq Studio on Colab T4."
    )
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--skip-sync", action="store_true")
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--allow-other-cuda", action="store_true")
    parser.add_argument(
        "--enable-provisional-t4",
        action="store_true",
        help=(
            "Enable the unverified T4 SDPA/chunked medium execution path. "
            "Without this flag health remains explicit ready=false."
        ),
    )
    args = parser.parse_args()

    repo = args.repo.expanduser().resolve()
    server = repo / "server"
    if (
        not (server / "pyproject.toml").is_file()
        or not (repo / "package.json").is_file()
    ):
        raise RuntimeError("--repo must point to a complete VibeSeq checkout.")
    pins = load_model_pins(server)
    detected_gpu = gpu_info()
    plan = validate_gpu_target(detected_gpu, args.allow_other_cuda)
    if shutil.which("uv") is None:
        raise RuntimeError("Install uv before running the Colab Studio target.")

    if not args.skip_sync:
        run(
            [
                "uv",
                "sync",
                "--frozen",
                "--project",
                str(server),
                "--extra",
                "models",
            ],
            repo,
        )
    if not args.skip_build:
        install = (
            ["npm", "ci"]
            if (repo / "package-lock.json").is_file()
            else ["npm", "install"]
        )
        run(install, repo)
        run(["npm", "run", "build"], repo)

    studio_dist = repo / "dist"
    if not (studio_dist / "index.html").is_file():
        raise RuntimeError("The Studio build did not produce dist/index.html.")

    env = inference_environment(
        dict(os.environ),
        plan,
        enable_provisional_t4=args.enable_provisional_t4,
    )
    env.setdefault("VIBESEQ_DATA_DIR", str(repo / ".vibeseq-colab-data"))
    env["VIBESEQ_STUDIO_DIST"] = str(studio_dist)
    print(
        "VibeSeq Colab inference: "
        f"gpu={detected_gpu.name} capability={detected_gpu.capability[0]}."
        f"{detected_gpu.capability[1]} target={plan.target} route={plan.route} "
        f"runtime={plan.runtime} "
        f"provisional={str(plan.provisional).lower()} "
        "models=stable-audio-3:medium,muscriptor:medium"
    )
    print(
        "Pinned revisions: "
        f"{pins.stable_id}@{pins.stable_revision} "
        f"code={pins.stable_code_revision}; "
        f"{pins.muscriptor_id}@{pins.muscriptor_revision} "
        f"code={pins.muscriptor_code_revision}"
    )
    if plan.provisional and not args.enable_provisional_t4:
        print(
            "T4 medium execution is disabled pending real-hardware validation; "
            "/api/health will report the provisional route ready=false."
        )
    run(
        [
            "uv",
            "run",
            "--frozen",
            "--project",
            str(server),
            "uvicorn",
            "vibeseq_inference.app:app",
            "--host",
            args.host,
            "--port",
            str(args.port),
        ],
        repo,
        env,
    )


if __name__ == "__main__":
    main()
