# Functional UI implementation plan

Status: implementation contract

Implementation snapshot: 2026-07-16 source inventory; release verification and production gate remain open

Visual source: `docs/design/candidates/a-desktop.png` and `docs/design/candidates/a-mobile.png`

Product source: `docs/product/interaction-model.md`

Arrangement interaction source: `docs/product/arrangement-clip-interaction-contract.md`

Detail-editor interaction source: `docs/product/detail-editor-interaction-contract.md`

## 1. Non-negotiable rule

Candidate A is a visual direction, not a bitmap to reproduce. Every rendered element must be one of:

1. a control that executes a real command;
2. a live or persisted state indicator backed by product data;
3. a content visualization derived from real Audio, MIDI, selection, time, or job data;
4. a clearly worded empty, loading, unavailable, or error state.

An icon, meter, waveform, handle, chevron, tab, selector, progress value, or status light that suggests interaction or live data cannot be decorative. Features that do not yet meet this contract stay out of the interface instead of appearing as disabled mock controls.

The production default opens an honest blank/local project. Synthetic visual-demo assets remain test fixtures only and are never presented as user media.

## 2. Shared state model

Desktop and mobile are different presentations of the same commands and state. Neither surface owns a parallel implementation.

| Visible concept | Source of truth | Required command or feedback |
| --- | --- | --- |
| Project name/menu | persisted `Project` and local project catalog | rename, create, open, delete with confirmation, import, export |
| Transport/readout | playback engine and project clock | play/pause, stop, seek, cycle, stable bar/beat/tick |
| Master/track meters | Web Audio graph analyzers | live levels while auditioning/playing, zero at rest, clipping warning |
| Snap/grid | editor state | toggle and effective division shown everywhere it applies |
| Timeline ruler/cycle | project clock and loop range | seek and edit loop boundaries with snapped preview/commit |
| Tracks | persisted track order/mix/routing state | select, direct plus Audio-waveform / plus MIDI-note creation, direct Move up/down, level, pan, mute, solo; rename/delete from Track properties with Undo |
| Audio region | source asset plus clip transform | select, move, trim, split, duplicate, delete, in-place rename, gain, fades, reuse a stored generation prompt without mutating the Region |
| MIDI region/notes | persisted note events | Region in-place rename/delete; Pencil draw, Range Select marquee/group editing, Eraser, resize, batch pitch/length/velocity, selected-note quantize |
| Waveform | decoded/cached source peaks | never random; missing media receives a named placeholder |
| Candidate | durable generation result | progress, cancel, audition through an ephemeral Worklet asset, place, retain after placement/undo |
| Extraction lineage | source and derived IDs | extract selected interval, select linked result, show actual model metadata |
| Detail editor | current primary selection | shared playhead/time mapping and selection-specific commands |
| Compute badge | inference health and active model route | open settings; disclose model, device, fallback, availability |
| Persistence status | durable storage acknowledgement | distinguish durable save, fallback, saving, and failure |
| Export | explicit render configuration and validator result | full mix, loop range, and arrangement-aligned individual Audio/MIDI track WAV; no silent normalization; report format, range, peak risk, outcome |
| Project schema | canonical project `schemaVersion: 4`; outer serialization envelope version 1 | migrate schema 1–3 projects to 4, persist Audio timebase, `sourceLoop`, and fixed `overlapPolicy: prevent`, reject unsupported future versions |

## 3. Desktop interpretation

### 3.1 Transport

- The menu glyph and project-name chevron open the local project menu. They are buttons, not decoration.
- Every saved project exposes a real delete command. Deleting a project removes
  its acknowledged checkpoint and recovery journal from every available local
  persistence backend after the ordered save lane is drained. Deleting the open
  project first cancels any active inference safely and prepares another saved
  project or a new blank project. Global Sound Library entries are not project
  ownership and remain available.
- Undo/redo expose the command label and are disabled only when history has no matching action.
- Position and BPM are live clock values. BPM edits are bounded, undoable, and do not lose focus during playback.
- The two-channel master meter is driven by the playback graph. Fixed CSS percentages are forbidden.
- Snap, compute status, export, and settings invoke their real surfaces.

### 3.2 Source and creation

- `Generate`, `Import`, and `Library` are real peer sections, not decorative
  tabs. Library reads an IndexedDB-backed, device-local collection shared
  across local projects and exposes search, audition, place, download, and
  explicit delete commands.
