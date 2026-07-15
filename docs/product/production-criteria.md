# VibeSeq production criteria

Status: release gate

Latest evaluation: [`verified-slice.md`](verified-slice.md) — **production gate not yet passed** (2026-07-15)

Applies to: desktop local-GPU/CPU Studio, mobile browser interaction, and the separate Colab T4 Studio target

Current milestone scope: the user has explicitly excluded Colab T4 execution.
T4-specific rows remain the future deployment-target gate and are reported as
deferred, not as failures of the current desktop/mobile milestone. This scope
change does not turn launcher or readiness coverage into T4 runtime evidence.

## 1. Definition of production quality

VibeSeq may be described as production quality only when a musician can complete the full loop—generate, place, extract, edit, arrange, play, recover, and export—without hidden source mutation, unexplained timing changes, data loss, or a required network service on the desktop target.

A polished screenshot, successful build, isolated model invocation, or mocked end-to-end test is not sufficient. A release needs all P0 gates below, evidence from real model runs and real browser interaction, and an explicit list of remaining P1/P2 limitations.

## 2. Severity and release policy

| Level | Meaning | Release rule |
| --- | --- | --- |
| P0 | Data loss, wrong render, broken core loop, unsafe level, transport failure, undisclosed network dependency, inaccessible primary operation | Zero open failures; every P0 scenario passes on its stated target |
| P1 | Materially interrupts a real session or makes a supported edit unreliable/ambiguous | Zero known reproducible failures in the core loop; any deferred non-core limitation is documented with workaround |
| P2 | Polish, discoverability, or efficiency issue with a reliable workaround | May ship if documented and scheduled |

## 3. Supported reference tiers

Performance results must state OS/browser, sample rate, model/version, audio duration, warm/cold state, and compute backend. Do not publish a single “fast” number without that context.

| Target | Reference capability | Required behavior |
| --- | --- | --- |
| Desktop local GPU | CUDA-class GPU with at least 8 GB VRAM, or Apple GPU with at least 16 GB unified memory | GPU is detected and preferred; generation and extraction use it; UI/audio remain responsive; out-of-memory has a recoverable path |
| Desktop CPU fallback | 64-bit CPU with at least 8 logical cores and 16 GB RAM | Full Studio still works with clear slower ETA; no feature silently switches to a remote service |
| Colab T4 | A T4 runtime running the complete Studio target | Same project schema and core flow; explicit runtime/session lifetime; project bundle export/import; no claim that Colab is the desktop fallback |
| Mobile interaction | Current stable iOS Safari and Android Chrome on a 360 CSS px-wide viewport or larger | Arrangement, core editing, persistence, and export controls remain usable; generation/extraction capability follows the explicitly opened full-Studio deployment and never silently selects an unrelated remote backend |

The exact minimum hardware may be raised after measurements, but a release must not lower the observable criteria to fit an underpowered reference device.

## 4. P0 acceptance gates

### 4.1 Full workflow

Using only shipping UI and real backends, a tester can:

1. create a project at a chosen tempo and meter;
2. generate at least two real Stable Audio candidates from one prompt;
3. audition both and place one on a chosen track/bar;
4. extract real MIDI from a selected interval with MuScriptor;
5. edit at least one Audio boundary/fade and at least four MIDI notes/velocities;
6. duplicate, split, move, loop, and reorder material into an arrangement;
7. play the result from multiple positions and through a cycle boundary;
8. reload/reopen and recover the same acknowledged state;
9. export a playable mix and MIDI result whose duration/timing matches the project.

Pass condition: three consecutive runs per deployment target complete without manual file repair, developer tools, stale assets from a prior run, or mocked inference.

### 4.2 Musical correctness

| Metric | P0 threshold |
| --- | --- |
| Clip placement | Start/end resolve to the intended sample within 1 output sample after export |
| Bar/beat mapping | Audio, MIDI, playhead, cycle, detail editor, persisted state, and export agree within 1 sample at constant tempo and within 1 scheduling quantum during live playback |
| Loop continuity | No missing/duplicated scheduling block; no introduced boundary click above −60 dBFS on a click-free fixture |
| Seek/start response | Wired desktop action-to-audio p95 ≤ 80 ms after engine warm-up; mobile p95 ≤ 120 ms; first browser audio unlock is measured separately |
| Playhead display | Corrected for reported output latency and within one rendered video frame of audible position at p95 |
| Long playback drift | ≤ 10 ms relative error after 10 minutes on a constant-tempo fixture |
| Export duration | Expected sample count ±1 sample; no truncated tails unless the selected export range explicitly ends them |
| MIDI alignment | Committed extracted MIDI retains source offset; persisted and exported note starts differ from editor values by < 1 tick at the configured PPQ |

