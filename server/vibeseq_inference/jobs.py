from __future__ import annotations

import threading
import uuid
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone

from .models import JobRecord, JobType
from .providers.base import JobCancelled
from .security import redact_secrets, safe_error_message
from .storage import Storage


Task = Callable[[Callable[[float], None], Callable[[], bool]], dict]


class JobManager:
    def __init__(self, storage: Storage, workers: int = 1) -> None:
        self.storage = storage
        self._executor = ThreadPoolExecutor(
            max_workers=workers,
            thread_name_prefix="vibeseq-inference",
        )
        self._lock = threading.RLock()
        self._jobs: dict[str, JobRecord] = {}
        self._cancel: dict[str, threading.Event] = {}
        self._futures: dict[str, Future] = {}
        self._load()

    def _load(self) -> None:
        for raw in self.storage.load_jobs():
            try:
                job = JobRecord.model_validate(raw)
            except ValueError:
                continue
            error_was_redacted = False
            if job.error is not None:
                safe_error = redact_secrets(job.error)
                error_was_redacted = safe_error != job.error
                job.error = safe_error
            if job.status in {"queued", "running"}:
                job.status = "failed"
                job.error = "Service restarted before the job completed."
                job.updated_at = datetime.now(timezone.utc)
                self._persist(job)
            elif error_was_redacted:
                self._persist(job)
            self._jobs[job.id] = job

    def _persist(self, job: JobRecord) -> None:
        self.storage.save_job(
            job.id,
            job.model_dump(mode="json", by_alias=True),
        )

    @staticmethod
    def _copy(job: JobRecord) -> JobRecord:
        return JobRecord.model_validate(job.model_dump())

    def submit(self, job_type: JobType, task: Task) -> JobRecord:
        job_id = uuid.uuid4().hex
        job = JobRecord.new(job_id, job_type)
        cancellation = threading.Event()
        with self._lock:
            self._jobs[job_id] = job
            self._cancel[job_id] = cancellation
            self._persist(job)
            self._futures[job_id] = self._executor.submit(
                self._run,
                job_id,
                task,
                cancellation,
            )
            return self._copy(job)

    def _run(
        self,
        job_id: str,
        task: Task,
        cancellation: threading.Event,
    ) -> None:
        with self._lock:
            job = self._jobs[job_id]
            if job.status == "cancelled":
                return
            job.status = "running"
            job.progress = max(job.progress, 0.01)
            job.updated_at = datetime.now(timezone.utc)
            self._persist(job)

        def progress(value: float) -> None:
            with self._lock:
                current = self._jobs[job_id]
                if current.status != "running":
                    return
                current.progress = max(current.progress, min(0.99, max(0.0, value)))
                current.updated_at = datetime.now(timezone.utc)
                self._persist(current)

        try:
            result = task(progress, cancellation.is_set)
            with self._lock:
                job = self._jobs[job_id]
                if cancellation.is_set() or job.status == "cancelled":
                    job.status = "cancelled"
                    job.error = None
                else:
                    job.status = "completed"
                    job.progress = 1.0
                    job.result = result
                    job.error = None
                job.updated_at = datetime.now(timezone.utc)
                self._persist(job)
        except JobCancelled:
            with self._lock:
                job = self._jobs[job_id]
                job.status = "cancelled"
                job.error = None
                job.updated_at = datetime.now(timezone.utc)
                self._persist(job)
        except Exception as exc:
            with self._lock:
                job = self._jobs[job_id]
                if cancellation.is_set() or job.status == "cancelled":
                    job.status = "cancelled"
                    job.error = None
                else:
                    job.status = "failed"
                    job.error = safe_error_message(exc)
                job.updated_at = datetime.now(timezone.utc)
                self._persist(job)

    def get(self, job_id: str) -> JobRecord | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return None if job is None else self._copy(job)

    def cancel(self, job_id: str) -> JobRecord | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            if job.status in {"completed", "failed"}:
                raise ValueError("A terminal job cannot be cancelled.")
            self._cancel.setdefault(job_id, threading.Event()).set()
            future = self._futures.get(job_id)
            if future is not None:
                future.cancel()
            job.status = "cancelled"
            job.error = None
            job.updated_at = datetime.now(timezone.utc)
            self._persist(job)
            return self._copy(job)

    def shutdown(self) -> None:
        self._executor.shutdown(wait=True, cancel_futures=True)
