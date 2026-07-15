# VibeSeq release verification

Status: **production gate not yet passed**

Verification date: 2026-07-16

Evidence roots:

- [`artifacts/qa/2026-07-15-real-medium/`](../../artifacts/qa/2026-07-15-real-medium/) — Apple GPU, installed-provider/offline checks, and retained browser evidence
- [`artifacts/qa/2026-07-15-real-medium-cpu-browser/`](../../artifacts/qa/2026-07-15-real-medium-cpu-browser/) — explicitly forced CPU browser workflows and timing samples
- [`artifacts/qa/2026-07-15-capacity/`](../../artifacts/qa/2026-07-15-capacity/) — deterministic core capacity benchmark
- [`artifacts/qa/2026-07-15-audio-integrity/`](../../artifacts/qa/2026-07-15-audio-integrity/) — Chromium stereo-panner algorithm parity report
- [`artifacts/qa/2026-07-15-persistence-recovery/`](../../artifacts/qa/2026-07-15-persistence-recovery/) — quota-failure emergency bundle evidence

This report separates observed results from the release thresholds in
[`production-criteria.md`](production-criteria.md). Fixture-provider tests are
regression coverage, not Stable Audio or MuScriptor quality evidence. Small
timing samples are observations, not p50 or p95 distributions.

## Identifiers and licenses

| Item | Verified identifier |
| --- | --- |
| Studio package | `vibeseq@0.1.0` |
| Git/build revision | No immutable revision is available: the repository has no commit yet. Dated evidence directories are not release provenance. |
| Project schema | Version 4 inside serialization envelope version 1; project sample rate is `44100` or `48000` Hz. Version 1–3 projects migrate to schema 4, with version 1 defaulting to 44.1 kHz and legacy Audio receiving an explicit timebase. The six retained real-Medium project bundles predate this change and remain schema-3 migration evidence, not new schema-4 workflow evidence. |
| Stable Audio weights | `stabilityai/stable-audio-3-optimized@c2949a435de2392fe49c5914c52bc174cfc05a9b`, variant `medium` |
| Stable Audio code | `Stability-AI/stable-audio-3@b32763cf3b71c160f10a0daa4fa0e0d471b5772e` |
| Stable Audio license metadata | Stability AI Community License plus Gemma Terms of Use; deployment must satisfy both upstream terms. |
| MuScriptor weights | `MuScriptor/muscriptor-medium@f32236969308476e01fd3aae67357de5feb05a2d` |
| MuScriptor code | `muscriptor/muscriptor@6c1460cc75e5f120948de7656da05b2c489e8715` |
| MuScriptor license | CC BY-NC 4.0. Commercial production use is blocked unless a separate commercial license is obtained. |
| WebAudio-TinySynth program source | `g200kg/webaudio-tinysynth@3d75aee4b3f43cbd932265e7d60201fd5b770397`, quality-0 `program0`, Apache-2.0 |
| Chaos drum sample source | `surikov/webaudiofontdata@23ca907d4370a04fd89ca483a92915e4d6159ab9`, `128_0_Chaos_sf2_file` notes 36/38/42/46, MIT |

The real adapters reject small-model overrides and never replace a failed real
job with a small or demo provider. Exact route and cache readiness behavior is
documented in [`server/README.md`](../../server/README.md).

## Actually tested configurations

