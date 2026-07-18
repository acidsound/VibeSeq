from __future__ import annotations

from contextlib import asynccontextmanager
import mimetypes
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .config import (
    GENERATION_PROVIDERS,
    TRANSCRIPTION_PROVIDERS,
    Settings,
)
from .devices import HardwareProbe, available_devices
from .jobs import JobManager
from .models import GenerateRequest, HealthResponse, JobRecord
from .providers import generation_provider, transcription_provider
from .readiness import (
    generation_capability,
    manifest_health,
    transcription_capability,
)
from .storage import Storage
from .storage_paths import model_cache_dir, vibeseq_home


STUDIO_MEDIA_TYPES = {
    ".css": "text/css",
    ".js": "text/javascript",
    ".json": "application/json",
    ".mp3": "audio/mpeg",
    ".wasm": "application/wasm",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}


def configure_studio_media_types() -> None:
    # Python loads MIME overrides from the Windows registry. A machine-level
    # .js association must never turn a successful static response into a
    # module that Chromium refuses to execute.
    for extension, media_type in STUDIO_MEDIA_TYPES.items():
        mimetypes.add_type(media_type, extension, strict=True)


def create_app(settings: Settings | None = None) -> FastAPI:
    configure_studio_media_types()
    config = (settings or Settings.from_env()).validate()
    storage = Storage(config.data_dir)
    jobs = JobManager(storage, workers=config.job_workers)
    generators = {
        name: generation_provider(name, config) for name in GENERATION_PROVIDERS
    }
    transcribers = {
        name: transcription_provider(name, config) for name in TRANSCRIPTION_PROVIDERS
    }

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        jobs.shutdown()

    application = FastAPI(
        title="VibeSeq Inference",
        version=__version__,
        lifespan=lifespan,
    )
    application.state.settings = config
    application.state.storage = storage
    application.state.jobs = jobs
    if config.cors_origins:
        application.add_middleware(
            CORSMiddleware,
            allow_origins=list(config.cors_origins),
            allow_credentials=False,
            allow_methods=["GET", "POST", "DELETE"],
            allow_headers=["Content-Type"],
        )

    @application.get("/api/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        hardware = HardwareProbe.detect()
        devices = available_devices(hardware, force_cpu=config.force_cpu)
        storage_root = vibeseq_home() or config.data_dir.parent
        return HealthResponse(
            version=__version__,
            target=config.target,
            hardware={
                "preferredDevice": devices[0],
                "devices": devices,
                "forceCpu": config.force_cpu,
                "system": hardware.system,
                "machine": hardware.machine,
                "cudaName": hardware.cuda_name,
                "cudaCapability": (
                    list(hardware.cuda_capability)
                    if hardware.cuda_capability is not None
                    else None
                ),
            },
            generation=generation_capability(config, probe=hardware),
            transcription=transcription_capability(config, probe=hardware),
            selectable_providers={
                "generation": sorted(GENERATION_PROVIDERS),
                "transcription": sorted(TRANSCRIPTION_PROVIDERS),
            },
            model_manifest=manifest_health(),
            storage={
                "root": str(storage_root),
                "modelCache": str(model_cache_dir()),
            },
        )

    @application.post(
        "/api/generate",
        response_model=JobRecord,
        status_code=status.HTTP_202_ACCEPTED,
    )
    def generate(request: GenerateRequest, response: Response) -> JobRecord:
        selected = request.provider or config.generation_provider
        provider = generators[selected]

        def task(progress, cancelled):
            asset_id, output_path = storage.allocate_asset(".wav")
            try:
                artifact = provider.generate(
                    request,
                    output_path,
                    progress,
                    cancelled,
                )
                storage.commit_asset(
                    asset_id,
                    output_path,
                    "audio/wav",
                    f"vibeseq-{asset_id[:8]}.wav",
                )
                return {
                    "assetId": asset_id,
                    "assetUrl": f"/api/assets/{asset_id}",
                    "duration": artifact.duration,
                    "sampleRate": artifact.sample_rate,
                    "provider": artifact.provider,
                    "device": artifact.device,
                    "model": artifact.model,
                    "modelId": artifact.model_id,
                    "modelRevision": artifact.model_revision,
                    "codeRevision": artifact.code_revision,
                    "runtime": artifact.runtime,
                    "route": artifact.route,
                    "sourcePeak": artifact.source_peak,
                    "outputPeak": artifact.output_peak,
                    "peakProtectionApplied": artifact.peak_protection_applied,
                    "peakAttenuationDb": artifact.peak_attenuation_db,
                    "peaks": artifact.peaks,
                }
            except Exception:
                storage.discard_asset(asset_id, output_path)
                raise

        job = jobs.submit("generate", task)
        response.headers["Location"] = job.poll_url
        return job

    @application.post(
        "/api/transcribe",
        response_model=JobRecord,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def transcribe(
        response: Response,
        audio: Annotated[UploadFile, File()],
        provider: Annotated[str | None, Form()] = None,
    ) -> JobRecord:
        selected = provider or config.transcription_provider
        if selected not in TRANSCRIPTION_PROVIDERS:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=("provider must be 'signal-demo' or 'muscriptor'."),
            )
        input_path = storage.allocate_upload(audio.filename)
        total_bytes = 0
        try:
            with input_path.open("wb") as destination:
                while chunk := await audio.read(1024 * 1024):
                    total_bytes += len(chunk)
                    if total_bytes > config.max_upload_bytes:
                        raise HTTPException(
                            status_code=413,
                            detail="Uploaded audio is too large.",
                        )
                    destination.write(chunk)
        except Exception:
            storage.remove_upload(input_path)
            raise
        finally:
            await audio.close()
        if total_bytes == 0:
            storage.remove_upload(input_path)
            raise HTTPException(status_code=422, detail="Uploaded audio is empty.")
        selected_provider = transcribers[selected]

        def task(progress, cancelled):
            asset_id, output_path = storage.allocate_asset(".mid")
            try:
                artifact = selected_provider.transcribe(
                    input_path,
                    output_path,
                    progress,
                    cancelled,
                )
                storage.commit_asset(
                    asset_id,
                    output_path,
                    "audio/midi",
                    f"vibeseq-{asset_id[:8]}.mid",
                )
                return {
                    "midiAssetId": asset_id,
                    "midiAssetUrl": f"/api/assets/{asset_id}",
                    "notes": [
                        note.model_dump(by_alias=True) for note in artifact.notes
                    ],
                    "provider": artifact.provider,
                    "device": artifact.device,
                    "model": artifact.model,
                    "modelId": artifact.model_id,
                    "modelRevision": artifact.model_revision,
                    "codeRevision": artifact.code_revision,
                    "runtime": artifact.runtime,
                    "route": artifact.route,
                }
            except Exception:
                storage.discard_asset(asset_id, output_path)
                raise
            finally:
                storage.remove_upload(input_path)

        job = jobs.submit("transcribe", task)
        response.headers["Location"] = job.poll_url
        return job

    @application.get("/api/jobs/{job_id}", response_model=JobRecord)
    def get_job(job_id: str) -> JobRecord:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found.")
        return job

    @application.delete("/api/jobs/{job_id}", response_model=JobRecord)
    def cancel_job(job_id: str) -> JobRecord:
        try:
            job = jobs.cancel(job_id)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found.")
        return job

    @application.get("/api/assets/{asset_id}", response_class=FileResponse)
    def get_asset(asset_id: str) -> FileResponse:
        asset = storage.get_asset(asset_id)
        if asset is None:
            raise HTTPException(status_code=404, detail="Asset not found.")
        return FileResponse(
            asset.path,
            media_type=asset.media_type,
            filename=asset.download_name,
        )

    studio_dist: Path | None = config.studio_dist
    if studio_dist is not None and studio_dist.is_dir():
        application.mount(
            "/",
            StaticFiles(directory=studio_dist, html=True),
            name="studio",
        )
    else:

        @application.get("/", include_in_schema=False)
        def service_root() -> dict[str, str]:
            return {
                "service": "vibeseq-inference",
                "health": "/api/health",
            }

    return application


app = create_app()
