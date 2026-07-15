from __future__ import annotations

import hashlib
import math
from pathlib import Path

import numpy as np

from ..audio import peak_envelope, write_pcm16_wave
from ..models import GenerateRequest
from .base import GenerationArtifact, JobCancelled


class ProceduralDemoProvider:
    """Deterministic synthesizer fixture, explicitly not a generative model."""

    name = "procedural-demo"
    sample_rate = 44_100

    def generate(
        self,
        request: GenerateRequest,
        output_path: Path,
        progress,
        cancelled,
    ) -> GenerationArtifact:
        digest = hashlib.sha256(
            f"{request.prompt}\0{request.seed}".encode("utf-8")
        ).digest()
        combined_seed = int.from_bytes(digest[:8], "little")
        rng = np.random.default_rng(combined_seed)
        frame_count = max(1, round(request.duration * self.sample_rate))
        audio = np.zeros((2, frame_count), dtype=np.float32)
        beat_seconds = 60.0 / request.bpm
        step_seconds = beat_seconds / 2
        scale = (0, 3, 5, 7, 10)
        root = 42 + digest[8] % 12
        step_count = math.ceil(request.duration / step_seconds)

        for step in range(step_count):
            if cancelled():
                raise JobCancelled("Generation was cancelled.")
            start = round(step * step_seconds * self.sample_rate)
            end = min(
                frame_count,
                start + round(step_seconds * self.sample_rate * 0.92),
            )
            if end <= start:
                continue
            pitch = root + scale[digest[(step + 9) % len(digest)] % len(scale)]
            if step % 8 in {4, 5}:
                pitch += 12
            frequency = 440.0 * 2 ** ((pitch - 69) / 12)
            local_time = np.arange(end - start, dtype=np.float32) / self.sample_rate
            attack = np.minimum(1.0, local_time / 0.012)
            release = np.minimum(1.0, (end - start - np.arange(end - start)) / 900)
            envelope = attack * release * np.exp(-local_time * 1.7)
            voice = np.sin(2 * np.pi * frequency * local_time) + 0.24 * np.sin(
                4 * np.pi * frequency * local_time + 0.2
            )
            pan = 0.25 + 0.5 * ((step * 0.61803398875) % 1)
            audio[0, start:end] += voice * envelope * (1 - pan) * 0.32
            audio[1, start:end] += voice * envelope * pan * 0.32

            if step % 2 == 0:
                drum_end = min(frame_count, start + round(0.18 * self.sample_rate))
                drum_time = (
                    np.arange(drum_end - start, dtype=np.float32) / self.sample_rate
                )
                kick = np.sin(
                    2 * np.pi * (54 * drum_time + 52 * np.exp(-drum_time * 24))
                ) * np.exp(-drum_time * 24)
                audio[:, start:drum_end] += kick * 0.38
            elif step % 8 in {2, 6}:
                drum_end = min(frame_count, start + round(0.12 * self.sample_rate))
                drum_time = (
                    np.arange(drum_end - start, dtype=np.float32) / self.sample_rate
                )
                noise = rng.standard_normal(drum_end - start).astype(np.float32)
                snare = noise * np.exp(-drum_time * 34) * 0.11
                audio[:, start:drum_end] += snare
            if step % max(1, step_count // 8) == 0:
                progress(min(0.88, 0.08 + 0.8 * step / max(1, step_count)))

        maximum = float(np.max(np.abs(audio)))
        if maximum > 0:
            audio *= 0.88 / maximum
        progress(0.92)
        write_pcm16_wave(output_path, audio, self.sample_rate)
        progress(0.98)
        return GenerationArtifact(
            duration=frame_count / self.sample_rate,
            sample_rate=self.sample_rate,
            provider=self.name,
            device="cpu",
            peaks=peak_envelope(audio),
        )
