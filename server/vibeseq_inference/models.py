from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


def _camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_camel,
        populate_by_name=True,
        extra="forbid",
    )


class GenerateRequest(ApiModel):
    prompt: str = Field(min_length=1, max_length=2000)
    duration: float = Field(ge=0.25, le=380)
    bpm: float = Field(ge=30, le=300)
    seed: int = Field(ge=0, le=2**32 - 1)
    provider: Literal["procedural-demo", "stable-audio-3"] | None = None


class NoteResult(ApiModel):
    pitch: int = Field(ge=0, le=127)
    start_time: float = Field(ge=0)
    end_time: float = Field(gt=0)
    velocity: int = Field(ge=1, le=127)
    instrument: str


JobStatus = Literal["queued", "running", "completed", "failed", "cancelled"]
JobType = Literal["generate", "transcribe"]


class JobRecord(ApiModel):
    id: str
    type: JobType
    status: JobStatus
    progress: float = Field(ge=0, le=1)
    created_at: datetime
    updated_at: datetime
    result: dict[str, Any] | None = None
    error: str | None = None
    poll_url: str

    @classmethod
    def new(cls, job_id: str, job_type: JobType) -> "JobRecord":
        now = datetime.now(timezone.utc)
        return cls(
            id=job_id,
            type=job_type,
            status="queued",
            progress=0,
            created_at=now,
            updated_at=now,
            poll_url=f"/api/jobs/{job_id}",
        )


class HealthResponse(ApiModel):
    status: Literal["ok"] = "ok"
    service: str = "vibeseq-inference"
    version: str
    target: str
    hardware: dict[str, Any]
    generation: dict[str, Any]
    transcription: dict[str, Any]
    selectable_providers: dict[str, list[str]]
    model_manifest: dict[str, dict[str, Any]]