- Import opens a real local file picker. Recording stays absent until capture, monitoring, permission, and recovery are implemented.
- Candidate waveforms come from generated/decoded media. A missing asset shows a named unavailable state, not a fabricated waveform.
- Audition has play/stop state and uses the safe audio output path.
- Generation progress is available outside the panel, can be cancelled, and survives navigation.
- Audio tempo detection appears only for a selected Audio region. It analyzes
  verified decoded PCM in a Worker, reports confidence and candidates, and
  applies a candidate through the same atomic project-tempo command used by the
  Transport.
- A non-empty Audio Provenance prompt has one real reuse action. It copies the
  exact prompt, opens Generate sound, and focuses the prompt field with the caret
  at the end; it does not start generation or mutate the project.

### 3.3 Arrangement

- Ruler click/keyboard seeks. Cycle boundaries have preview and committed state.
- Blank-lane clip deselection plus lane-track selection, ruler seeking, clip hit
  zones, same-kind vertical moves, source loop, overlap policy, contextual
  commands, and crossing-note split behavior follow
  `docs/product/arrangement-clip-interaction-contract.md`.
- Regions support selection, move, both trims, keyboard nudging, split, duplicate, and delete with undo/redo.
- Audio and MIDI geometry is derived from source peaks and note events.
- Source-looped regions render their real repeated waveform/note slices and repetition notches. When loop is active, the lower source-cycle handle and upper loop-extent handle are separate controls backed by separate values; neither is a decorative duplicate of the other.
- `OVERLAP · PREVENT` is the only current project policy. Collision previews are invalid, pointer release is non-committing, and non-pointer entry points receive the same domain rejection with named feedback.
- Right-click, keyboard context invocation, and touch long-press open one real command registry. It contains only Open Detail, Split, Duplicate, Clip Loop, Audio-to-MIDI extraction, and Delete according to selection and engine state.
- A MIDI split with crossing notes pauses before mutation for Keep/Shorten/Split. Looped MIDI exposes the truthful shared-source constraint and permits only Keep until flattening exists.
- Selection, playhead, cycle, mute, solo, and missing-media states remain visually distinct.
- Blur, hidden visibility, pointer cancellation, owned lost pointer capture, or
  unmount cancels active Arrangement previews and releases capture. A later
  stale pointer-up cannot commit the abandoned move/trim/loop/zoom gesture.
- Track mini-meters are live or omitted. Static activity marks are forbidden.
- The plus Audio-waveform and plus MIDI-note buttons create the named track kind
  directly and select it; there is no intermediate Add-track chooser.
- Move up and Move down remain direct track-header controls with boundary
  states. Track rows do not use an overflow/ellipsis menu: rename and destructive
  deletion belong to Track properties.
- Placement at the playhead uses the selected track as an explicit target. It
  commits only to a free Audio track; a selected MIDI track or occupied Audio
  range reports why placement is blocked. Only the no-track-selection case may
  create a new Audio track.
- Arrangement option icons remain absent until they open a working command surface.

### 3.4 Inspector and detail

- Detail follows the selected parent clip and keeps nested note/transient selection distinct; blank detail space and `Escape` follow `docs/product/detail-editor-interaction-contract.md`.
- Detail has a real collapse/reopen command. Collapsing changes layout only: it
  preserves the parent clip selection, Arrangement viewport, shared playhead,
  and playback state.
- Inspector fields edit persisted clip state and display exact values.
- With a track selected and no region selected, the Inspector becomes Track
  properties. The track identity row places Edit and Delete next to the name.
  Edit swaps the name for an in-place input; Enter or focus-out commits, Escape
  cancels. Until the parent project prop confirms a changed name, a rejected
  draft can be submitted again. Delete removes that track's regions and routing
  as one undoable command, and Undo restores the complete track.
- With a Region selected, its identity row uses the same compact adjacent
  Edit/Delete grammar. Edit swaps the Region name for an in-place field;
  Enter/focus-out commits a trimmed non-empty change, Escape cancels, and no-op
  input creates no history. A rejected same-name draft remains retryable until
  parent confirmation. Delete invokes one undoable Region command.
- The Audio detail waveform, fades, gain overlay, and playhead share the selected clip's clock and content-hashed source. A transient guide appears only when calculated data and an implemented edit path exist.
- The Audio waveform itself is a real bounded pointer/keyboard seek surface.
  Fade-in and fade-out handles preview and commit the clip's persisted
  parameters through project history; neither overlay is decorative.
