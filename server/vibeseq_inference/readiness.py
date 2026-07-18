from __future__ import annotations

from importlib.util import find_spec
from typing import Any

from .config import Settings
from .devices import (
    HardwareProbe,
    RuntimeRoute,
    muscriptor_runtime_route,
    stable_audio_runtime_routes,
)
from .model_manifest import MODEL_MANIFEST, ModelArtifact


def mlx_code_cached() -> bool:
    from .stable_audio_mlx import mlx_code_cached as check

    return check()


def tflite_code_cached() -> bool:
    from .stable_audio_tflite import tflite_code_cached as check

    return check()


def module_installed(module: str) -> bool:
    try:
        return find_spec(module) is not None
    except (ImportError, ModuleNotFoundError, ValueError, AttributeError):
        return False


def cached_files(
    artifact: ModelArtifact,
    filenames: tuple[str, ...],
) -> tuple[bool, tuple[str, ...]]:
    try:
        from huggingface_hub import try_to_load_from_cache
    except ImportError:
        return False, filenames

    missing: list[str] = []
    for filename in filenames:
        cached = try_to_load_from_cache(
            artifact.model_id,
            filename,
            revision=artifact.model_revision,
        )
        if not isinstance(cached, str):
            missing.append(filename)
    return not missing, tuple(missing)


def _route_status(route: RuntimeRoute) -> dict[str, Any]:
    artifact = MODEL_MANIFEST[route.artifact_key]
    missing_packages = tuple(
        name for name in route.required_modules if not module_installed(name)
    )
    package_installed = not missing_packages
    weights_cached, missing_files = cached_files(artifact, route.required_files)
    access_granted: bool | None
    access_evidence: str | None
    if not artifact.gated:
        access_granted = True
        access_evidence = "public-repository"
    elif len(missing_files) < len(route.required_files):
        # At least one file from this exact gated revision is locally cached,
        # which is stronger evidence than merely finding an HF token.
        access_granted = True
        access_evidence = "exact-revision-cache"
    else:
        # A configured token does not prove that its account accepted the gate.
        # Keep this unknown until an exact revision is present in the cache.
        access_granted = None
        access_evidence = None
    if route.id == "apple-mlx":
        code_cached = mlx_code_cached()
    elif route.id == "cpu-tflite":
        code_cached = tflite_code_cached()
    else:
        code_cached = True
    ready = bool(
        package_installed
        and weights_cached
        and code_cached
        and access_granted is True
        and route.hardware_compatible
        and route.adapter_implemented
        and route.execution_enabled
    )

    if ready:
        reason = "Exact medium weights, packages, and runtime route are ready."
    elif not route.adapter_implemented:
        reason = route.reason or "The selected runtime adapter is not implemented."
    elif not route.execution_enabled:
        reason = route.reason or "The selected runtime route is disabled."
    elif not package_installed:
        reason = "Missing runtime package(s): " + ", ".join(missing_packages)
    elif not weights_cached:
        reason = "Exact pinned weights are not fully cached: " + ", ".join(
            missing_files
        )
    elif not code_cached:
        reason = (
            "The exact pinned Stable Audio 3 runtime source is not cached yet; "
            "the first generation bootstraps it locally."
        )
    elif access_granted is not True:
        reason = "Gated model access has not been proven for the exact revision."
    else:
        reason = route.reason or "The runtime route is not ready."

    return {
        "id": route.id,
        "runtime": route.runtime,
        "device": route.device,
        "packageInstalled": package_installed,
        "weightsCached": weights_cached,
        "codeCached": code_cached,
        "accessGranted": access_granted,
        "accessEvidence": access_evidence,
        "runtimeCompatible": route.hardware_compatible,
        "adapterImplemented": route.adapter_implemented,
        "executionEnabled": route.execution_enabled,
        "provisional": route.provisional,
        "ready": ready,
        "missingFiles": list(missing_files),
        "missingPackages": list(missing_packages),
        "requiredPackages": list(route.required_modules),
        "bootstrap": {
            "kind": "huggingface-files",
            "modelId": artifact.model_id,
            "revision": artifact.model_revision,
            "files": list(route.required_files),
            "accessUrl": f"https://huggingface.co/{artifact.model_id}",
            "requiresApproval": artifact.gated,
        },
        "reason": reason,
        **artifact.provenance(),
    }


def _demo_capability(
    *,
    provider: str,
    model: str,
    reason: str,
) -> dict[str, Any]:
    return {
        "available": True,
        "provider": provider,
        "model": model,
        "modelId": f"vibeseq/{model}",
        "modelRevision": "1",
        "codeRepository": None,
        "codeRevision": None,
        "runtime": "vibeseq-fixture",
        "route": "cpu-fixture",
        "device": "cpu",
        "packageInstalled": True,
        "weightsCached": True,
        "accessGranted": True,
        "runtimeCompatible": True,
        "adapterImplemented": True,
        "executionEnabled": True,
        "provisional": False,
        "ready": True,
        "reason": reason,
    }


def generation_capability(
    settings: Settings,
    *,
    probe: HardwareProbe | None = None,
) -> dict[str, Any]:
    if settings.generation_provider == "procedural-demo":
        return _demo_capability(
            provider="procedural-demo",
            model="deterministic-wave-synth-v1",
            reason=(
                "procedural-demo is a deterministic synthesizer fixture, not "
                "Stable Audio 3"
            ),
        )

    routes = stable_audio_runtime_routes(
        settings.target,
        probe=probe,
        enable_provisional_t4=settings.enable_provisional_t4,
        force_cpu=settings.force_cpu,
    )
    route_statuses = [_route_status(route) for route in routes]
    preferred = route_statuses[0]
    selected = next(
        (status for status in route_statuses if status["ready"]),
        preferred,
    )
    return {
        "available": selected["ready"],
        "provider": "stable-audio-3",
        "route": selected["id"],
        "preferredRoute": preferred["id"],
        "routePriority": [status["id"] for status in route_statuses],
        "routeStatuses": route_statuses,
        "fallbackRoutes": [
            status for status in route_statuses if status["id"] != selected["id"]
        ],
        **{key: value for key, value in selected.items() if key != "id"},
    }


def transcription_capability(
    settings: Settings,
    *,
    probe: HardwareProbe | None = None,
) -> dict[str, Any]:
    if settings.transcription_provider == "signal-demo":
        return _demo_capability(
            provider="signal-demo",
            model="monophonic-fft-v1",
            reason="signal-demo is a monophonic FFT fixture, not MuScriptor",
        )

    route = muscriptor_runtime_route(probe, force_cpu=settings.force_cpu)
    route_status = _route_status(route)
    return {
        "available": route_status["ready"],
        "provider": "muscriptor",
        "route": route_status["id"],
        **{key: value for key, value in route_status.items() if key != "id"},
    }


def manifest_health() -> dict[str, dict[str, Any]]:
    return {
        key: artifact.provenance() for key, artifact in sorted(MODEL_MANIFEST.items())
    }
