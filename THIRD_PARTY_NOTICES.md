# Third-party notices

This file covers source and media copied or transformed into the VibeSeq source
tree. Package-manager dependencies retain their own license files.

## WebAudio-TinySynth

- Project: <https://github.com/g200kg/webaudio-tinysynth>
- Pinned revision: `3d75aee4b3f43cbd932265e7d60201fd5b770397`
- License: Apache License 2.0
- Used material: the quality-0 `program0` table, transformed into
  `src/core/audio/generated/tinySynthProgram0.ts`

The synchronization script records and verifies the exact source SHA-256 before
generating the TypeScript table. See `scripts/sync-midi-instruments.mjs`.

## WebAudioFont data — Chaos drum samples

- Data project: <https://github.com/surikov/webaudiofontdata>
- Pinned revision: `23ca907d4370a04fd89ca483a92915e4d6159ab9`
- License: MIT
- Catalog: <https://surikov.github.io/webaudiofontdata/sound/drums_2_Chaos_sf2_fileDrum_Room_SC88P.html>
- Used material: notes 36, 38, 42, and 46 from
  `128_0_Chaos_sf2_file`, decoded from the pinned WebAudioFont JavaScript data
  wrappers into the MP3 files under `src/assets/midi/`

VibeSeq uses the MIT-licensed data repository for the bundled samples. It does
not copy the GPL-licensed WebAudioFont player into the application.

## Model licenses

Stable Audio 3 and MuScriptor weights are not committed to this repository.
Their pinned identifiers, applicable upstream terms, and the MuScriptor
commercial-use blocker are recorded in `docs/product/verified-slice.md` and
`server/README.md`.
