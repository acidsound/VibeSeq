from __future__ import annotations

import contextlib
import gc
import json
import os
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

from .security import safe_error_message
from .stable_audio_cuda_worker import generate_with_model, load_stable_audio_model


GIB = 1024**3
MUSCRIPTOR_GPU_MIN_FREE_BYTES = 8 * GIB
FAST_STABLE_DECODE_MIN_FREE_BYTES = 8 * GIB


def _load_muscriptor_model(*, device: str, progress):
    from .muscriptor_cuda_worker import load_muscriptor_model

    return load_muscriptor_model(device=device, progress=progress)


def _muscriptor_weights_cached() -> bool:
    try:
        from .muscriptor_cuda_worker import muscriptor_weights_cached
    except ModuleNotFoundError:
        # Stable Audio is a complete profile on its own. The background preload
        # probe must remain a no-op until the optional MuScriptor profile and
        # its Python dependencies have been installed and verified.
        return False
    return muscriptor_weights_cached()


def _transcribe_with_model(model, **kwargs):
    from .muscriptor_cuda_worker import transcribe_with_model

    return transcribe_with_model(model, **kwargs)


def _wait_for_windows_parent(parent_pid: int) -> None:
    import ctypes
    from ctypes import wintypes

    synchronize = 0x00100000
    infinite = 0xFFFFFFFF
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    handle = kernel32.OpenProcess(synchronize, False, parent_pid)
    if not handle:
        os._exit(0)
    try:
        kernel32.WaitForSingleObject(handle, infinite)
    finally:
        kernel32.CloseHandle(handle)
    # The frozen API sidecar was terminated, so release CUDA, DLL, and runtime
    # file handles even when it could not execute Python atexit handlers.
    os._exit(0)


def _start_parent_watchdog() -> threading.Thread | None:
    if os.name != "nt":
        return None
    try:
        parent_pid = int(os.getenv("VIBESEQ_CUDA_PARENT_PID", ""))
    except ValueError:
        return None
    if parent_pid <= 0:
        return None
    watcher = threading.Thread(
        target=_wait_for_windows_parent,
        args=(parent_pid,),
        name="vibeseq-cuda-parent-watchdog",
        daemon=True,
    )
    watcher.start()
    return watcher