| Target | Configuration | Observed result |
| --- | --- | --- |
| Apple local GPU | MacBook Air, Apple M2, 16 GB unified memory, macOS 26.5.2; Stable Audio Medium on MLX/Metal and MuScriptor Medium on PyTorch MPS | Three consecutive shipping-UI workflows completed. Each generated two candidates with seeds `61061` and `68309`, placed one, extracted 34 notes, edited four notes, arranged four clips across two tracks, played/stopped, reloaded, and exported a project bundle, WAV, and MIDI. See the three `browser-real-medium-run-*-contract.json` files and [`three-run-deterministic-validation.json`](../../artifacts/qa/2026-07-15-real-medium/three-run-deterministic-validation.json). |
| Explicit local CPU fallback | Same Apple M2 host with `VIBESEQ_FORCE_CPU=1`; Stable Audio Medium via `cpu-tflite`/`tflite-w8a8-dyn`, MuScriptor Medium via `cpu-pytorch` | Health reported `forceCpu=true`, CPU-only devices, and no small/demo route. Three consecutive shipping-UI workflows completed with the same seeds and edit/export contract; each extraction returned 55 notes and four were edited. See the three CPU contracts, [`cpu-browser-runtime-metrics.json`](../../artifacts/qa/2026-07-15-real-medium-cpu-browser/cpu-browser-runtime-metrics.json), and [`three-run-deterministic-validation.json`](../../artifacts/qa/2026-07-15-real-medium-cpu-browser/three-run-deterministic-validation.json). |
| Installed providers with network denied | Fresh provider processes after installation; Hugging Face/Transformers offline modes plus an inherited process-level network deny policy | Stable Audio MLX and MuScriptor MPS completed. This proves installed-provider execution, not the complete browser save/reload/export scenario. See [`offline-local-verification.json`](../../artifacts/qa/2026-07-15-real-medium/offline-local-verification.json). |
| Current frontend source/unit baseline | Vitest/jsdom after the cumulative project-boundary, deletion, playback-synchronization, individual-track export, audition, audio-runtime, gesture, rename, and Detail changes | 49 files passed and one skipped; 308 tests passed and one skipped. These are source/domain/component checks, not pointer-layout, browser-audio, persistence, or responsive Playwright evidence. |
| Current production frontend build | TypeScript plus Vite production build after the cumulative integration | Passed; Vite transformed 1,843 modules. A build proves compilation/bundling only. |
| Retained backend regression evidence | Earlier Python test, lint, and format checks; not rerun for this frontend-only cumulative change | 42 pytest cases passed; Ruff check and format check passed. This does not replace real-provider or shipping-browser evidence. |
| Last completed full browser-regression baseline | Chromium-based Playwright against deterministic fixture providers, before the current track/Library/tempo-analysis/AudioWorklet integration | 24 tests passed and one was skipped. This historical full-suite result covers the earlier functional source, Arrangement, Detail, persistence, transport, export, responsive, keyboard, and touch-target paths. It is not a pass for the newly integrated UI. |
| Colab T4 | Not run on an actual T4 runtime | The user explicitly deferred this target. Launcher and readiness tests remain configuration coverage only, so T4 is unverified. |

The ImageGen desktop/mobile candidates remain design references, not product
screens. The implementation contract in
[`functional-ui-implementation-plan.md`](../design/functional-ui-implementation-plan.md)
requires real React/CSS/SVG state and commands and forbids using a candidate
bitmap as the product surface.

## Current integration awaiting batched browser revalidation

The current source implements the items below, but no new complete Playwright
suite has been run after they were integrated. Per the requested workflow, the
expensive browser suite is being batched rather than rerun after each change.
The `24 passed / 1 skipped` result above is the last completed full baseline and
must not be read as evidence for these items:

- direct plus Audio-waveform and plus MIDI-note controls that independently add
  and select the requested track kind without a chooser;
- direct track Move up/down controls, with adjacent Edit/Delete in the
  Track-properties identity row instead of a track-row ellipsis;
- in-place track-name draft semantics (Enter/focus-out commit, Escape cancel),
  desktop/mobile selected-track Inspector access, and undoable complete-track
  deletion/restoration;
- adjacent Edit/Delete in the selected Region identity row, with the same
  in-place Enter/focus-out/Escape/no-op rename contract and undoable Region
  deletion for Audio and MIDI;
- selected-track `Place at playhead`, including explicit MIDI-target and
  occupied-range rejection instead of silent rerouting;
- an IndexedDB-backed global local Sound Library with search, audition, place,
  download, and delete;
- Audio Provenance prompt reuse that copies the exact prompt into Generate
  sound, opens the Create/Generate surface, and focuses the prompt field without
  starting a job or creating project history;
- actionable extracted-MIDI → source-Audio Provenance navigation that selects,
  reveals, scrolls to, and focuses an available Audio Region in Arrangement,
  with a noninteractive `LOST` state for missing/non-Audio parents;
- Worker-based tempo detection for selected Audio and atomic candidate apply;
- Detail collapse/reopen without clearing the selected parent region; real
  pointer/keyboard waveform seek; and pointer/keyboard fade-in/fade-out edits;
- a full `0..127` Piano Roll with fixed 12 px rows, expansion that reveals more
  pitches without stretching notes, shared key/grid scrolling, and black-key
  faces offset upward by half their height, extended two pixels, and layered
  above white-key hit areas;