- Audio Detail and Arrangement read the same immutable source slices. Trim/phase/source-cycle/loop-extent changes re-map decoded peaks; they never rewrite source bytes or stretch one full-file waveform across unrelated repeated reads.
- MuScriptor input is built from the selected clip mapping rather than a linear full-source crop: complete and partial source-loop reads are concatenated into temporary mono PCM after integrity verification. This implementation still requires real-Medium parity and accuracy evidence.
- MIDI has three real adjacent tools: Pencil draws on the grid, Range Select
  owns replace/Shift-union marquee plus group move/delete, and Eraser removes
  crossed primary or loop-derived occurrences through unique source-note IDs.
  Pencil first selects an unfocused note, deletes it only on a stationary second
  click while selected, moves by body drag, resizes by right-edge drag, and
  draws from blank grid. One Eraser drag deletes its unique crossed-note set as
  one command. No disconnected `Add note` control is rendered.
- Multi-selected source notes expose mixed-aware shared Pitch, Source Length,
  and Velocity controls. Relative arrows and exact assignment apply atomically
  to the complete set; piano-key double-click selects all notes at that pitch
  and Shift unions another pitch.
- MIDI Quantize division, Strength, and Apply form one group immediately below
  the Note inspector; Apply is directly below Strength and acts only on the
  disclosed selection.
- MIDI Track properties expose melodic/drum profile, wire channel, and General
  MIDI program. Drums use the compact Chaos profile on displayed channel 10;
  melodic tracks use TinySynth and exclude the drum channel.
- MIDI notes support real pointer and keyboard move/resize/delete commands, numeric pitch/timing/length controls, a direct velocity lane, and explicit quantize division/strength. Their full focus, gesture-coalescing, playback, and export matrix remains a verification task.
- The Piano Roll always contains 128 fixed 12 px pitch rows. Normal and expanded
  Detail share that scale; expansion increases the visible range, and one
  vertical viewport keeps piano keys and note rows aligned. Black-key faces are
  offset upward by half their height, extended by two pixels, and layered above
  white-key hit areas.
- Note selection and piano-key pointer/keyboard input audition through the
  parent track's active channel/program and TinySynth/Chaos profile. Start,
  replacement, release, cancellation, and blur states must not create stuck
  notes or interfere with candidate-audio audition.
- Clip change, blur, hidden visibility, pointer cancellation, and unmount cancel
  Detail Audio-fade/MIDI previews without mutation; piano-key lost capture
  releases audition.
- Source-file, backup/revert, destructive waveform, envelope, spectral, scale, and stretch controls remain absent until their processing, recovery, persistence, and live/export paths exist.
- An extracted MIDI Region's existing Audio parent is a real navigation target:
  it selects and reveals the Audio Region in Arrangement and focuses its body.
  A missing/non-Audio parent is an unavailable/`LOST` state, not a dead link.

## 4. Mobile interpretation

- The composition stage remains the default and keeps horizontal musical navigation.
- The top menu opens project actions; the engine status opens compute settings. Identical icons cannot perform unrelated hidden actions.
- The selected-object command bar contains only valid commands for the current Audio or MIDI selection.
- `Loop range` edits the project cycle around the selected region and is not labeled as clip looping.
- Create, Arrange, Mix, Inspector, and Detail are projections of the same project state used on desktop.
- Selecting a track on mobile exposes the same Track properties Inspector and
  its identity-row Edit/Delete commands; it does not require an Arrangement
  overflow menu.
- Detail uses a sheet/full surface without losing selection, playhead, or undo history.
- Narrow MIDI Detail keeps the selected-note inspector and the complete
  Quantize/Strength/Apply group reachable above the Piano Roll; responsive
  composition must not remove precise note controls.
- Generation progress remains visible and cancellable while returning to Arrange.
- Every touch target is at least 44 by 44 CSS pixels. Pinch zoom preserves the musical point under the gesture centroid.
- Software-keyboard, browser back, orientation, and safe-area transitions cannot discard an edit or strand an overlay.

## 5. Implementation batches

### Batch A — truthfulness and command wiring

1. Replace the visual-demo startup with a blank persisted project.
2. Remove no-op/placeholder controls and static meters.
3. Add the functional local project menu and real project lifecycle commands.
4. Wire master and track meters to the playback graph.
5. Make candidate audition stateful and expose global job progress/cancel.
6. Correct labels whose current command differs from the visual promise.