### 4.3 Audio integrity

- Project sample rate is explicit and preserved through save/export. The initial required set is 44.1 kHz and 48 kHz.
- Mix export supports stereo WAV at 16-bit and 24-bit PCM. Dither behavior is named and deterministic; 24→16-bit conversion is never an unlabelled truncation.
- Source assets are content-hashed. Arrangement edits do not change their bytes.
- Trim, gain, fades, stretch, transpose, reverse, mute/solo, and loop render consistently between live playback and offline export. A fixture null test must remain below −90 dBFS where real-time and offline algorithms are intended to match.
- NaN, Infinity, denormal runaway, missing buffers, and channel swaps are P0 failures.
- Export reports true peak/peak risk and does not silently normalize or limit. If the mix exceeds the selected format's safe range, warn and let the user choose.
- Start/stop, seek, split, loop, and rapid solo/mute do not add audible clicks to a click-free fixture.

### 4.4 Stable Audio generation

- The shipping model/version, license, target duration range, sample rate, seed behavior, and known content limits are visible in product/help metadata.
- Candidate bytes and generation metadata survive reload before placement.
- Same model/config/seed produces the documented level of reproducibility; if a backend is nondeterministic, the UI does not promise bit identity.
- Generate is asynchronous. During a job, pointer/keyboard input-to-next-paint p95 stays ≤ 50 ms and transport does not block for > 100 ms.
- Cancel is acknowledged in ≤ 100 ms. No canceled result is committed; compute stops by the next safe inference boundary, targeted at ≤ 10 s.
- Warm generation target for a 10-second result is p95 ≤ 30 s on the reference local GPU and T4. CPU fallback target is p95 ≤ 180 s. Results outside the target block the production claim until the supported tier or model is adjusted transparently.
- GPU initialization/OOM failure produces one clear fallback decision and leaves the project intact. It must not loop between backends.

### 4.5 MuScriptor extraction

Use a versioned, redistributable evaluation corpus with clean monophonic melody, bass, isolated drums, chordal/polyphonic material, generated loops, silence, and noisy/unsupported material. Store ground-truth MIDI or annotated onsets beside the fixtures.

| Metric | Required threshold for declared supported classes |
| --- | --- |
| Onset F1 | Median ≥ 0.85 with 50 ms tolerance; no supported fixture < 0.65 |
| Note F1 for pitched material | Median ≥ 0.80 with 50 ms onset and 50-cent pitch tolerance |
| Timing offset after commit | Median absolute error ≤ 20 ms and no systematic project-offset error |
| Empty/silent input | Produces an explicit no-notes result, not fabricated notes or an unhandled error |
| Extraction latency | 30-second clip p95 ≤ 60 s on reference GPU/T4 and ≤ 180 s on CPU fallback after warm-up |

Material classes below threshold must be labelled unsupported/experimental in the UI and excluded from broad “audio to MIDI” quality claims. Extraction never overwrites edited MIDI; a re-run creates a comparable version.

### 4.6 Editing and history

- Move, trim, fade, split, duplicate, loop, gain, transpose/stretch, MIDI add/delete/move/resize, velocity, quantize, track reorder, level/pan, mute/solo, and extraction commit each have regression tests.
- Pointer/touch preview and committed value match. Snapping is deterministic at each supported musical division, including across negative drag direction and clip offsets.
- Fixed and adaptive grids display their effective division. Temporary snap bypass changes only the gesture, not the stored setting.
- At least 100 ordered undoable operations can be reversed and redone without state divergence. Memory-bounded history may compact older operations into recovery checkpoints, but it cannot silently discard the current session's advertised history.
- One continuous pointer/touch/knob gesture creates one undo item. Selection, viewport, audition, and playhead movement do not pollute history.
- Undoing placement preserves its source candidate; undoing extraction commit preserves the prior audio and any earlier MIDI version.

### 4.7 Local-first persistence and recovery

