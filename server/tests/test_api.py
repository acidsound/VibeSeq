from __future__ import annotations

import io
import sys
import time
import wave
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

from vibeseq_inference import create_app
from vibeseq_inference.config import Settings
from vibeseq_inference.devices import HardwareProbe


def settings(data_dir: Path, **overrides) -> Settings:
    values = {
        "data_dir": data_dir,
        "generation_provider": "procedural-demo",
        "transcription_provider": "signal-demo",
        "job_workers": 1,
    }
    values.update(overrides)
    return Settings(**values)


def wait_for_job(client: TestClient, job_id: str) -> dict:
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        response = client.get(f"/api/jobs/{job_id}")
        assert response.status_code == 200
        job = response.json()
        if job["status"] in {"completed", "failed", "cancelled"}:
            return job
        time.sleep(0.01)
    raise AssertionError("Job did not reach a terminal state.")


def tone_wav(frequency: float = 440, duration: float = 1.0) -> bytes:
    sample_rate = 44_100
    time_axis = np.arange(round(sample_rate * duration)) / sample_rate
    signal = (np.sin(2 * np.pi * frequency * time_axis) * 0.55 * 32767).astype("<i2")
    output = io.BytesIO()
    with wave.open(output, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(signal.tobytes())
    return output.getvalue()


def test_health_discloses_real_and_demo_providers(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("VIBESEQ_HOME", str(tmp_path))
    with TestClient(create_app(settings(tmp_path))) as client:
        response = client.get("/api/health")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"
        assert body["generation"]["provider"] == "procedural-demo"
        assert body["generation"]["available"] is True
        assert body["generation"]["packageInstalled"] is True
        assert body["generation"]["weightsCached"] is True
        assert body["generation"]["accessGranted"] is True
        assert body["generation"]["runtimeCompatible"] is True
        assert body["generation"]["ready"] is True
        assert "stable-audio-3-medium-pytorch" in body["modelManifest"]
        assert "muscriptor-medium-pytorch" in body["modelManifest"]
        assert body["selectableProviders"]["generation"] == [
            "procedural-demo",
            "stable-audio-3",
        ]
        assert body["selectableProviders"]["transcription"] == [
            "muscriptor",
            "signal-demo",
        ]
        assert body["hardware"]["devices"][-1] == "cpu"
        assert body["storage"]["root"] == str(tmp_path)
        assert body["storage"]["modelCache"].endswith(
            "models/huggingface/hub"
        )


def test_force_cpu_health_keeps_machine_facts_but_selects_cpu_only(
    tmp_path: Path, monkeypatch
) -> None:
    detected = HardwareProbe(
        "Linux",
        "x86_64",
        True,
        (8, 0),
        "NVIDIA A100",
        False,
    )
    monkeypatch.setattr(
        "vibeseq_inference.app.HardwareProbe.detect",
        lambda: detected,
    )
    config = settings(
        tmp_path,
        generation_provider="stable-audio-3",
        transcription_provider="muscriptor",
        force_cpu=True,
    )

    with TestClient(create_app(config)) as client:
        body = client.get("/api/health").json()

    assert body["hardware"] == {
        "preferredDevice": "cpu",
        "devices": ["cpu"],
        "forceCpu": True,
        "system": "Linux",
        "machine": "x86_64",
        "cudaName": "NVIDIA A100",
        "cudaCapability": [8, 0],
    }
    assert body["generation"]["route"] == "cpu-tflite"
    assert body["generation"]["routePriority"] == ["cpu-tflite"]
    assert body["transcription"]["route"] == "cpu-pytorch"


def test_generate_is_deterministic_and_downloadable(tmp_path: Path) -> None:
    request = {
        "prompt": "muted neon bass pulse",
        "duration": 0.8,
        "bpm": 110,
        "seed": 987,
        "provider": "procedural-demo",
    }
    with TestClient(create_app(settings(tmp_path))) as client:
        first_response = client.post("/api/generate", json=request)
        assert first_response.status_code == 202
        assert first_response.headers["location"].startswith("/api/jobs/")
        first = wait_for_job(client, first_response.json()["id"])
        second_response = client.post("/api/generate", json=request)
        second = wait_for_job(client, second_response.json()["id"])
        assert first["status"] == second["status"] == "completed"
        assert first["progress"] == second["progress"] == 1
        assert first["result"]["provider"] == "procedural-demo"
        assert first["result"]["device"] == "cpu"
        assert len(first["result"]["peaks"]) == 256

        first_audio = client.get(first["result"]["assetUrl"])
        second_audio = client.get(second["result"]["assetUrl"])
        assert first_audio.status_code == second_audio.status_code == 200
        assert first_audio.headers["content-type"] == "audio/wav"
        assert first_audio.content[:4] == b"RIFF"
        assert first_audio.content == second_audio.content
        ranged = client.get(first["result"]["assetUrl"], headers={"Range": "bytes=0-3"})
        assert ranged.status_code == 206
        assert ranged.content == b"RIFF"


def test_signal_demo_extracts_actual_pitch_and_writes_midi(tmp_path: Path) -> None:
    with TestClient(create_app(settings(tmp_path))) as client:
        response = client.post(
            "/api/transcribe",
            data={"provider": "signal-demo"},
            files={"audio": ("tone.wav", tone_wav(), "audio/wav")},
        )
        assert response.status_code == 202
        job = wait_for_job(client, response.json()["id"])
        assert job["status"] == "completed", job.get("error")
        result = job["result"]
        assert result["provider"] == "signal-demo"
        assert result["notes"]
        assert any(note["pitch"] == 69 for note in result["notes"])
        assert all(note["endTime"] > note["startTime"] for note in result["notes"])
        midi = client.get(result["midiAssetUrl"])
        assert midi.status_code == 200
        assert midi.content.startswith(b"MThd")


def test_generated_wav_can_be_transcribed_end_to_end(tmp_path: Path) -> None:
    with TestClient(create_app(settings(tmp_path))) as client:
        generation = client.post(
            "/api/generate",
            json={
                "prompt": "roundtrip arpeggio",
                "duration": 1.2,
                "bpm": 100,
                "seed": 82,
                "provider": "procedural-demo",
            },
        )
        generated_job = wait_for_job(client, generation.json()["id"])
        assert generated_job["status"] == "completed"
        generated_audio = client.get(generated_job["result"]["assetUrl"])
        assert generated_audio.status_code == 200

        transcription = client.post(
            "/api/transcribe",
            data={"provider": "signal-demo"},
            files={"audio": ("generated.wav", generated_audio.content, "audio/wav")},
        )
        transcription_job = wait_for_job(client, transcription.json()["id"])
        assert transcription_job["status"] == "completed"
        assert transcription_job["result"]["notes"]
        midi = client.get(transcription_job["result"]["midiAssetUrl"])
        assert midi.status_code == 200
        assert midi.content.startswith(b"MThd")


def test_completed_jobs_and_assets_survive_service_restart(tmp_path: Path) -> None:
    config = settings(tmp_path)
    with TestClient(create_app(config)) as first_client:
        response = first_client.post(
            "/api/generate",
            json={
                "prompt": "persistence fixture",
                "duration": 0.3,
                "bpm": 120,
                "seed": 1,
                "provider": "procedural-demo",
            },
        )
        completed = wait_for_job(first_client, response.json()["id"])
        assert completed["status"] == "completed"

    with TestClient(create_app(config)) as second_client:
        restored = second_client.get(completed["pollUrl"])
        assert restored.status_code == 200
        assert restored.json()["status"] == "completed"
        asset = second_client.get(completed["result"]["assetUrl"])
        assert asset.status_code == 200
        assert asset.content.startswith(b"RIFF")


def test_real_provider_failure_never_substitutes_demo(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setitem(sys.modules, "stable_audio_3", None)
    monkeypatch.setattr(
        "vibeseq_inference.providers.stable_audio.stable_audio_execution_routes",
        lambda *_, **__: (),
    )
    with TestClient(create_app(settings(tmp_path))) as client:
        response = client.post(
            "/api/generate",
            json={
                "prompt": "no implicit fallback",
                "duration": 0.25,
                "bpm": 100,
                "seed": 0,
                "provider": "stable-audio-3",
            },
        )
        job = wait_for_job(client, response.json()["id"])
        assert job["status"] == "failed"
        assert "No implemented Stable Audio 3 medium route" in job["error"]
        assert "No small or demo model was substituted" in job["error"]
        assert job["result"] is None


def test_validation_and_missing_resources(tmp_path: Path) -> None:
    with TestClient(create_app(settings(tmp_path, max_upload_bytes=16))) as client:
        invalid = client.post(
            "/api/generate",
            json={
                "prompt": "x",
                "duration": 0,
                "bpm": 120,
                "seed": 0,
                "provider": "procedural-demo",
            },
        )
        assert invalid.status_code == 422
        too_large = client.post(
            "/api/transcribe",
            data={"provider": "signal-demo"},
            files={"audio": ("large.wav", b"0" * 17, "audio/wav")},
        )
        assert too_large.status_code == 413
        assert client.get("/api/jobs/not-a-job").status_code == 404
        assert client.get("/api/assets/not-an-asset").status_code == 404


def test_static_studio_and_api_share_one_origin(tmp_path: Path) -> None:
    studio_dist = tmp_path / "dist"
    studio_dist.mkdir()
    (studio_dist / "index.html").write_text(
        "<!doctype html><title>VibeSeq fixture</title>", encoding="utf-8"
    )
    config = settings(tmp_path / "data", studio_dist=studio_dist)
    with TestClient(create_app(config)) as client:
        studio = client.get("/")
        health = client.get("/api/health")
        assert studio.status_code == health.status_code == 200
        assert "VibeSeq fixture" in studio.text
        assert health.json()["service"] == "vibeseq-inference"