- real Pencil, Range Select, and Eraser modes; replace/Shift-union marquee;
  source-ID multi-selection; atomic group move/delete; piano-key double-click
  pitch selection; and shared Pitch/Source Length/Velocity editing with mixed
  values and explicit two-direction length stepping. In Pencil, the first click
  selects an unfocused note, a stationary click on that already selected note
  deletes it, body drag moves, right-edge drag resizes, and blank-grid drag
  draws. Eraser drag removes every crossed unique source note in one command;
- selected-note-only Quantize with its division, Strength, and enabled/reasoned
  Apply action grouped immediately below the Note inspector, including the
  retained Note inspector and Quantize controls in the narrow/mobile layout;
- MIDI-note selection and piano-key audition routed through the parent track's
  current channel, General MIDI program, and TinySynth/Chaos profile;
- default AudioWorklet playback, light mixer messages, closed-context re-entry,
  ephemeral candidate/Library audition assets, abort/epoch rejection of stale
  preview continuations, a 5 ms live mute/solo gate ramp, and shared
  TinySynth/Chaos live/offline rendering with the same finite TinySynth
  `release * 8` tail boundary. Offline export intentionally applies the final
  mute/solo state from frame zero rather than rendering a live-control ramp;
- MIDI profile/channel/program Track properties, fixed channel 10 for drums,
  and normalization of legacy missing routing so it cannot block Solo.
- project-boundary history epochs that invalidate queued or in-flight edits
  captured before `replaceState`, so an old project operation cannot commit
  over the replacement state;
- explicit local-project deletion with a destructive confirmation, ordered-save
  drain, active-job cancellation guard, removal of primary and recovery records,
  safe replacement for the open project, and preservation of the global Sound
  Library;
- Play-boundary render-graph/PCM synchronization that checks the engine-owned
  buffer cache rather than trusting UI hash metadata and retries a bounded
  project change during decode, covering the reported reopen → generate/place →
  play stale-asset failure at source level;
- direct individual-track WAV export for every Audio and MIDI track. The target
  is rendered in isolation while retaining project-zero alignment through the
  full arrangement end plus track gain, pan, clips, fades, instrument, and
  master gain; target Mute and unrelated Solo state cannot fabricate a silent
  requested file;
- one-click ZIP export for all individual tracks. Every WAV uses the same
  project-zero/full-arrangement range and render settings; duplicate names stay
  collision-free through ordered filenames, while `manifest.json` records the
  original mixer state and per-stem render metrics. PCM decoding, sequential
  stem rendering, and ZIP packaging remain off the main UI/audio thread;
- Arrangement gesture cancellation on blur, hidden visibility, pointer cancel,
  and owned lost pointer capture; Detail fade/MIDI cancellation on clip change,
  blur, hidden visibility, or pointer cancellation; and rename drafts that can
  submit the same value again until the parent project prop confirms a commit.
- continuous Arrangement ruler scrubbing from pointer-down through drag and
  release, with clamped/snapped seeks and the same cancellation ownership as
  other Arrangement gestures;
- Audio Detail bar/beat lines aligned to the project meter and absolute region
  position, including compound meters such as 6/8; the non-functional local
  `1/16` grid chip has been removed while global snapping remains available.

These are implementation-state statements only. They move into the verified
interaction section after the batched full run and required retained evidence
complete without regressions.

The focused and full unit results plus production build above support the
source/domain contracts, including atomic batch-note normalization and
no-op guards. They do **not** promote any item in this section to browser-verified
status. The first complete Playwright run after this cumulative integration is
still pending by design so the changes can be validated as one batch.

A transient return to the previous project reported while invoking Generate in
a newly created project was classified as a development HMR glitch rather than
a reproduced product defect. It is therefore not counted as a fixed product
bug or as browser verification. The project-boundary history epoch above is a
separate source-level data-integrity guard with unit coverage; the cumulative
project-switch and Generate path still belongs to the pending Playwright batch.

## Verified interaction changes

- Tempo input is a draft while typing. Enter or focus-out commits one undoable
  tempo change; Escape cancels. The bar-duration preview and project BPM do not
  change on each keystroke.