Exit gate: an automated affordance audit finds no visible enabled control without a command, no unavailable feature presented as a control, and no fixed/random musical visualization.

### Batch B — complete high-frequency editing

1. Source-cycle, loop-extent, project-cycle boundary editing, and centroid-preserving zoom are source-wired; complete their browser/device acceptance evidence.
2. Audio fades, gain, split, duplicate, delete, move, and trim are source-wired; complete their live/export and interaction acceptance evidence.
3. MIDI Pencil/Range Select/Eraser, marquee and source-ID multi-selection,
   group move/delete, batch Pitch/Source Length/Velocity, pitch-key selection,
   and selected-note Quantize are source-wired; complete their focus,
   playback/export, and Undo/Redo evidence.
4. Track pan plus coalesced level/pan history are source-wired; complete cross-surface mixer and gesture evidence.
5. Direct Audio/MIDI track creation, direct reordering, Track/Region-properties
   in-place rename/delete, selected-track placement, prompt reuse, and
   MIDI-to-Audio lineage reveal are source-wired; complete their browser,
   mobile, persistence, focus, and Undo/Redo matrix.
6. Ensure desktop, keyboard, and mobile commands call the same domain command layer.

Exit gate: every edit previews the committed result, each gesture is one undo step, and a 100-command undo/redo test restores the canonical project.

### Batch C — resilient creative loop

1. Persist candidates, jobs, provenance, and extraction versions.
2. The selected Audio clip is now rendered into loop-aware temporary mono PCM before MuScriptor extraction; verify realtime/CPU/transcription mapping parity and real-Medium repeatability.
3. Add durable journal/checkpoint recovery and honest fallback status.
4. Add explicit export format/range/peak controls and independent validation.
5. Finish focus management, touch gestures, browser/device coverage, and accessibility states.
6. Keep normal playback and live mix mutation in AudioWorklet, including
   hidden-page re-entry, immutable project-media resynchronization, ephemeral
   candidate/Library audition cleanup with abort/epoch stale-preview rejection,
   5 ms live mute/solo gates, MIDI routing, and live/offline TinySynth/Chaos
   parity through the shared finite `release * 8` tail. Offline export applies
   persisted final mute/solo state from frame zero.
7. Treat project replacement as a history epoch boundary so queued or in-flight
   operations from the previous project cannot commit over the new state.

Exit gate: generate, audition, place, extract, edit, arrange, reload/recover, play, and export succeeds three consecutive times with real providers and survives navigation/reload at every asynchronous boundary.

## 6. Visual QA and evidence

For every implementation batch, capture desktop and 360-pixel mobile screenshots only after the interaction test passes. A screenshot is supporting evidence, never the implementation target.

Required evidence:

- control inventory with accessible name, command, enabled rule, feedback, and test;
- screenshots at 100%, 150%, and 200% text zoom plus 360 by 800 CSS pixels;
- keyboard-only and touch/pointer traces for the core loop;
- screenshots with empty, loading, complete, unavailable, and error states;
- recorded master/track meter movement from known test audio and zero state after stop;
- proof that every shown waveform/note/progress/readout changes when its source data changes;
- browser console free of uncaught errors and accessibility violations in the tested flow.

## 7. Definition of done

The UI is production-ready only when a musician can infer what is playable, editable, generated, extracted, saved, and exportable from the visible state; every apparent action responds with immediate state feedback; and no image-derived decoration can be mistaken for actual project content or engine telemetry.

The implementation inventory above does not satisfy that definition by itself.
The newly integrated direct track controls, Track/Region properties, Library,
prompt reuse, lineage reveal, tempo analysis, Detail waveform/fade and
fixed-geometry three-tool/multi-note Piano Roll, selected-note Quantize, routed
MIDI audition, and AudioWorklet behavior still require a batched full browser
revalidation.
The current frontend unit baseline (49 passed files, one skipped; 308 passed
tests, one skipped) and production build (1,843 transformed modules) pass, while
the backend's retained 42-test result is existing evidence rather than a new
rerun. Current-goal production blockers still include immutable evidence
provenance, MuScriptor's non-commercial
license for commercial release, a versioned extraction-accuracy corpus,
physical mobile and assistive-technology coverage, playback/edit soak testing,
and musician workflow validation. An actual Colab T4 Studio run is a separate
deferred deployment-target gate outside the current goal. Current evidence and
gaps remain tracked in `docs/product/verified-slice.md` and
`docs/product/production-criteria.md`.
