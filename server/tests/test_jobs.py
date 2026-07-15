from __future__ import annotations

import time
from pathlib import Path

from vibeseq_inference.jobs import JobManager
from vibeseq_inference.models import JobRecord
from vibeseq_inference.providers.base import JobCancelled
from vibeseq_inference.storage import Storage


def test_running_job_can_be_cancelled(tmp_path: Path) -> None:
    manager = JobManager(Storage(tmp_path), workers=1)

    def task(progress, cancelled):
        progress(0.2)
        for _ in range(100):
            if cancelled():
                raise JobCancelled("cancelled")
            time.sleep(0.002)
        return {"unexpected": True}

    try:
        job = manager.submit("generate", task)
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            current = manager.get(job.id)
            assert current is not None
            if current.status == "running":
                break
            time.sleep(0.001)
        cancelled = manager.cancel(job.id)
        assert cancelled is not None
        assert cancelled.status == "cancelled"
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            current = manager.get(job.id)
            assert current is not None
            if current.status == "cancelled":
                break
            time.sleep(0.001)
        assert current.status == "cancelled"
        assert current.result is None
    finally:
        manager.shutdown()


def test_failed_job_redacts_secrets_in_memory_and_storage(
    tmp_path: Path, monkeypatch
) -> None:
    fake_token = "hf_regression_token_never_a_real_credential"
    monkeypatch.setenv("HF_TOKEN", fake_token)
    storage = Storage(tmp_path)
    manager = JobManager(storage, workers=1)

    def task(_progress, _cancelled):
        raise RuntimeError(
            f"download failed HF_TOKEN={fake_token} Authorization: Bearer {fake_token}"
        )

    try:
        job = manager.submit("generate", task)
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            current = manager.get(job.id)
            assert current is not None
            if current.status == "failed":
                break
            time.sleep(0.001)
        assert current.status == "failed"
        assert current.error is not None
        assert fake_token not in current.error
        assert "[REDACTED]" in current.error

        persisted = next(item for item in storage.load_jobs() if item["id"] == job.id)
        assert fake_token not in persisted["error"]
        assert "[REDACTED]" in persisted["error"]
    finally:
        manager.shutdown()


def test_loading_legacy_job_scrubs_persisted_secret(
    tmp_path: Path, monkeypatch
) -> None:
    fake_token = "hf_legacy_regression_token_not_a_credential"
    monkeypatch.setenv("HF_TOKEN", fake_token)
    storage = Storage(tmp_path)
    legacy = JobRecord.new("a" * 32, "generate")
    legacy.status = "failed"
    legacy.error = f"legacy provider failure: {fake_token}"
    storage.save_job(
        legacy.id,
        legacy.model_dump(mode="json", by_alias=True),
    )

    manager = JobManager(storage, workers=1)
    try:
        restored = manager.get(legacy.id)
        assert restored is not None
        assert restored.error is not None
        assert fake_token not in restored.error
        persisted = next(
            item for item in storage.load_jobs() if item["id"] == legacy.id
        )
        assert fake_token not in persisted["error"]
    finally:
        manager.shutdown()