- Seconds-based generated/imported Audio now persists as `fixed-seconds`; a BPM
  edit preserves its seconds, 1× source speed, trim offset, and source-loop
  mapping while rebasing beat geometry. Bar-based generated Audio persists as
  `tempo-follow-repitch`; it retains musical beat length and visibly reports the
  exact varispeed ratio. The UI does not claim pitch-preserving stretch. A
  collision preflight rejects the entire BPM edit rather than creating overlap.
- Live planning, WebAudio scheduling, CPU mixdown, waveform source reads, and
  MuScriptor input use the same Audio timebase. Unit coverage spans 60/120/240
  BPM and 44.1/48 kHz; Chromium browser coverage exercises placement, BPM
  change, Undo/Redo, reload, visible timing labels, and schema-4 bundle export.
- Generation seed accepts the full unsigned 32-bit range. Enter or focus-out
  commits, Escape restores, and Randomize selects a distinct value. The exact
  seed survives request, durable job, candidate, placed asset/clip provenance,
  reload, checkpoint, and `.vibeseq` export/import.
- The three repeated workflows used the same seed pair. Within each route the
  rendered WAV and MIDI hashes were stable across all three runs; the project
  bundle hashes differ because checkpoint identifiers/timestamps are expected
  to differ.
- On the 360 px browser viewport, the generation seed input measured at least
  44 px high, its Randomize control measured 44×44 px after the fix, and
  Generate measured at least 44 px high. This is browser emulation and visual
  inspection, not physical iOS/Android gesture evidence. See
  [`2026-07-15-browser-gut-check-mobile-create-fixed.png`](../../artifacts/qa/2026-07-15-browser-gut-check-mobile-create-fixed.png).
- Offline stereo-input pan now follows Chromium `StereoPannerNode` behavior.
  Ten sample-by-sample comparisons cover 44.1/48 kHz and pan
  −1/−0.5/0/0.5/1; all beat the −90 dBFS threshold and the worst residual is
  −144.49439791871097 dBFS. This is panner-algorithm parity, not a complete
  captured playback-engine null test.
- Checkpoints carry monotonic durability revisions and are globally arbitrated
  across IndexedDB/localStorage. Newer fallback state cannot be replaced by an
  old primary, stale recovery is suppressed, equal-revision divergence errors,
  and memory never acknowledges durability. Quota failure keeps an unsaved
  alert, retry and emergency-bundle actions, and blocks project switching. A
  different-project recovery journal is discovered, recovered, healed back to
  IndexedDB, and retained after browser reload.

## P0 gate matrix

`Partial` means useful evidence exists but the complete acceptance condition has
not been met. It is not a pass.

