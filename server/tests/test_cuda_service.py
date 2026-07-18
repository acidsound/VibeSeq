from __future__ import annotations

import json
import queue
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from vibeseq_inference.cuda_service import (
    FAST_STABLE_DECODE_MIN_FREE_BYTES,
    GIB,
    CudaModelManager,
)
from vibeseq_inference.cuda_service_client import CudaServiceClient
from vibeseq_inference.models import NoteResult
from vibeseq_inference import stable_audio_cuda_worker


class FakeOutOfMemoryError(RuntimeError):
    pass


class FakeCuda:
    OutOfMemoryError = FakeOutOfMemoryError

    def __init__(self, free: int) -> None:
        self.free = free
        self.empty_cache_calls = 0

    def mem_get_info(self):
        return self.free, 24 * GIB

    @staticmethod
    def memory_reserved() -> int:
        return 2 * GIB

    @staticmethod
    def memory_allocated() -> int:
        return 1 * GIB

    def empty_cache(self) -> None:
        self.empty_cache_calls += 1


def fake_torch(free: int):
    return SimpleNamespace(cuda=FakeCuda(free))


def stable_result() -> dict[str, object]:
    return {
        "sourcePeak": 0.5,
        "outputPeak": 0.5,
        "peakProtectionApplied": False,
        "peakAttenuationDb": 0.0,
    }


def request(output_path: Path) -> dict[str, object]:
    return {
        "prompt": "persistent fixture",
        "duration": 8.0,
        "seed": 17,
        "outputPath": str(output_path),
    }


def test_stable_cuda_service_import_does_not_require_muscriptor_dependencies() -> None:
    probe = """
import builtins

real_import = builtins.__import__

def stable_only_import(name, *args, **kwargs):
    if name.split('.', 1)[0] in {'muscriptor', 'pydantic'}:
        raise ModuleNotFoundError(name)
    return real_import(name, *args, **kwargs)

builtins.__import__ = stable_only_import
from vibeseq_inference.cuda_service import CudaModelManager
assert callable(CudaModelManager.generate)
"""
    subprocess.run([sys.executable, "-c", probe], check=True)


def test_repeated_stable_generations_reuse_one_loaded_model(tmp_path: Path) -> None:
    loads: list[object] = []
    generated_with: list[object] = []

    def load(*, progress):
        model = object()
        loads.append(model)
        return model

    def generate(model, **_kwargs):
        generated_with.append(model)
        return stable_result()

    manager = CudaModelManager(
        torch_module=fake_torch(12 * GIB),
        stable_loader=load,
        stable_generator=generate,
        muscriptor_cache_check=lambda: False,
    )

    first = manager.generate(request(tmp_path / "first.wav"), lambda _value: None)
    second = manager.generate(request(tmp_path / "second.wav"), lambda _value: None)

    assert len(loads) == 1
    assert generated_with == [loads[0], loads[0]]
    assert first["stableResident"] is True
    assert second["stableResident"] is True


def test_stable_evicts_early_muscriptor_and_retries_oom_without_reloading(
    tmp_path: Path,
) -> None:
    calls: list[bool] = []
    loaded_model = object()

    def generate(model, *, chunked_decode, **_kwargs):
        assert model is loaded_model
        calls.append(chunked_decode)
        if len(calls) == 1:
            raise FakeOutOfMemoryError("CUDA out of memory")
        return stable_result()

    torch_module = fake_torch(FAST_STABLE_DECODE_MIN_FREE_BYTES)
    manager = CudaModelManager(
        torch_module=torch_module,
        stable_loader=lambda **_kwargs: loaded_model,
        stable_generator=generate,
        muscriptor_cache_check=lambda: False,
    )
    manager.muscriptor_model = object()
    manager.muscriptor_device = "cuda"

    result = manager.generate(request(tmp_path / "retry.wav"), lambda _value: None)

    assert calls == [False, True]
    assert result["chunkedDecode"] is True
    assert manager.stable_model is loaded_model
    assert manager.muscriptor_model is None
    assert torch_module.cuda.empty_cache_calls == 1


def test_muscriptor_preloads_only_when_stable_has_vram_headroom() -> None:
    loads: list[str] = []
    roomy = CudaModelManager(
        torch_module=fake_torch(12 * GIB),
        muscriptor_loader=lambda *, device, progress: loads.append(device) or object(),
        muscriptor_cache_check=lambda: True,
    )
    roomy.stable_model = object()

    assert roomy.preload_muscriptor_if_safe() is True
    assert loads == ["cuda"]
    assert roomy.muscriptor_device == "cuda"

    constrained_loads: list[str] = []
    constrained = CudaModelManager(
        torch_module=fake_torch(4 * GIB),
        muscriptor_loader=lambda *, device, progress: constrained_loads.append(device),
        muscriptor_cache_check=lambda: True,
    )
    constrained.stable_model = object()
    assert constrained.preload_muscriptor_if_safe() is False
    assert constrained_loads == []