class CudaModelManager:
    """Stable-first model residency policy for the managed Windows CUDA runtime."""

    def __init__(
        self,
        *,
        torch_module=None,
        stable_loader=load_stable_audio_model,
        stable_generator=generate_with_model,
        muscriptor_loader=_load_muscriptor_model,
        muscriptor_transcriber=_transcribe_with_model,
        muscriptor_cache_check=_muscriptor_weights_cached,
    ) -> None:
        self._torch = torch_module
        self._stable_loader = stable_loader
        self._stable_generator = stable_generator
        self._muscriptor_loader = muscriptor_loader
        self._muscriptor_transcriber = muscriptor_transcriber
        self._muscriptor_cache_check = muscriptor_cache_check
        self.stable_model = None
        self.muscriptor_model = None
        self.muscriptor_device: str | None = None

    @property
    def torch(self):
        if self._torch is None:
            import torch

            self._torch = torch
        return self._torch

    def _free_vram(self) -> int:
        free, _total = self.torch.cuda.mem_get_info()
        reserved = int(self.torch.cuda.memory_reserved())
        allocated = int(self.torch.cuda.memory_allocated())
        # Cached allocator blocks are immediately reusable by either resident
        # model, so count them without flushing the cache between requests.
        return int(free) + max(0, reserved - allocated)

    def _evict_muscriptor(self) -> None:
        self.muscriptor_model = None
        self.muscriptor_device = None
        gc.collect()
        self.torch.cuda.empty_cache()

    def _ensure_stable(self, progress) -> None:
        if self.stable_model is not None:
            progress(0.12)
            return
        # Stable Audio owns the primary VRAM budget. A MuScriptor model loaded
        # before the first generation never gets to block Stable residency.
        if self.muscriptor_device == "cuda":
            self._evict_muscriptor()
        progress(0.06)
        started = time.perf_counter()
        self.stable_model = self._stable_loader(progress=progress)
        print(
            "Stable Audio CUDA model loaded in "
            f"{time.perf_counter() - started:.3f}s and retained in VRAM.",
            file=sys.stderr,
        )
        progress(0.28)

    def _load_muscriptor(self, device: str, progress) -> None:
        if self.muscriptor_model is not None and self.muscriptor_device == device:
            return
        self._evict_muscriptor()
        started = time.perf_counter()
        self.muscriptor_model = self._muscriptor_loader(device=device, progress=progress)
        self.muscriptor_device = device
        print(
            f"MuScriptor model loaded on {device} in "
            f"{time.perf_counter() - started:.3f}s.",
            file=sys.stderr,
        )

    def preload_muscriptor_if_safe(self) -> bool:
        if self.stable_model is None or self.muscriptor_model is not None:
            return False
        if not self._muscriptor_cache_check():
            return False
        if self._free_vram() < MUSCRIPTOR_GPU_MIN_FREE_BYTES:
            return False
        try:
            self._load_muscriptor("cuda", lambda _value: None)
            # Measure again after the model owns its allocations. If keeping it
            # would force Stable Audio onto the slower chunked decoder, there
            # was not actually enough headroom for secondary GPU residency.
            if self._free_vram() < FAST_STABLE_DECODE_MIN_FREE_BYTES:
                self._evict_muscriptor()
                return False
            return True
        except Exception as exc:
            if not self._is_oom(exc):
                print(f"MuScriptor background preload skipped: {safe_error_message(exc)}", file=sys.stderr)
            self._evict_muscriptor()
            return False

    def _is_oom(self, error: BaseException) -> bool:
        oom_type = getattr(self.torch.cuda, "OutOfMemoryError", ())
        return (
            (isinstance(oom_type, type) and isinstance(error, oom_type))
            or "out of memory" in str(error).lower()
        )

    def generate(self, request: dict[str, Any], progress) -> dict[str, Any]:
        self._ensure_stable(progress)
        free_vram = self._free_vram()
        if (
            self.muscriptor_device == "cuda"
            and free_vram < FAST_STABLE_DECODE_MIN_FREE_BYTES
        ):
            self._evict_muscriptor()
            free_vram = self._free_vram()
        chunked_decode = free_vram < FAST_STABLE_DECODE_MIN_FREE_BYTES
        started = time.perf_counter()
        try:
            result = self._stable_generator(
                self.stable_model,
                prompt=str(request["prompt"]),
                duration=float(request["duration"]),
                seed=int(request["seed"]),
                output_path=Path(request["outputPath"]),
                progress=progress,
                chunked_decode=chunked_decode,
            )
        except Exception as exc:
            # Stable always wins a VRAM collision. Drop the secondary model and
            # retry once with the lower-memory decoder without reloading Stable.
            retry = self._is_oom(exc) and (
                self.muscriptor_device == "cuda" or not chunked_decode
            )
            if not retry:
                raise
            if self.muscriptor_device == "cuda":
                self._evict_muscriptor()
            result = self._stable_generator(
                self.stable_model,
                prompt=str(request["prompt"]),
                duration=float(request["duration"]),
                seed=int(request["seed"]),
                output_path=Path(request["outputPath"]),
                progress=progress,
                chunked_decode=True,
            )
            chunked_decode = True
        result["inferenceMs"] = round((time.perf_counter() - started) * 1000, 3)
        result["chunkedDecode"] = chunked_decode
        result["stableResident"] = True
        result["muscriptorResident"] = self.muscriptor_device
        print(
            "Stable Audio CUDA generation completed: "
            f"duration={float(request['duration']):.3f}s, "
            f"inference={result['inferenceMs']:.3f}ms, "
            f"chunked_decode={chunked_decode}, "
            f"muscriptor={self.muscriptor_device or 'not-resident'}.",
            file=sys.stderr,
        )
        return result

    def transcribe(self, request: dict[str, Any], progress) -> dict[str, Any]:
        started = time.perf_counter()
        if self.muscriptor_model is None:
            device = "cuda"
            if (
                self.stable_model is not None
                and self._free_vram() < MUSCRIPTOR_GPU_MIN_FREE_BYTES
            ):
                device = "cpu"
            self._load_muscriptor(device, progress)
        notes = self._muscriptor_transcriber(
            self.muscriptor_model,
            input_path=Path(request["inputPath"]),
            output_path=Path(request["outputPath"]),
            progress=progress,
        )
        print(
            "MuScriptor transcription completed: "
            f"device={self.muscriptor_device}, "
            f"elapsed={(time.perf_counter() - started) * 1000:.3f}ms, "
            f"stable_resident={self.stable_model is not None}.",
            file=sys.stderr,
        )
        return {
            "notes": [note.model_dump(by_alias=True) for note in notes],
            "device": self.muscriptor_device,
            "stableResident": self.stable_model is not None,
        }


def _send(stream, value: dict[str, Any]) -> None:
    stream.write(json.dumps(value, separators=(",", ":")) + "\n")
    stream.flush()


def main() -> None:
    _start_parent_watchdog()
    protocol_out = sys.stdout
    manager = CudaModelManager()
    for line in sys.stdin:
        request: Any = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("CUDA service request must be an object.")
            request_id = str(request["id"])
            operation = str(request["operation"])

            def progress(value: float) -> None:
                _send(
                    protocol_out,
                    {"id": request_id, "event": "progress", "value": value},
                )

            with contextlib.redirect_stdout(sys.stderr):
                if operation == "generate":
                    result = manager.generate(request, progress)
                elif operation == "transcribe":
                    result = manager.transcribe(request, progress)
                elif operation == "status":
                    result = {
                        "stableResident": manager.stable_model is not None,
                        "muscriptorResident": manager.muscriptor_device,
                    }
                else:
                    raise ValueError(f"Unknown CUDA service operation: {operation}")
            _send(protocol_out, {"id": request_id, "event": "result", "result": result})
            if operation == "generate":
                with contextlib.redirect_stdout(sys.stderr):
                    manager.preload_muscriptor_if_safe()
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            _send(
                protocol_out,
                {
                    "id": str(request.get("id", "")) if isinstance(request, dict) else "",
                    "event": "error",
                    "message": safe_error_message(exc, limit=1000),
                },
            )


if __name__ == "__main__":
    main()
