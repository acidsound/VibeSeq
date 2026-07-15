from __future__ import annotations

import sys

from vibeseq_inference.worker_process import isolated_worker_command


def test_source_worker_uses_python_module(monkeypatch) -> None:
    monkeypatch.delattr(sys, "frozen", raising=False)

    assert isolated_worker_command("mlx", "package.worker") == [
        sys.executable,
        "-m",
        "package.worker",
    ]


def test_frozen_worker_dispatches_through_sidecar(monkeypatch) -> None:
    monkeypatch.setattr(sys, "frozen", True, raising=False)

    assert isolated_worker_command("mlx", "package.worker") == [
        sys.executable,
        "--vibeseq-worker=mlx",
    ]