| Gate | Status | Verified evidence | Missing acceptance evidence |
| --- | --- | --- | --- |
| E2E-01 local GPU core loop | Partial | Three consecutive real-Medium shipping-UI workflows; two deterministic candidates per run; edit, arrange, play, reload, project/WAV/MIDI export; all nine artifacts in the three-run set independently validate | Immutable build identifier and complete retained per-run screen recording/network/backend evidence aligned to these exact three runs |
| E2E-02 CPU desktop core loop | Partial | Three consecutive explicitly forced-CPU workflows; health proves `cpu-tflite` and `cpu-pytorch`; correct project/WAV/MIDI outputs independently validate; API job timings retained | CPU network capture proving no remote calls and complete per-run recording/trace |
| E2E-03 Colab T4 | Deferred / not run | Configuration and launcher coverage only | Fresh real T4 full-Studio run, model load, core loop, recording, and project-bundle round trip; deferred by the user for this milestone |
| GEN-01 generation/cancel/reload | Partial | Exact seed is UI-controlled, submitted, durable, displayed, persisted, exported, and recovered; same route/config/seed produced stable repeated workflow outputs; one real cancellation was acknowledged in 7.60 ms with no committed result or remaining worker | Desktop repeated p50/p95 distributions and reload/crash injection at every asynchronous boundary; T4 measurements belong to the deferred deployment target outside the current goal |
| GEN-02 GPU failure fallback | Partial | Automated exact-Medium single-fallback regression exists; explicit CPU forcing selects only local CPU routes | Real GPU-init/OOM fault-injection trace, one-decision UX recording, and project recovery evidence |
| MIDI-01 extraction corpus | Not run | Real Medium extraction completed on MPS and CPU; silence produced zero notes | Redistributable aligned ground-truth corpus and onset/note/timing accuracy scores |
| MIDI-02 edit then re-extract | Partial | Extracted MIDI was edited, persisted, and exported in all six real browser workflows | Comparable re-extraction version proving prior hand edits remain independent |
| EDIT-01 desktop commands/history | Partial | BPM commits only on Enter/focus-out as one undo item and Escape cancels; seconds versus bars now becomes explicit Audio timebase; fixed-time geometry and tempo-follow repitch round-trip through Undo/Redo, reload, export, live planning, mixdown, and extraction; automated Audio/MIDI/clip/history coverage includes at least 100 ordered undo/redo operations | Batched full revalidation of direct track add/reorder, Track/Region rename/delete, selected-track placement, Library, prompt reuse, linked-Region reveal, tempo analysis, waveform seek/fades, fixed Piano Roll geometry, three tools, marquee/multi-note batch edits, selected-only Quantize, routed note audition, and MIDI-routing UI; remaining command/live/offline matrix including pitch-preserving stretch, transpose, reverse, automation; sampled interaction recordings |
| EDIT-02 mobile gestures | Partial | Responsive browser coverage and the corrected 44×44 seed Randomize target at 360 px | Physical iOS/Android tap, drag, trim, long-press, pinch, and software-keyboard evidence |
| PLAY-01 transport under jobs | Partial | Start/stop/seek and scheduler late-catch-up behavior have browser/unit coverage; play/stop completed in the six real workflows | Full browser revalidation and captured-audio evidence for the new AudioWorklet default, mix-gesture continuity, hidden-page re-entry, action-to-audio latency, cycle/solo stress, and job concurrency |
| PLAY-02 drift/soak | Not run | None | Ten-minute drift analysis and 60-minute playback/edit soak |
| SAVE-01 offline local workflow | Partial | Installed providers ran with process network access denied; a retained browser HAR used only localhost; all real workflows restored edited material after reload | One combined shipping-browser scenario with network denied from open through save, reload, play, and export |
| SAVE-02 fault recovery | Partial | Schema migration, monotonic revisions, cross-backend newest-state arbitration, stale-recovery suppression, explicit conflict, memory false-save prevention, typed quota failure, valid emergency bundle, current-project preservation, and different-project recovery/reload have automated coverage; all six real-media project bundles passed independent schema/base64/SHA-256 validation | Crash/kill injection at every boundary, real quota/IndexedDB endurance, corrupt-one-asset browser bypass/quarantine, history checkpoint persistence, and the deferred Colab round trip |
| EXPORT-01 WAV/MIDI | Partial | Six real-browser 44.1 kHz/24-bit WAV and format-1/480-PPQ MIDI outputs validate; deterministic export and 48 kHz/16-bit behavior have automated coverage; a 10-minute worker export remained browser-responsive; stereo panning passes a 10-case Chromium algorithm null below −90 dBFS | Complete rate/bit-depth/target and trim/fade/loop/transform null matrices, independent audible playback/peak report, and five-minute 24-track export budget |
| RESP-01 browser/device matrix | Partial | Chromium desktop and 360 px mobile visual checks, earlier Playwright responsive coverage, and corrected 44×44 seed Randomize target | Batched revalidation of the current track-properties and Detail surfaces; current/prior Chrome, Edge, Safari, and Firefox plus real iOS Safari and Android Chrome |
| A11Y-01 accessibility | Partial | Keyboard, focus, ARIA, contrast, reduced-motion, and touch-target automated coverage | VoiceOver/NVDA and real-device manual task completion |
| PERF-01 capacity/performance | Partial | Deterministic 10-minute/24-track/250-clip/50,000-note core benchmark; 100 canonical codec round trips; bounded scheduling; one responsive 10-minute browser Worker export; CPU API timing samples | Automation on eight tracks, warm IndexedDB open, desktop/mobile timeline FPS, actual audio underrun/60-minute soak, repeated generate/extract memory cycles, 100 browser save/reloads, 24-track worker export, and p50/p95 samples |
| USER-01 musician acceptance | Not run | None | Moderated study with eight qualified musicians and the defined completion/orientation thresholds |

## P1 gate status