- After required models/assets are installed, the desktop target can create, edit, save, close, reopen, play, and export with network disabled.
- Browser network capture for the offline scenario shows no prompt, audio, MIDI, project, analytics, or model request leaving the device.
- Acknowledged edits reach the durable local journal within 1 second of idle or immediately before close/export. `Saved locally` is shown only after the durable write resolves.
- Kill/crash injection at each core mutation yields either the last acknowledged checkpoint or a clearly offered newer recovery journal. It never opens an internally mixed partial state.
- Asset hashes, clip references, tempo/meter, provenance, automation, and history checkpoint survive project round-trip. Missing/corrupt assets are named and isolated; one bad asset does not make the entire project undeletable or unexportable when it can be bypassed.
- Quota exhaustion and denied storage show required space, retain the last durable state, and offer project-bundle export. They never claim success.
- Project migrations are versioned, forward-only on a copy, and tested from every released schema version.

### 4.8 Export

- Mix export is audible in an independent player and passes format validation.
- MIDI export is a standards-compliant `.mid` file with tempo/meter metadata and separate tracks where the product claims separate tracks.
- Export snapshots one coherent project revision. Edits during export cannot partially enter the file.
- A 5-minute, 24-track reference project exports in ≤ 90 s on the GPU/CPU desktop references excluding model work, while the UI remains responsive.
- File name, format, sample rate, bit depth, range, muted/soloed state, and destination are summarized before export.
- An export failure leaves the project and prior successful exports intact and identifies the failing stage.

### 4.9 Browser and responsive interaction

- Test latest stable and one prior major release of Chrome, Edge, Safari, and Firefox on desktop at release time; test latest stable iOS Safari and Android Chrome on mobile.
- Core composition works at 1280×720 CSS px and at 360×800 CSS px without clipped transport, unreachable dialogs, or horizontal page scrolling outside the timeline itself.
- Minimum touch target is 44×44 CSS px. Clip trim handles remain at least 16 CSS px wide visually/hit-tested when selected without falsifying musical position.
- Pinch zoom retains the time under the gesture centroid within 1 grid pixel. Opening/closing detail retains arrangement scroll and selection.
- Software-keyboard open/close does not hide Stop, lose prompt text, resize the timeline to zero, or commit an unintended edit.
- Browser back/reload/close during an unsaved mutation triggers the supported recovery path.

### 4.10 Accessibility and safety

- Text and essential controls meet WCAG 2.2 AA contrast: 4.5:1 for normal text and 3:1 for large text/essential graphics.
- Every primary desktop flow is keyboard reachable with a visible focus indicator. Screen-reader names include control, state, scope, and value where meaningful.
- Audio/MIDI/generated/extracted/selected/muted/error states are not encoded by color alone.
- `prefers-reduced-motion` removes shimmer, animated panel travel, and nonessential interpolation while preserving progress and playhead meaning.
- Output starts only after an explicit user gesture. Sudden level changes, feedback paths, and clipping risk are controlled or warned; no audition can bypass the master safety path.

## 5. Capacity and endurance gates

Use a reference project of 10 minutes, 24 tracks, 250 clips, 50,000 MIDI notes, automation on eight tracks, and mixed 44.1/48 kHz imported assets.

- Open to interactive arrangement in ≤ 3 s from warm local storage, excluding optional model load.
- Timeline drag/zoom/scroll sustains p95 ≥ 55 FPS desktop and ≥ 45 FPS reference mobile with no gesture stall > 100 ms.
- Audio has zero underruns attributable to the application during a 60-minute playback/edit soak on supported hardware.
- Fifty generate/cancel cycles and fifty extract/commit/undo cycles leave no orphaned project references and no monotonic memory growth > 10% after caches settle and garbage collection opportunities occur.
- Repeated save/reload over 100 cycles produces identical canonical project state and identical source hashes.

## 6. Qualitative musician acceptance

Run moderated sessions with at least eight participants who have arranged music in a DAW within the last year; include at least two keyboard/mouse power users and two phone-first creators.

Each participant receives a musical goal, not UI instructions. They must create an 8–16 bar sketch, generate and place audio, extract/edit MIDI, alter the arrangement, recover one seeded mistake with undo, and export.

Pass conditions:

- ≥ 7/8 complete the full task without facilitator rescue.
- Median full-loop time after onboarding is ≤ 12 minutes.
- 8/8 correctly predict whether audition, place, extract, and re-extract will change the arrangement/source before executing them.
- ≥ 7/8 can identify what is selected, what will be deleted, and whether snap/cycle is active at three seeded checkpoints.
- No participant loses acknowledged work or exports a materially different range/mix than expected.
- Median ratings are ≥ 4/5 for “I stayed oriented in the song,” “AI results became editable material,” and “I would trust reopening this project.”

