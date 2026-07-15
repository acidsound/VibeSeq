from __future__ import annotations

import struct
from collections.abc import Iterable

from .models import NoteResult


def _variable_length(value: int) -> bytes:
    if value < 0:
        raise ValueError("MIDI delta time cannot be negative.")
    output = [value & 0x7F]
    value >>= 7
    while value:
        output.append((value & 0x7F) | 0x80)
        value >>= 7
    return bytes(reversed(output))


def notes_to_midi(
    notes: Iterable[NoteResult], bpm: float = 120.0, ticks_per_beat: int = 480
) -> bytes:
    seconds_per_tick = 60.0 / bpm / ticks_per_beat
    events: list[tuple[int, int, bytes]] = []
    for note in notes:
        start = max(0, round(note.start_time / seconds_per_tick))
        end = max(start + 1, round(note.end_time / seconds_per_tick))
        events.append((start, 1, bytes((0x90, note.pitch, note.velocity))))
        events.append((end, 0, bytes((0x80, note.pitch, 0))))
    events.sort(key=lambda item: (item[0], item[1]))

    tempo = round(60_000_000 / bpm)
    track = bytearray(b"\x00\xff\x51\x03" + tempo.to_bytes(3, "big"))
    track.extend(b"\x00\xc0\x00")
    previous_tick = 0
    for tick, _, event in events:
        track.extend(_variable_length(tick - previous_tick))
        track.extend(event)
        previous_tick = tick
    track.extend(b"\x00\xff\x2f\x00")

    header = b"MThd" + struct.pack(">IHHH", 6, 0, 1, ticks_per_beat)
    return header + b"MTrk" + struct.pack(">I", len(track)) + bytes(track)