| Gate | Status | Remaining limitation |
| --- | --- | --- |
| MIX-01 mixer state | Partial | Track level/pan/mute/solo are functional and persisted. The current source routes light mixer changes through AudioWorklet and normalizes legacy MIDI routing before Solo, but the batched full browser run, captured continuity, header-versus-Inspector shared-state trace, meter explanation, and interaction recording remain open. |
| PROV-01 source lineage | Partial | Jobs, seeds, candidates, assets, placed clips, and extraction metadata survive real project bundles. The source now implements Audio-prompt reuse and extracted-MIDI → source-Audio reveal with a named missing-parent state, but those navigation paths have not completed the batched browser run or musician usability checkpoint and no release project-graph dump is retained. |

## Measured observations

These are observations on one Apple M2 host. They do not establish throughput
on CUDA, T4, Windows, or Linux.

| Operation | Route and input | Observed result | Scope |
| --- | --- | --- | --- |
| Stable Audio generation | Apple MLX, 10 s output, warm API | 10.439 s | One run; not p95 |
| Stable Audio cancellation | Apple MLX, 30 s request | 7.60 ms acknowledgment | Terminal state `cancelled`; no result committed or worker left |
| Stable Audio CPU generation | LiteRT/XNNPACK, 4 s, 8 steps | 20.89 s; maximum resident bytes 3.69 GB | One provider run |
| Stable Audio CPU generation | LiteRT/XNNPACK, 10 s, 8 steps | 164.92 s; maximum resident bytes 4.71 GB | One provider run |
| Forced-CPU browser generation jobs | `cpu-tflite`, 4 s output | 6 samples: 7.96–26.58 s, mean 17.41 s | API durable timestamps from three workflows; too few for p95 |
| MuScriptor generated-source extraction | Apple MPS, 4 s source | 10.494 s API request-to-asset; 14.981 s direct provider | 18 notes in the older validation sample; no ground truth |
| Forced-CPU browser transcription jobs | `cpu-pytorch`, generated 4 s source | 3 samples: 6.61–9.25 s, mean 7.56 s | API durable timestamps; too few for p95 |
| Browser WAV Worker export | 10 min, 44.1 kHz, stereo PCM16 | 105,840,044 bytes in 3,314 ms; 143 animation-frame ticks; maximum frame gap 50.0 ms | One Chromium observation from [`wav-worker-responsiveness.spec.ts`](../../e2e/wav-worker-responsiveness.spec.ts); not the 24-track reference and no p95 |

The core capacity report realized 24 tracks, 250 clips, and 50,000 MIDI notes,
but zero automation tracks because automation is not represented in the current
project schema. Its synchronous 10-minute PCM24 export took 5.409 s and stalled
the timer for about 5.410 s; that result motivated the Worker path and cannot be
used as UI-responsiveness proof. The newer Worker observation proves that one
large export did not block animation, but it does not close the full capacity
gate.

## Export and artifact validation

The independent validator in
[`scripts/validate-media.mjs`](../../scripts/validate-media.mjs) parses WAV,
MIDI, and `.vibeseq` files. For project bundles it checks UTF-8/JSON, format and
schema versions, project/session structure, canonical base64, declared media
hashes, and every embedded binary's SHA-256.

| Evidence set | Independent result |
| --- | --- |
| Apple GPU three-run set | [`three-run-deterministic-validation.json`](../../artifacts/qa/2026-07-15-real-medium/three-run-deterministic-validation.json) contains nine valid artifacts: three project bundles, three WAV files, and three MIDI files. Each bundle has three verified media references; repeated WAV SHA-256 is `e31246d6db20f862ab9c5091283e9a59fc5a2ddad9b53c356ee9bd8959687b2a`, repeated MIDI SHA-256 is `390b8d08bbf40eece9df3c89664da8e4122a8335d93b91a36bce1333698d1dd5`. |
| Forced CPU three-run set | [`three-run-deterministic-validation.json`](../../artifacts/qa/2026-07-15-real-medium-cpu-browser/three-run-deterministic-validation.json) contains nine valid artifacts with the same project/WAV/MIDI structure. Repeated WAV SHA-256 is `84a782688fe691a61b12f05d18d86b978b4fbf0e6fd4539a0f9c219346ef77ce`; repeated MIDI SHA-256 is `3a4fb9c4c2feb32fdd6efab34641c15c83ab54803d1b1fea7784cc69d9a4aa5b`. |
| Tamper behavior | Automated bundle tests and the validator reject changed bytes, invalid base64, hash mismatches, and unsupported structure before replacing the open project. |
| Stereo pan parity | [`stereo-pan-live-offline-null.json`](../../artifacts/qa/2026-07-15-audio-integrity/stereo-pan-live-offline-null.json) records 10 Chromium comparisons; worst residual is −144.49439791871097 dBFS against a −90 dBFS threshold. |
| Quota emergency bundle | [`Untitled-Sequence-recovery.vibeseq`](../../artifacts/qa/2026-07-15-persistence-recovery/Untitled-Sequence-recovery.vibeseq) independently validates as envelope 1/schema 3, revision `1784118863637003`, BPM 95, 603 bytes, SHA-256 `4d90fe2a6690b6ca1c32a3b1c143377b988b2066a7856fda0e2366038d342d3f`. It intentionally contains no tracks/assets, so it proves coherent current-state emergency export but not quota recovery of embedded media. |