Record observations and task outcomes; do not replace behavioral evidence with a general satisfaction score.

## 7. QA matrix

Evidence should be stored under a release-specific, repository-relative location such as `artifacts/qa/<release>/`. Logs must omit private prompts/audio unless the fixture license and consent allow retention.

| ID | Pri | Target | Scenario | Expected result | Required evidence |
| --- | --- | --- | --- | --- | --- |
| E2E-01 | P0 | Local GPU desktop | Real prompt → two candidates → place → extract → edit → arrange → reload → export | Three clean consecutive completions | Screen recording, backend log, project bundle, WAV/MIDI validators |
| E2E-02 | P0 | CPU desktop | Disable/withhold GPU and repeat core loop | Explicit CPU backend; no remote calls; correct output | Capability log, network capture, timing table, exported files |
| E2E-03 | P0 | Colab T4 | Start full Studio in fresh runtime and repeat core loop | Same schema/behavior; bundle moves to desktop | Notebook/runtime log, screen recording, round-trip bundle |
| GEN-01 | P0 | GPU/T4/CPU | Generate/cancel/retry/seed and reload candidates | Non-blocking, versioned, durable, honest backend/status | Job traces, hashes, latency percentiles |
| GEN-02 | P0 | Desktop | Force GPU init and OOM failures | Single recoverable CPU decision; no project loss | Fault-injection log and recovery recording |
| MIDI-01 | P0 | All compute | Run versioned extraction corpus | Accuracy/latency thresholds met per supported class | Corpus manifest, metric report, model/version |
| MIDI-02 | P0 | Studio | Edit result, then re-extract | Hand edits preserved; comparable new version | State snapshots and interaction recording |
| EDIT-01 | P0 | Desktop | Full Audio/MIDI/track command regression | Preview, commit, snap, and undo scopes agree | Automated report plus sampled recording |
| EDIT-02 | P0 | Mobile | Tap/drag/trim/long-press/pinch/bottom-sheet flow | No accidental cross-scope edit; targets usable | Real-device recording and gesture telemetry |
| PLAY-01 | P0 | Desktop/mobile | Start/stop/seek/cycle/solo while jobs run | Timing thresholds; zero job-induced transport seize | Loopback capture, scheduler trace, latency report |
| PLAY-02 | P0 | Desktop | 10-minute drift and 60-minute soak | Drift/underrun thresholds met | Audio capture and automated analysis |
| SAVE-01 | P0 | Desktop | Offline edit/save/reload/export | Zero network egress; identical acknowledged state | HAR/network log, canonical diff, export |
| SAVE-02 | P0 | All | Crash/kill/quota/corrupt-one-asset injection | Last checkpoint or explicit recovery; no false save | Fault matrix and recovered bundles |
| EXPORT-01 | P0 | All | WAV 44.1/48 kHz 16/24-bit and MIDI export | Valid headers, duration/timing, audible expected mix | Validator output, null/peak report, independent playback |
| RESP-01 | P0 | Browsers | Viewport/browser compatibility matrix | Core controls reachable and state retained | Automated screenshots, browser versions, interaction traces |
| A11Y-01 | P0 | Desktop/mobile | Keyboard, screen reader, contrast, reduced motion | All primary tasks operable and perceivable | axe/manual report, contrast report, recordings |
| PERF-01 | P0 | Reference tiers | Capacity project and inference benchmarks | Meets interaction, generation, extraction, export budgets | Raw samples and p50/p95 summary |
| USER-01 | P0 | Mixed creators | Moderated full-loop task | Qualitative thresholds met | Script, anonymized outcomes, issue list |
| MIX-01 | P1 | Desktop/mobile | Compare header and expanded mixer state | One shared state; meters and mute/solo explain playback | State trace and recording |
| PROV-01 | P1 | All | Navigate source → placement → extraction versions | Lineage understandable; edits remain independent | Usability checkpoint and project graph dump |

## 8. Release report format

The final release report contains only:

1. commit/build/model/schema identifiers;
2. supported targets and actual tested configurations;
3. P0 matrix with pass/fail and links to evidence;
4. measured p50/p95 performance and extraction-quality results;
5. real end-to-end recordings and exported artifact validators;
6. remaining P1/P2 limitations with exact scope and workaround;
7. a clear conclusion: `production gate passed` or `production gate not yet passed`.

Do not convert an unrun check to “pass,” and do not describe a mocked or synthetic backend as actual generation/extraction.
