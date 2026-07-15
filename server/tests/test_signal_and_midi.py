from __future__ import annotations

from pathlib import Path

from vibeseq_inference.midi import notes_to_midi
from vibeseq_inference.models import NoteResult
from vibeseq_inference.storage import Storage


def test_midi_encoder_emits_valid_format_zero_file() -> None:
    content = notes_to_midi(
        [
            NoteResult(
                pitch=60,
                start_time=0,
                end_time=0.5,
                velocity=96,
                instrument="piano",
            ),
            NoteResult(
                pitch=64,
                start_time=0.5,
                end_time=1,
                velocity=88,
                instrument="piano",
            ),
        ],
        bpm=120,
    )
    assert content[:4] == b"MThd"
    assert content[8:14] == b"\x00\x00\x00\x01\x01\xe0"
    assert b"MTrk" in content
    assert content.endswith(b"\x00\xff\x2f\x00")


def test_storage_rejects_path_like_asset_ids(tmp_path: Path) -> None:
    storage = Storage(tmp_path)
    assert storage.get_asset("../secret") is None