Stable output hashes are documented per runtime route; Apple GPU and CPU hashes
are not expected to be identical to one another.

## Remaining release blockers

P0 blockers:

- MuScriptor Medium is CC BY-NC 4.0. Commercial production remains blocked
  until a separate commercial license is obtained.
- There is no immutable commit/build identifier for the evidence set.
- MuScriptor has not been scored against an aligned ground-truth corpus, so no
  onset F1, note F1, timing-accuracy, or supported-material claim is justified.
- Pitch-preserving stretch, transpose, reverse, and track automation do not yet have the complete
  live/offline/persistence/undo behavior required by the edit and audio-integrity
  gates.
- Ten-minute drift, action-to-audio latency, cycle/solo/job stress, 60-minute
  playback/edit soak, underrun, and remaining click/trim/fade/loop/transform
  null tests remain open; stereo-pan algorithm parity is complete.
- Crash/kill and corrupt-asset browser injection, real quota/IndexedDB
  endurance, history persistence, and repeated memory-cycle gates remain open.
- The current integrated direct track add/reorder and Track/Region
  rename/delete, selected-track placement, Library, prompt reuse, linked-Region
  reveal, tempo analysis, Detail collapse/seek/fades, fixed Piano Roll geometry,
  three tools, marquee/multi-note batch edits, selected-only Quantize, routed
  MIDI note audition, Solo recovery, and AudioWorklet live-control/re-entry paths
  still need their batched full Playwright regression and retained interaction
  evidence.
- The required desktop browser matrix, physical iOS/Android gestures, software
  keyboard behavior, and VoiceOver/NVDA task validation remain open.
- Performance evidence lacks statistically meaningful p50/p95 samples and the
  complete automation/24-track browser reference scenario.
- The moderated `USER-01` study with eight musicians has not been run.

Deferred deployment target outside the current goal:

- The complete Studio has not been run on a real Colab T4. Launcher/readiness
  coverage remains configuration-only; the target-specific gate is deferred,
  not passed.

P1 limitations:

- Mixer/header shared-state and meter comprehension need the required retained
  trace and recording.
- Provenance data is durable, but musicians have not validated source →
  candidate → placement → extraction navigation and edit independence.

## Conclusion

Exact Stable Audio 3 Medium and MuScriptor Medium routes now have three
consecutive real browser workflows on both Apple GPU and explicitly forced CPU.
Their seeds, edits, reloads, project bundles, WAV files, and MIDI files have
concrete local evidence, and all 18 repeated-run exports pass independent
validation. BPM draft/commit behavior, explicit seconds-versus-bars Audio
timebase, stereo-pan algorithm parity, revisioned cross-backend recovery, quota
emergency export, Worker WAV rendering, and the 44 px mobile seed control are
also verified within the scopes stated above.

The source now also contains direct kind-specific track creation, Track/Region
in-place properties, selected-track placement, global Library, prompt reuse,
linked-Region reveal, audio-tempo detection, collapsible Detail, real waveform
seek/fades, fixed-scale Piano Roll, real three-tool and multi-note editing,
selected-only Quantize, routed MIDI note audition, Solo normalization, and
AudioWorklet changes listed above. Current unit/build checks cover their source
contracts, but they are deliberately not counted as browser-verified by the
older `24 passed / 1 skipped` full-suite baseline; the next complete Playwright
run is pending as one batch.

Those results are meaningful progress, but the open P0/P1 evidence and feature
gaps prevent a production-quality claim.

**production gate not yet passed**
