from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from ..audio import AudioFormatError, read_wave
from ..midi import notes_to_midi
from ..models import NoteResult
from .base import JobCancelled, ProviderError, TranscriptionArtifact


class SignalDemoProvider:
    """Basic monophonic FFT transcriber fixture, explicitly not MuScriptor."""

    name = "signal-demo"

    def transcribe(
        self,
        input_path: Path,
        output_path: Path,
        progress,
        cancelled,
    ) -> TranscriptionArtifact:
        try:
            audio, sample_rate = read_wave(input_path)
        except AudioFormatError as exc:
            raise ProviderError(str(exc)) from exc
        mono = np.mean(audio, axis=0, dtype=np.float32)
        if mono.size < max(256, sample_rate // 20):
            raise ProviderError("Audio is too short for signal-demo transcription.")
        progress(0.1)
        notes = self._extract_notes(mono, sample_rate, progress, cancelled)
        if cancelled():
            raise JobCancelled("Transcription was cancelled.")
        output_path.write_bytes(notes_to_midi(notes))
        progress(0.98)
        return TranscriptionArtifact(
            notes=notes,
            provider=self.name,
            device="cpu",
        )

    @staticmethod
    def _extract_notes(mono, sample_rate, progress, cancelled) -> list[NoteResult]:
        frame_size = 4096
        while frame_size > mono.size and frame_size > 512:
            frame_size //= 2
        hop = max(128, frame_size // 4)
        window = np.hanning(frame_size).astype(np.float32)
        frequencies = np.fft.rfftfreq(frame_size, 1 / sample_rate)
        valid = np.flatnonzero((frequencies >= 50) & (frequencies <= 2_000))
        frame_starts = range(0, max(1, mono.size - frame_size + 1), hop)
        frame_starts = list(frame_starts)
        if frame_starts[-1] + frame_size < mono.size:
            frame_starts.append(mono.size - frame_size)
        rms_values = np.array(
            [
                math.sqrt(float(np.mean(mono[start : start + frame_size] ** 2)))
                for start in frame_starts
            ],
            dtype=np.float32,
        )
        gate = max(0.004, float(np.percentile(rms_values, 90)) * 0.12)
        detected: list[tuple[float, int | None, float]] = []

        for index, (start, rms) in enumerate(
            zip(frame_starts, rms_values, strict=True)
        ):
            if cancelled():
                raise JobCancelled("Transcription was cancelled.")
            pitch: int | None = None
            if rms >= gate:
                spectrum = np.abs(
                    np.fft.rfft(mono[start : start + frame_size] * window)
                )
                local_peak = int(np.argmax(spectrum[valid]))
                peak_index = int(valid[local_peak])
                if 0 < peak_index < spectrum.size - 1:
                    left, center, right = np.log(
                        spectrum[peak_index - 1 : peak_index + 2] + 1e-12
                    )
                    denominator = left - 2 * center + right
                    offset = (
                        0.0
                        if abs(denominator) < 1e-12
                        else 0.5 * (left - right) / denominator
                    )
                else:
                    offset = 0.0
                frequency = (peak_index + float(offset)) * sample_rate / frame_size
                if frequency > 0:
                    midi_pitch = round(69 + 12 * math.log2(frequency / 440.0))
                    if 0 <= midi_pitch <= 127:
                        pitch = midi_pitch
            detected.append((start / sample_rate, pitch, float(rms)))
            if index % max(1, len(frame_starts) // 10) == 0:
                progress(0.15 + 0.65 * index / max(1, len(frame_starts)))

        notes: list[NoteResult] = []
        current_pitch: int | None = None
        current_start = 0.0
        current_levels: list[float] = []
        frame_duration = frame_size / sample_rate

        def finish(end_time: float) -> None:
            nonlocal current_pitch, current_levels
            if current_pitch is None or end_time - current_start < 0.07:
                current_pitch = None
                current_levels = []
                return
            level = float(np.median(current_levels)) if current_levels else gate
            velocity = int(np.clip(42 + 42 * level / max(gate, 1e-6), 42, 122))
            notes.append(
                NoteResult(
                    pitch=current_pitch,
                    start_time=round(current_start, 5),
                    end_time=round(min(end_time, mono.size / sample_rate), 5),
                    velocity=velocity,
                    instrument="signal dominant pitch",
                )
            )
            current_pitch = None
            current_levels = []

        for time_value, pitch, rms in detected:
            if pitch == current_pitch:
                if pitch is not None:
                    current_levels.append(rms)
                continue
            if current_pitch is not None:
                finish(time_value + frame_duration / 2)
            if pitch is not None:
                current_pitch = pitch
                current_start = time_value
                current_levels = [rms]
        if current_pitch is not None:
            finish(mono.size / sample_rate)
        progress(0.88)
        return notes
