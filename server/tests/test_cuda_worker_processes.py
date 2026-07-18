from __future__ import annotations

import pytest

from vibeseq_inference import (
    cuda_service_client,
    stable_audio_tflite,
)


WORKER_MODULES = [cuda_service_client, stable_audio_tflite]


@pytest.mark.parametrize("module", WORKER_MODULES)
def test_windows_workers_never_open_a_console_window(module, monkeypatch) -> None:
    monkeypatch.setattr(module.os, "name", "nt")
    monkeypatch.setattr(
        module.subprocess,
        "CREATE_NO_WINDOW",
        0x08000000,
        raising=False,
    )

    assert module._worker_creation_flags() == 0x08000000


@pytest.mark.parametrize("module", WORKER_MODULES)
def test_non_windows_workers_do_not_set_windows_creation_flags(
    module, monkeypatch
) -> None:
    monkeypatch.setattr(module.os, "name", "posix")

    assert module._worker_creation_flags() == 0