def test_muscriptor_preload_is_reverted_if_it_consumes_stable_headroom() -> None:
    torch_module = fake_torch(12 * GIB)

    def load(*, device, progress):
        assert device == "cuda"
        torch_module.cuda.free = 6 * GIB
        return object()

    manager = CudaModelManager(
        torch_module=torch_module,
        muscriptor_loader=load,
        muscriptor_cache_check=lambda: True,
    )
    manager.stable_model = object()

    assert manager.preload_muscriptor_if_safe() is False
    assert manager.muscriptor_model is None
    assert manager.muscriptor_device is None


def test_stable_evicts_muscriptor_before_it_forces_chunked_decode(
    tmp_path: Path,
) -> None:
    torch_module = fake_torch(6 * GIB)
    chunked_calls: list[bool] = []

    def generate(_model, *, chunked_decode, **_kwargs):
        chunked_calls.append(chunked_decode)
        return stable_result()

    manager = CudaModelManager(
        torch_module=torch_module,
        stable_generator=generate,
        muscriptor_cache_check=lambda: False,
    )
    manager.stable_model = object()
    manager.muscriptor_model = object()
    manager.muscriptor_device = "cuda"

    # Releasing MuScriptor returns enough VRAM for Stable's fast decoder.
    original_evict = manager._evict_muscriptor

    def evict() -> None:
        original_evict()
        torch_module.cuda.free = 12 * GIB

    manager._evict_muscriptor = evict  # type: ignore[method-assign]

    result = manager.generate(request(tmp_path / "fast.wav"), lambda _value: None)

    assert chunked_calls == [False]
    assert result["chunkedDecode"] is False
    assert manager.muscriptor_model is None


def test_muscriptor_uses_cpu_when_stable_owns_constrained_vram(tmp_path: Path) -> None:
    devices: list[str] = []
    note = NoteResult(
        pitch=60,
        start_time=0.0,
        end_time=1.0,
        velocity=100,
        instrument="piano",
    )
    manager = CudaModelManager(
        torch_module=fake_torch(4 * GIB),
        muscriptor_loader=lambda *, device, progress: devices.append(device) or object(),
        muscriptor_transcriber=lambda *_args, **_kwargs: [note],
    )
    manager.stable_model = object()

    result = manager.transcribe(
        {
            "inputPath": str(tmp_path / "input.wav"),
            "outputPath": str(tmp_path / "output.mid"),
        },
        lambda _value: None,
    )

    assert devices == ["cpu"]
    assert result["device"] == "cpu"
    assert result["stableResident"] is True


def test_cuda_generation_uses_exact_duration_and_eight_steps(
    tmp_path: Path, monkeypatch
) -> None:
    calls: list[dict[str, object]] = []

    class Generated:
        def detach(self):
            return self

        def float(self):
            return self

        def cpu(self):
            return self

        @staticmethod
        def numpy():
            return np.zeros((1, 2, 16), dtype=np.float32)

    class Model:
        model_config = {"sample_rate": 44_100}

        @staticmethod
        def generate(**kwargs):
            calls.append(kwargs)
            return Generated()

    def write_fixture(path, _audio, _sample_rate, metadata_path, *, steps):
        Path(path).write_bytes(b"RIFF-fixture")
        metadata_path.write_text(
            json.dumps({
                "sourcePeak": 0.0,
                "outputPeak": 0.0,
                "peakProtectionApplied": False,
                "peakAttenuationDb": 0.0,
                "steps": steps,
            }),
            encoding="utf-8",
        )

    monkeypatch.setattr(stable_audio_cuda_worker, "_write_protected_pcm16", write_fixture)
    stable_audio_cuda_worker.generate_with_model(
        Model(),
        prompt="exact duration",
        duration=12.0,
        seed=3,
        output_path=tmp_path / "exact.wav",
        progress=lambda _value: None,
        chunked_decode=False,
    )

    assert calls == [{
        "prompt": "exact duration",
        "duration": 12.0,
        "steps": 8,
        "seed": 3,
        "duration_padding_sec": 0.0,
        "chunked_decode": False,
    }]


def test_cuda_service_client_keeps_process_between_requests(tmp_path: Path) -> None:
    client = CudaServiceClient()
    starts: list[Path] = []

    class Input:
        def __init__(self, messages):
            self.messages = messages

        def write(self, value: str) -> None:
            request_value = json.loads(value)
            self.messages.put({
                "id": request_value["id"],
                "event": "result",
                "result": {"call": request_value["operation"]},
            })

        @staticmethod
        def flush() -> None:
            return None

    class Process:
        def __init__(self, messages):
            self.stdin = Input(messages)

        @staticmethod
        def poll():
            return None

    def start(python: Path) -> None:
        starts.append(python)
        messages: queue.Queue[dict[str, object]] = queue.Queue()
        client._process = Process(messages)  # type: ignore[assignment]
        client._python = python
        client._messages = messages  # type: ignore[assignment]

    client._start_unlocked = start  # type: ignore[method-assign]
    python = tmp_path / "python.exe"
    first = client.request(
        python=python,
        operation="generate",
        payload={},
        progress=lambda _value: None,
        cancelled=lambda: False,
    )
    second = client.request(
        python=python,
        operation="transcribe",
        payload={},
        progress=lambda _value: None,
        cancelled=lambda: False,
    )

    assert starts == [python]
    assert first == {"call": "generate"}
    assert second == {"call": "transcribe"}
