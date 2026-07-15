from __future__ import annotations

from pathlib import Path

from vibeseq_inference.model_manifest import STABLE_AUDIO_3_MEDIUM_OPTIMIZED
from vibeseq_inference import stable_audio_tflite


def test_tflite_weights_are_linked_from_the_exact_medium_revision(
    tmp_path: Path, monkeypatch
) -> None:
    checkout = tmp_path / "checkout"
    root = checkout / "optimized" / "tflite"
    downloads: list[tuple[str, str]] = []

    def pinned_download(*, filename: str, revision: str, **__) -> str:
        downloads.append((filename, revision))
        cached = tmp_path / "hub" / filename
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(filename.encode())
        return str(cached)

    monkeypatch.setattr(stable_audio_tflite, "runtime_checkout", lambda: checkout)
    monkeypatch.setattr(stable_audio_tflite, "hf_hub_download", pinned_download)
    stable_audio_tflite._link_exact_weights()

    assert [name for name, _ in downloads] == [
        "tflite/sa3-m/dit_w8a8-dyn.tflite",
        "tflite/same-l/dec_w8a8-dyn.tflite",
        "tflite/t5gemma/encoder_fp16.tflite",
    ]
    assert {revision for _, revision in downloads} == {
        STABLE_AUDIO_3_MEDIUM_OPTIMIZED.model_revision
    }
    assert (
        (root / "models" / "tflite" / "sa3-m" / "dit_w8a8-dyn.tflite")
        .read_bytes()
        .startswith(b"tflite/sa3-m")
    )


def test_tflite_code_readiness_requires_entrypoint_and_bundled_tokenizer(
    tmp_path: Path, monkeypatch
) -> None:
    root = tmp_path / "runtime"
    (root / "scripts").mkdir(parents=True)
    (root / "models").mkdir(parents=True)
    (root / "scripts" / "sa3_tflite.py").write_text("# fixture")
    monkeypatch.setattr(stable_audio_tflite, "runtime_root", lambda: root)
    monkeypatch.setattr(stable_audio_tflite, "source_checkout_cached", lambda: True)

    assert stable_audio_tflite.tflite_code_cached() is False
    (root / "models" / "tokenizer.model").write_bytes(b"fixture")
    assert stable_audio_tflite.tflite_code_cached() is True
