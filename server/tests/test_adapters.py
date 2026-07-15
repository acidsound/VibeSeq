from __future__ import annotations

import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import numpy as np
import pytest

from vibeseq_inference.config import Settings
from vibeseq_inference.audio import write_pcm16_wave
from vibeseq_inference.devices import (
    HardwareProbe,
    RuntimeRoute,
    muscriptor_runtime_route,
    stable_audio_runtime_routes,
)
from vibeseq_inference.model_manifest import (
    MUSCRIPTOR_MEDIUM,
    STABLE_AUDIO_3_MEDIUM,
)
from vibeseq_inference.models import GenerateRequest
from vibeseq_inference.providers.muscriptor import MuScriptorProvider
from vibeseq_inference.providers.factory import (
    generation_provider,
    transcription_provider,
)
from vibeseq_inference.providers.stable_audio import (
    StableAudio3Provider,
    _pinned_stable_audio_files,
)
from vibeseq_inference.stable_audio_mlx import MlxGenerationResult
from vibeseq_inference.stable_audio_tflite import TfliteGenerationResult


class FakeTensor:
    def __init__(self, value: np.ndarray) -> None:
        self.value = value

    def detach(self):
        return self

    def float(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return self.value


def test_stable_audio_adapter_runs_only_pinned_medium_route(
    tmp_path: Path, monkeypatch
) -> None:
    attempts: list[str] = []

    class Model:
        model_config = {"sample_rate": 8_000}

        @classmethod
        def from_pretrained(cls, model_name, device, model_half):
            assert model_name == "medium"
            attempts.append(device)
            assert model_half is True
            return cls()

        def generate(self, **kwargs):
            assert kwargs["seed"] == 7
            assert kwargs["chunked_decode"] is True
            return FakeTensor(np.zeros((1, 2, 2_000), dtype=np.float32))

    module = ModuleType("stable_audio_3")
    module.StableAudioModel = Model
    monkeypatch.setitem(sys.modules, "stable_audio_3", module)
    monkeypatch.setattr(
        "vibeseq_inference.providers.stable_audio._install_pinned_model_config",
        lambda: None,
    )
    route = RuntimeRoute(
        id="cuda-t4-sdpa",
        runtime="pytorch-sdpa",
        device="cuda",
        artifact_key="stable-audio-3-medium-pytorch",
        required_modules=("stable_audio_3",),
        required_files=("model_config.json", "model.safetensors"),
        provisional=True,
    )
    monkeypatch.setattr(
        "vibeseq_inference.providers.stable_audio.stable_audio_execution_routes",
        lambda *_, **__: (route,),
    )
    artifact = StableAudio3Provider("medium").generate(
        GenerateRequest(prompt="fixture", duration=0.25, bpm=120, seed=7),
        tmp_path / "generated.wav",
        lambda _: None,
        lambda: False,
    )
    assert attempts == ["cuda"]
    assert artifact.provider == "stable-audio-3"
    assert artifact.device == "cuda"
    assert artifact.duration == 0.25
    assert artifact.model_id == STABLE_AUDIO_3_MEDIUM.model_id
    assert artifact.model_revision == STABLE_AUDIO_3_MEDIUM.model_revision
    assert artifact.route == "cuda-t4-sdpa"


def test_muscriptor_adapter_falls_back_and_preserves_note_events(
    tmp_path: Path, monkeypatch
) -> None:
    attempts: list[str] = []
    start = SimpleNamespace(
        index=4,
        pitch=62,
        start_time=0.6,
        instrument="electric_bass",
    )
    end = SimpleNamespace(start_event=start, end_time=1.1)

    class Model:
        @classmethod
        def load_model(cls, _, device):
            attempts.append(device)
            if device == "cuda":
                raise RuntimeError("cuda unavailable fixture")
            return cls()

        def transcribe(self, _):
            yield SimpleNamespace(completed=0, total=1)
            yield start
            yield end
            yield SimpleNamespace(completed=1, total=1)

        def events_to_midi_bytes(self, _):
            return b"MThd-fixture"

    module = ModuleType("muscriptor")
    module.TranscriptionModel = Model
    monkeypatch.setitem(sys.modules, "muscriptor", module)
    monkeypatch.setattr(
        "vibeseq_inference.providers.muscriptor._prepare_audio_with_zero_preroll",
        lambda _: ((object(), 16_000), 1.0),
    )
    monkeypatch.setattr(
        "vibeseq_inference.providers.muscriptor.available_devices",
        lambda **_: ["cuda", "cpu"],
    )
    (tmp_path / "config.json").write_text("{}", encoding="utf-8")
    (tmp_path / "model.safetensors").write_bytes(b"fixture")
    downloads: list[tuple[str, str]] = []

    def pinned_download(*, filename, revision, **__):
        downloads.append((filename, revision))
        return str(tmp_path / filename)

    monkeypatch.setattr(
        "huggingface_hub.hf_hub_download",
        pinned_download,
    )
    input_path = tmp_path / "input.wav"
    write_pcm16_wave(input_path, np.ones((1, 16_000), dtype=np.float32), 16_000)
    output_path = tmp_path / "output.mid"
    artifact = MuScriptorProvider("medium").transcribe(
        input_path,
        output_path,
        lambda _: None,
        lambda: False,
    )
    assert attempts == ["cuda", "cpu"]
    assert output_path.read_bytes() == b"MThd-fixture"
    assert artifact.device == "cpu"
    assert artifact.model_id == MUSCRIPTOR_MEDIUM.model_id
    assert artifact.model_revision == MUSCRIPTOR_MEDIUM.model_revision
    assert downloads == [
        ("config.json", MUSCRIPTOR_MEDIUM.model_revision),
        ("model.safetensors", MUSCRIPTOR_MEDIUM.model_revision),
    ]
    assert artifact.notes[0].model_dump(by_alias=True) == {
        "pitch": 62,
        "startTime": 0.1,
        "endTime": 0.6,
        "velocity": 100,
        "instrument": "electric bass",
    }


def test_muscriptor_adds_silent_left_context_and_restores_result_timestamps(
    tmp_path: Path, monkeypatch
) -> None:
    captured_midi_events: list[object] = []

    before = SimpleNamespace(
        index=1,
        pitch=50,
        start_time=0.1,
        instrument="electric_bass",
    )
    boundary = SimpleNamespace(
        index=2,
        pitch=60,
        start_time=0.5,
        instrument="electric_bass",
    )
    crossing = SimpleNamespace(
        index=3,
        pitch=64,
        start_time=0.4,
        instrument="electric_bass",
    )
    second_chunk = SimpleNamespace(
        index=4,
        pitch=67,
        start_time=5.5,
        instrument="electric_bass",
    )

    class Model:
        def transcribe(self, audio):
            waveform, sample_rate = audio
            assert sample_rate == 16_000
            values = waveform.detach().cpu().numpy()[0]
            assert values.shape == (104_000,)
            assert np.count_nonzero(values[:8_000]) == 0
            assert np.all(values[8_000:] > 0.49)
            yield SimpleNamespace(completed=0, total=1)
            yield before
            yield SimpleNamespace(start_event=before, end_time=0.2)
            yield boundary
            yield SimpleNamespace(start_event=boundary, end_time=1.0)
            yield crossing
            yield SimpleNamespace(start_event=crossing, end_time=0.55)
            yield second_chunk
            yield SimpleNamespace(start_event=second_chunk, end_time=6.0)
            yield SimpleNamespace(completed=1, total=1)

        def events_to_midi_bytes(self, events):
            captured_midi_events.extend(events)
            return b"MThd-preroll-fixture"

    provider = MuScriptorProvider("medium")
    monkeypatch.setattr(provider, "_import_model", lambda: object)
    monkeypatch.setattr(provider, "_devices", lambda: ["cpu"])
    monkeypatch.setattr(provider, "_load", lambda _: Model())
    input_path = tmp_path / "boundary-onset.wav"
    write_pcm16_wave(input_path, np.full((1, 96_000), 0.5, dtype=np.float32), 16_000)
    output_path = tmp_path / "boundary-onset.mid"

    artifact = provider.transcribe(
        input_path,
        output_path,
        lambda _: None,
        lambda: False,
    )

    assert output_path.read_bytes() == b"MThd-preroll-fixture"
    assert [note.model_dump(by_alias=True) for note in artifact.notes] == [
        {
            "pitch": 60,
            "startTime": 0.0,
            "endTime": 0.5,
            "velocity": 100,
            "instrument": "electric bass",
        },
        {
            "pitch": 64,
            "startTime": 0.0,
            "endTime": pytest.approx(0.05),
            "velocity": 100,
            "instrument": "electric bass",
        },
        {
            "pitch": 67,
            "startTime": 5.0,
            "endTime": 5.5,
            "velocity": 100,
            "instrument": "electric bass",
        },
    ]
    midi_note_events = [
        event
        for event in captured_midi_events
        if hasattr(event, "start_time") or hasattr(event, "start_event")
    ]
    assert len(midi_note_events) == 6
    assert midi_note_events[0].start_time == 0.0
    assert midi_note_events[1].end_time == 0.5
    assert midi_note_events[2].start_time == 0.0
    assert midi_note_events[3].end_time == pytest.approx(0.05)
    assert midi_note_events[4].start_time == 5.0
    assert midi_note_events[5].end_time == 5.5


def test_target_models_are_medium_and_small_overrides_are_rejected(
    tmp_path: Path,
) -> None:
    local = Settings(data_dir=tmp_path, target="local")
    colab = Settings(data_dir=tmp_path, target="colab-t4")
    assert (local.stable_audio_model, local.muscriptor_model) == (
        "medium",
        "medium",
    )
    assert (colab.stable_audio_model, colab.muscriptor_model) == (
        "medium",
        "medium",
    )

    compatible_cuda = Settings(
        data_dir=tmp_path,
        target="colab-cuda",
        stable_audio_model_override="medium",
        muscriptor_model_override="medium",
    )
    assert (compatible_cuda.stable_audio_model, compatible_cuda.muscriptor_model) == (
        "medium",
        "medium",
    )

    with pytest.raises(ValueError, match="does not silently downgrade"):
        Settings(
            data_dir=tmp_path,
            stable_audio_model_override="small-music",
        ).validate()
    with pytest.raises(ValueError, match="does not silently downgrade"):
        Settings(
            data_dir=tmp_path,
            muscriptor_model_override="small",
        ).validate()


@pytest.mark.parametrize(
    ("probe", "target", "route_id", "runtime", "implemented", "provisional"),
    [
        (
            HardwareProbe("Darwin", "arm64", False, None, None, True),
            "local",
            "apple-mlx",
            "mlx",
            True,
            False,
        ),
        (
            HardwareProbe("Linux", "x86_64", True, (8, 0), "A100", False),
            "colab-cuda",
            "cuda-ampere-fa2",
            "pytorch-fa2",
            True,
            False,
        ),
        (
            HardwareProbe("Linux", "x86_64", True, (7, 5), "T4", False),
            "colab-t4",
            "cuda-t4-sdpa",
            "pytorch-sdpa",
            True,
            True,
        ),
        (
            HardwareProbe("Linux", "x86_64", False, None, None, False),
            "local",
            "cpu-tflite",
            "tflite-w8a8-dyn",
            True,
            False,
        ),
    ],
)
def test_stable_audio_medium_runtime_matrix(
    probe: HardwareProbe,
    target: str,
    route_id: str,
    runtime: str,
    implemented: bool,
    provisional: bool,
) -> None:
    route = stable_audio_runtime_routes(target, probe=probe)[0]
    assert route.id == route_id
    assert route.runtime == runtime
    assert route.adapter_implemented is implemented
    assert route.provisional is provisional


def test_medium_provider_constructors_reject_small_models() -> None:
    with pytest.raises(ValueError, match="small-model fallback is forbidden"):
        StableAudio3Provider("small-music")
    with pytest.raises(ValueError, match="small-model fallback is forbidden"):
        MuScriptorProvider("small")


def test_force_cpu_runtime_and_factory_propagation(tmp_path: Path) -> None:
    probe = HardwareProbe("Darwin", "arm64", False, None, None, True)

    stable_routes = stable_audio_runtime_routes(
        "local",
        probe=probe,
        force_cpu=True,
    )
    muscriptor_route = muscriptor_runtime_route(probe, force_cpu=True)

    assert [route.id for route in stable_routes] == ["cpu-tflite"]
    assert muscriptor_route.id == "cpu-pytorch"
    assert muscriptor_route.device == "cpu"

    settings = Settings(data_dir=tmp_path, force_cpu=True).validate()
    generator = generation_provider("stable-audio-3", settings)
    transcriber = transcription_provider("muscriptor", settings)

    assert isinstance(generator, StableAudio3Provider)
    assert generator.force_cpu is True
    assert [route.id for route in generator._routes()] == ["cpu-tflite"]
    assert isinstance(transcriber, MuScriptorProvider)
    assert transcriber.force_cpu is True
    assert transcriber._devices() == ["cpu"]


def test_stable_audio_apple_route_uses_isolated_medium_mlx_runtime(
    tmp_path: Path, monkeypatch
) -> None:
    route = RuntimeRoute(
        id="apple-mlx",
        runtime="mlx",
        device="metal",
        artifact_key="stable-audio-3-medium-optimized",
        required_modules=("mlx",),
        required_files=("MLX/dit_medium_f16.npz",),
    )
    monkeypatch.setattr(
        "vibeseq_inference.providers.stable_audio.stable_audio_execution_routes",
        lambda *_, **__: (route,),
    )
    calls: list[dict] = []

    def run_fixture(**kwargs):
        calls.append(kwargs)
        sample_rate = 44_100
        samples = np.zeros((round(kwargs["duration"] * sample_rate), 2), dtype="<i2")
        import wave

        with wave.open(str(kwargs["output_path"]), "wb") as handle:
            handle.setnchannels(2)
            handle.setsampwidth(2)
            handle.setframerate(sample_rate)
            handle.writeframes(samples.tobytes())
        return MlxGenerationResult(1.2, 0.98, True, 1.76, 8)

    monkeypatch.setattr(
        "vibeseq_inference.providers.stable_audio.run_mlx_generation",
        run_fixture,
    )
    artifact = StableAudio3Provider("medium").generate(
        GenerateRequest(prompt="medium fixture", duration=0.25, bpm=123, seed=9),
        tmp_path / "mlx.wav",
        lambda _: None,
        lambda: False,
    )
    assert calls[0]["prompt"] == "medium fixture, 123 BPM"
    assert artifact.route == "apple-mlx"
    assert artifact.model == "medium"
    assert artifact.peak_protection_applied is True
    assert artifact.peak_attenuation_db == 1.76


def test_stable_audio_cpu_route_uses_only_medium_tflite_runtime(
    tmp_path: Path, monkeypatch
) -> None:
    route = RuntimeRoute(
        id="cpu-tflite",
        runtime="tflite-w8a8-dyn",
        device="cpu",
        artifact_key="stable-audio-3-medium-optimized",
        required_modules=("ai_edge_litert",),
        required_files=("tflite/sa3-m/dit_w8a8-dyn.tflite",),
    )
    monkeypatch.setattr(
        "vibeseq_inference.providers.stable_audio.stable_audio_execution_routes",
        lambda *_, **__: (route,),
    )
    calls: list[dict] = []

    def run_fixture(**kwargs):
        calls.append(kwargs)
        sample_rate = 44_100
        samples = np.zeros((round(kwargs["duration"] * sample_rate), 2), dtype="<i2")
        import wave

        with wave.open(str(kwargs["output_path"]), "wb") as handle:
            handle.setnchannels(2)
            handle.setsampwidth(2)
            handle.setframerate(sample_rate)
            handle.writeframes(samples.tobytes())
        return TfliteGenerationResult(
            source_peak=1.1,
            output_peak=0.98,
            peak_protection_applied=True,
            peak_attenuation_db=1.0,
            steps=8,
            precision="w8a8-dyn",
            threads=8,
        )

    monkeypatch.setattr(
        "vibeseq_inference.providers.stable_audio.run_tflite_generation",
        run_fixture,
    )
    artifact = StableAudio3Provider("medium").generate(
        GenerateRequest(prompt="portable drums", duration=0.25, bpm=117, seed=11),
        tmp_path / "cpu.wav",
        lambda _: None,
        lambda: False,
    )
    assert calls[0]["prompt"] == "portable drums, 117 BPM"
    assert artifact.route == "cpu-tflite"
    assert artifact.runtime == "tflite-w8a8-dyn"
    assert artifact.model == "medium"
    assert artifact.model_id == "stabilityai/stable-audio-3-optimized"
    assert artifact.peak_protection_applied is True


def test_stable_audio_gpu_failure_falls_back_once_to_exact_medium_cpu(
    tmp_path: Path, monkeypatch
) -> None:
    routes = (
        RuntimeRoute(
            id="apple-mlx",
            runtime="mlx",
            device="metal",
            artifact_key="stable-audio-3-medium-optimized",
            required_modules=("mlx",),
            required_files=("MLX/dit_medium_f16.npz",),
        ),
        RuntimeRoute(
            id="cpu-tflite",
            runtime="tflite-w8a8-dyn",
            device="cpu",
            artifact_key="stable-audio-3-medium-optimized",
            required_modules=("ai_edge_litert",),
            required_files=("tflite/sa3-m/dit_w8a8-dyn.tflite",),
        ),
    )
    monkeypatch.setattr(
        "vibeseq_inference.providers.stable_audio.stable_audio_execution_routes",
        lambda *_, **__: routes,
    )
    attempts: list[str] = []

    def fail_gpu(**_kwargs):
        attempts.append("apple-mlx")
        raise RuntimeError("injected out of memory")

    def run_cpu(**kwargs):
        attempts.append("cpu-tflite")
        sample_rate = 44_100
        samples = np.zeros((round(kwargs["duration"] * sample_rate), 2), dtype="<i2")
        import wave

        with wave.open(str(kwargs["output_path"]), "wb") as handle:
            handle.setnchannels(2)
            handle.setsampwidth(2)
            handle.setframerate(sample_rate)
            handle.writeframes(samples.tobytes())
        return TfliteGenerationResult(
            source_peak=0.5,
            output_peak=0.5,
            peak_protection_applied=False,
            peak_attenuation_db=0.0,
            steps=8,
            precision="w8a8-dyn",
            threads=8,
        )

    monkeypatch.setattr(
        "vibeseq_inference.providers.stable_audio.run_mlx_generation", fail_gpu
    )
    monkeypatch.setattr(
        "vibeseq_inference.providers.stable_audio.run_tflite_generation", run_cpu
    )
    artifact = StableAudio3Provider("medium").generate(
        GenerateRequest(prompt="recoverable route", duration=0.25, bpm=120, seed=12),
        tmp_path / "fallback.wav",
        lambda _: None,
        lambda: False,
    )

    assert attempts == ["apple-mlx", "cpu-tflite"]
    assert artifact.route == "cpu-tflite"
    assert artifact.model == "medium"
    assert artifact.model_id == "stabilityai/stable-audio-3-optimized"


def test_stable_audio_resolver_pins_checkpoint_and_text_encoder(
    tmp_path: Path, monkeypatch
) -> None:
    snapshot = tmp_path / "snapshot"
    for filename in STABLE_AUDIO_3_MEDIUM.files:
        path = snapshot / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"fixture")
    (snapshot / "model_config.json").write_text(
        json.dumps(
            {
                "model": {
                    "conditioning": {
                        "configs": [
                            {
                                "type": "t5gemma",
                                "config": {
                                    "repo_id": STABLE_AUDIO_3_MEDIUM.model_id,
                                    "subfolder": "t5gemma-b-b-ul2",
                                },
                            }
                        ]
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    downloads: list[tuple[str, str]] = []

    def pinned_download(*, filename, revision, **__):
        downloads.append((filename, revision))
        return str(snapshot / filename)

    monkeypatch.setattr("huggingface_hub.hf_hub_download", pinned_download)
    monkeypatch.setattr(
        "vibeseq_inference.providers.stable_audio.user_cache_path",
        lambda *_, **__: tmp_path / "cache",
    )
    config_path, checkpoint_path = _pinned_stable_audio_files()
    config = json.loads(Path(config_path).read_text())
    conditioner = config["model"]["conditioning"]["configs"][0]["config"]
    assert conditioner == {
        "model_path": str(snapshot / "t5gemma-b-b-ul2"),
    }
    assert checkpoint_path == str(snapshot / "model.safetensors")
    assert [filename for filename, _ in downloads] == list(STABLE_AUDIO_3_MEDIUM.files)
    assert {revision for _, revision in downloads} == {
        STABLE_AUDIO_3_MEDIUM.model_revision
    }
