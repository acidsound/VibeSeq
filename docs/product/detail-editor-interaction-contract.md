# VibeSeq detail-editor interaction contract

Status: product and verification contract; current implementation wired, release verification pending

Observation date: 2026-07-15

Related baseline: `docs/product/behavioral-baseline.md`

Arrangement contract: `docs/product/arrangement-clip-interaction-contract.md`

## 1. Scope and evidence boundary

This contract refines the relationship between an Arrangement clip and its MIDI or Audio detail editor. It combines two explicitly separated inputs:

1. behavior directly observed by operating an open Logic Pro project through Computer Use; and
2. VibeSeq product decisions derived from that evidence, the Ableton Live and BandLab baseline, local-first storage, and the features VibeSeq can honestly execute.

The observation was a focused interaction sample, not a complete Logic Pro specification. A behavior is listed as observed only when it was visible or a mutation was committed and then reversed. Pointer operations that did not commit, ambiguous application shortcuts, and unvisited editor features are not treated as evidence.

## 2. Directly observed Logic Pro behavior

### 2.1 Detail follows the selected region type

- Selecting an Arrangement MIDI region changed the lower editor to Piano Roll.
- Selecting an Arrangement Audio region changed the lower editor to a Track waveform view.
- Selecting the Audio region while the MIDI track header still held track focus showed that region selection and track focus can remain independent.
- The editor retained a visible parent-region context rather than presenting notes or waveform data as an unrelated document.

### 2.2 Piano Roll structure and context

The observed Piano Roll exposed:

- a parent-region strip above the note grid;
- a musical ruler aligned to the project clock;
- a visible `Smart` snap setting;
- a pointer tool and a Command-modified pencil tool;
- piano keys, a time/pitch grid, note bars, and selection-aware properties.

These elements were visible together. The parent/nested-selection rule VibeSeq derives from that evidence is specified separately in section 3.

### 2.3 Piano Roll selection and proven mutations

- Clicking a note made it the primary note selection and highlighted its pitch key.
- The inspector reported `1 note selected` and exposed the selected note's scoped values. In the observed state these included Time Quantize `1/16`, Strength `100`, Swing `50`, Scale Quantize off with `Major` shown, and Velocity `80`.
- Clicking an empty part of the Piano Roll grid cleared the note selection only. The parent region and track context remained.
- Changing the selected note's velocity from `80` to `81` through the accessibility value interface committed. Undo restored `80`.
- Dragging the right edge of an F3 note committed a longer duration. The Arrangement region miniature changed to reflect the edited note data, and Undo restored the prior duration and miniature.

An application-level `Alt+Up` attempt had ambiguous focus and changed all notes in the region. Therefore this observation does **not** establish an exact keyboard shortcut or a one-note transpose rule.

### 2.4 Track waveform view

The Audio region's Track editor exposed:

- a stereo waveform on a project-bar ruler;
- a visible `Smart` snap setting;
- a pointer tool and a Command-modified marquee tool;
- `Track`, `File`, and `Smart Tempo` tabs;
- region help that described move, trim, split, join, timing, and pitch operations.

The help text proves those operations are part of the surfaced region-editing vocabulary. It does not by itself prove their exact hit zones, modifier keys, or commit rules.

### 2.5 File view and the source-editing boundary

The observed `File` tab showed:

- the exact backing `.wav` filename;
- a transient-editing context;
- pointer and Command-modified move tools;
- preview, cycle-preview, and audition-volume controls;
- an overview waveform plus a detailed waveform.

Its Audio File menu exposed `Create Backup`, `Revert to Backup`, `Save Copy As`, `Save Selection As`, `Detect Transients`, `Update File Info`, and `Refresh Overview`. Logic therefore surfaced backup, copy, refresh, and recovery commands beside file-level operations. VibeSeq's source-file boundary is a separate product decision in section 3.

### 2.6 Inconclusive pointer behavior

A direct waveform trim drag attempted through Computer Use did not commit. The result is inconclusive. This contract therefore makes no claim about Logic Pro's exact waveform trim pointer target, drag threshold, or snap behavior.

## 3. VibeSeq product decisions

The following are VibeSeq decisions, not claims that Logic Pro behaves identically.

### 3.1 Parent clip and nested selection

- Detail follows the current primary Arrangement clip by default: MIDI opens Piano Roll; Audio opens clip-slice waveform detail.
- The parent clip remains visibly named and selected while the user works on notes or a waveform sub-selection.
- Track focus, parent clip selection, nested note/transient selection, playhead, and time range remain distinct states.
- Clicking blank detail space clears only the nested selection. It does not silently deselect the parent clip, switch tracks, or seek the Arrangement.
- `Escape` moves outward one layer at a time: cancel active gesture/tool → clear nested selection → return focus to the parent clip → clear the clip selection.
- Detail commands resolve against the focused nested selection first. Their labels disclose scope, for example `Quantize 8 notes`, instead of implying they affect the whole clip.
- An Audio fade or MIDI edit preview is cancelled without mutation when its
  pointer is cancelled, the window blurs, the document becomes hidden, the
  selected clip changes, or the surface unmounts. Cancellation restores the
  pre-marquee note selection and releases any active note audition. Losing
  piano-key pointer capture also sends that key's audition release.

### 3.2 One musical clock, separate viewing precision

- Arrangement and Detail use the same tempo/meter map, playhead, and clip-to-project time mapping.
- The Detail ruler can use a different zoom and snap division, but it must display the effective division and preserve alignment with the Arrangement ruler.
- A note edit updates the MIDI miniature from real note data. A waveform edit updates the clip outline, fade/gain overlay, and audible render from real clip parameters.
- Opening, collapsing, reopening, or changing Detail type preserves the selected
  parent clip, Arrangement scroll/zoom, shared playhead, and playback. Collapse
  is a layout command and does not clear selection.
- Expanding Detail changes viewport capacity, not pitch scale. MIDI rows remain
  fixed at 12 CSS pixels in both states, so expansion reveals more of the same
  128-pitch surface instead of stretching existing notes.

### 3.3 MIDI detail contract

- Notes are ordinary editable MIDI regardless of whether they were imported, drawn, or extracted by MuScriptor.
- The header exposes exactly three adjacent editing tools: Pencil, Range Select,
  and Eraser. Pencil draws a persisted source note from blank snapped grid
  space; its first click on an unfocused note selects that note, a stationary
  click on the already selected note deletes it, body drag moves the selected
  note set, and right-edge drag resizes. Range Select owns plain/Shift marquee
  and the same direct note selection/manipulation without draw-or-delete click
  semantics. Eraser drag collects every crossed unique source-note ID and
  deletes the set in one command. There is no separate `Add note` button whose
  placement is disconnected from the grid.
- In Range Select, a plain marquee replaces the note selection and a
  `Shift`-marquee unions with it. A multi-selection moves and deletes as one
  source-note set. Rendered source-loop occurrences are deduplicated by source
  note ID before selection or mutation.
- Double-clicking a piano key selects every source note at that pitch;
  `Shift`-double-click unions that pitch with the current selection. A piano-key
  selection gesture does not also move the playhead or audition twice.
- Selection, move, resize, velocity, delete, draw, batch property editing, and
  quantize division/strength must be real domain commands before their controls
  appear enabled.
- A note drag or continuous numeric adjustment coalesces into one undo item. Undo restores both the note event data and the Arrangement miniature.
- When multiple notes are selected, shared Pitch, Source Length, and Velocity
  controls operate on the complete selected set. Mixed values are disclosed;
  Pitch and Source Length arrow keys apply a relative delta, direct numeric
  entry assigns the exact value to all selected notes, and the Velocity slider
  assigns one value to all. Start remains a single-note field because a group
  move, rather than a shared absolute start, preserves musical intervals.
- Both Source Length arrow directions must be explicit, bounded edits. The
  browser's native number-input stepping is not relied on for Arrow Down.
- Quantize is non-destructive to the source extraction result: it edits the committed MIDI clip/version and remains undoable.
- Quantize division, Strength, and `Apply quantize` are one visual command
  group placed immediately below the Note inspector rather than pinned away at
  the bottom of the side rail. The Apply action sits directly below Strength
  and affects only the disclosed nested note selection.
- Narrow/mobile Detail retains the Note inspector and this complete Quantize
  group above the Piano Roll instead of hiding or collapsing them to zero width.
  The narrower composition changes layout, not edit scope.
- Pitch-key highlight, numeric velocity, and note geometry reinforce selection without relying on color alone.
- The Piano Roll contains all MIDI pitches `0..127` as 128 fixed 12 px rows.
  The keyboard and note grid live in one vertically scrolling viewport so a
  pitch label, key, grid row, and note cannot drift apart while navigating.
- Black-key faces are shifted upward by half of their own rendered height and
  extended by two CSS pixels so the keyboard preserves the familiar
  white/black-key relationship at the compact row scale with a practical hit
  target. Their interactive layer sits above adjacent white keys; clicking the
  visible black face cannot be intercepted by a white-key row.
- Selecting a source note and pressing a piano key both audition the addressed
  pitch. Pointer release, keyboard key-up, blur, cancellation, or a replacement
  audition sends the matching stop/release phase. The sound is resolved from
  the parent MIDI track's current channel, program, and melodic/drum profile;
  the note widget does not own a parallel instrument setting.
- VibeSeq does not assign Logic Pro shortcut semantics from the ambiguous `Alt+Up` observation. Keyboard bindings require independent VibeSeq tests with controlled focus and selection.

### 3.4 Audio detail contract

- VibeSeq currently presents a non-destructive **clip-slice** editor, not a source-file editor.
- Implemented Audio controls may edit clip start/end, fades, clip gain, split boundaries, and other parameters whose playback and export paths are real.
- The waveform is decoded from the referenced content-hashed Audio asset. Gain and fades appear as overlays; they do not rewrite or visually fake changes to the raw waveform.
- The rendered waveform is a real seek surface. Pointer press/drag and the
  supported keyboard seek keys update the shared Arrangement playhead within
  the selected clip's project-time interval; seeking is not an edit or an Undo
  item.
- Fade-in and fade-out overlays expose pointer and keyboard handles backed by
  the clip's persisted `fadeIn` and `fadeOut` values. Preview is bounded by the
  clip duration, commit enters normal project history, and playback/export use
  the same parameters.
- The selected source bytes remain immutable and their stored hash is checked before playback, extraction, and export.
- VibeSeq does not show a decorative `File` tab, transient editor, backup menu, or destructive source command merely because a reference DAW has one.
- File-level processing stays absent until VibeSeq can create a versioned derivative, preserve the original, expose backup/recovery semantics, and prove project references remain valid.

### 3.5 No fake parity

Reference-product vocabulary is not sufficient reason to render a control. An editor tab, tool selector, transient marker, quantize property, or waveform handle appears only when:

1. it is backed by actual project/media state;
2. it invokes an implemented command with visible preview and commit feedback;
3. its mutation participates in Undo/Redo and persistence; and
4. live playback and export render the same result.

### 3.6 Current VibeSeq implementation inventory

This is a source inventory dated 2026-07-16, not a claim that the acceptance suite in section 4 has been rerun or that the production gate has passed.

| Path | Implemented behavior | Verification still required |
| --- | --- | --- |
| Audio waveform slicing and direct edits | Arrangement and Audio Detail derive complete and partial reads from the same clip source mapping. Each read displays only its referenced range of the decoded source peaks, repeated reads keep their placement order, and the Detail footer names the source-read count/cycle. The waveform accepts bounded pointer/keyboard seek, while fade-in/fade-out handles preview and commit real clip parameters. The source `AudioAsset` bytes and content hash are not rewritten by trim, source-cycle, loop-extent, fade, or gain state. | `DETAIL-08` through `DETAIL-12` and `DETAIL-17`, zoom/render edge cases, missing/corrupt assets, exact Undo coalescing, and live/offline sample-boundary and envelope parity. |
| Loop-aware transcription | Before extraction, VibeSeq verifies the selected Audio asset, decodes it locally, follows trim offset plus every complete or partial source-loop read, downmixes those reads into temporary mono PCM, and sends a temporary WAV representing the clip's audible arrangement interval to MuScriptor. The immutable encoded source remains unchanged; the returned MIDI is placed at the parent clip start and retains parent asset/clip lineage. | Exact PCM/live/CPU-render parity, real-Medium repeat runs, timing accuracy against a ground-truth corpus, cancellation/reload, and source-hash assertions. |
| MIDI detail | Pencil, Range Select, and Eraser are real adjacent tool states. Range Select supports replace/Shift-union marquee, source-ID multi-selection, group move/delete, piano-key double-click pitch selection, and shared Pitch/Source Length/Velocity edits through atomic batch commands. Pencil draws on blank grid; first click selects an unfocused note, a stationary second click deletes the selected note, body drag moves, and right-edge drag resizes. Eraser drag atomically deletes every crossed primary or loop-derived source ID. The Quantize/Strength/Apply group sits immediately below the Note inspector and Apply is directly below Strength; both remain visible in the narrow/mobile Detail layout. The Arrangement miniature reads the same note data, including source-loop instances. The complete pitch range uses 128 fixed 12 px rows in one key/grid scroll viewport, expansion reveals more rows without scaling them, and the raised black-key face is two pixels taller with hit priority over white keys. Note selection and piano-key input audition through the parent track's current channel/program/profile. MIDI previews and Audio fades cancel on clip change, blur, hidden visibility, pointer cancellation, or unmount; piano-key lost capture releases audition. | Full `DETAIL-01` through `DETAIL-07` and `DETAIL-18` through `DETAIL-21`, controlled keyboard focus, retained visual geometry, captured routed audio, audible velocity checks, stop/release safety, exact Undo/Redo coalescing, and the pending batched Playwright run. |
| Collapsible Detail | The Detail header and status control collapse/reopen the lower editor without clearing its parent clip. The desktop grid removes the collapsed row; mobile restores the Arrangement surface while retaining shared project state. | `DETAIL-16`, desktop/mobile resize transitions, keyboard/screen-reader focus restoration, and playback continuity capture. |
| Project model | Audio/MIDI source-loop mapping, explicit Audio `fixed-seconds`/`tempo-follow-repitch` timebase, and the fixed `prevent` overlap policy persist in project `schemaVersion: 4`; schema 1–3 imports migrate to the current model. | Released migration fixtures and `DETAIL-12` recovery/reload evidence. |

## 4. Acceptance tests

These are release-blocking checks for the Detail surface.

Implemented controls and data paths remain unverified until the relevant case is rerun with canonical-state assertions and, where specified, playback/export or real-provider evidence.

| ID | Scenario | Required result |
| --- | --- | --- |
| `DETAIL-01` | Select MIDI clip from Arrangement | Piano Roll opens for that clip; parent identity, project ruler alignment, effective snap, and current playhead are visible. |
| `DETAIL-02` | Select one note, then click blank Piano Roll space | Note selection and pitch-key emphasis clear; parent clip/track context and playhead remain unchanged. |
| `DETAIL-03` | Move a selected note | Position changes by the effective snap rule, miniature and playback update, and one Undo restores all three. |
| `DETAIL-04` | Resize a selected note | Duration preview and commit agree; miniature and playback update; one Undo restores the prior event. |
| `DETAIL-05` | Edit note velocity numerically and by direct manipulation | Both paths write the same velocity field, audible output changes, value is bounded, and each continuous gesture is one Undo item. |
| `DETAIL-06` | Quantize selected notes with explicit division and strength | Only the disclosed selection changes; `0%` and `100%` strength boundaries are deterministic; Undo restores exact original ticks. |
| `DETAIL-07` | Press `Escape` through nested MIDI state | Active gesture cancels first, then note selection clears, then focus returns to the clip, then clip selection clears—one layer per press. |
| `DETAIL-08` | Select Audio clip from Arrangement | Clip-slice waveform opens for the exact content-hashed asset; parent identity, source interval, ruler alignment, effective snap, and playhead are visible. |
| `DETAIL-09` | Trim Audio start/end | Preview and committed boundary agree; source bytes/hash do not change; playback and export begin/end at the same sample boundary within documented rounding tolerance. |
| `DETAIL-10` | Edit Audio fades and clip gain | Real overlays and meters update; live playback and offline export match within the documented gain/envelope tolerance; Undo restores parameters and sound. |
| `DETAIL-11` | Corrupt or remove referenced source media | Detail, playback, extraction, and export all report the same blocked integrity state; no synthetic waveform or silent substitute appears. |
| `DETAIL-12` | Reload after MIDI and Audio detail edits | Parent clip, nested data, clip parameters, source hashes, and Detail type restore from the acknowledged checkpoint without forked state. |
| `DETAIL-13` | Switch between selected MIDI and Audio clips during playback | Detail type and parent header follow selection while transport, project playhead, Arrangement viewport, and audio continuity remain stable. |
| `DETAIL-14` | Compare live playback with exported Audio/MIDI | Note timing/duration/velocity and Audio trim/fade/gain produce the same musical result; exported files pass independent WAV/SMF validation. |
| `DETAIL-15` | Extract MIDI from a trimmed, phased, source-looped Audio clip | Waveform slice order, temporary transcription PCM, realtime playback, and CPU mixdown reference the same complete/partial source reads; the source hash is unchanged and returned MIDI aligns to the parent clip start. |
| `DETAIL-16` | Select a clip, collapse Detail, continue transport/Arrangement navigation, then reopen it. | The same parent clip and editor type return; playhead, playback state, Arrangement viewport/zoom, and undo history never reset; focus lands on a valid visible control in desktop and mobile layouts. |
| `DETAIL-17` | Seek on the Audio Detail waveform, then edit each fade by pointer and keyboard | Seek remains inside the clip and moves the shared playhead without creating history. Each fade preview and commit agree, stays bounded by clip duration, creates the expected undoable edit, persists after reload, and matches live/offline rendering. |
| `DETAIL-18` | Navigate the full Piano Roll, expand/collapse it, and audition a note plus piano key | All pitches `0..127` remain aligned across keys, rows, and notes at 12 px per pitch; expansion exposes more pitches without changing note height; black-key faces retain their half-height upward offset and two-pixel target extension, and their visible face receives the press instead of an adjacent white key; auditions use the parent track's channel/program/profile and always release without clicks or stuck notes. |
| `DETAIL-19` | Use Pencil, Range Select, and Eraser on primary and source-loop note occurrences, including interrupted gestures | Each visible tool owns only its named gesture. Pencil draws from blank grid, first selects an unfocused note, deletes it only on a stationary second click while selected, moves by body drag, and resizes by right-edge drag. Range Select does not draw or erase. One Eraser drag removes every crossed unique source note, including derived occurrences, as one Undo item. Blur, hidden visibility, pointer cancellation, clip change, and unmount commit nothing; piano-key lost capture releases audition. There is no generic Add-note control. |
| `DETAIL-20` | Marquee-select multiple notes, Shift-union another range, move them, delete them, and double-click piano keys with and without Shift | Selection matches unique source-note IDs; group geometry preserves intervals within clip/pitch bounds; plain key double-click replaces with all notes at that pitch, Shift adds a pitch; each move/delete is one atomic command and one Undo restores the complete set. |
| `DETAIL-21` | Batch-edit mixed Pitch, Source Length, and Velocity, then quantize the selected notes | Mixed state is named; Pitch/Length arrows apply bounded relative deltas in both directions; direct values and Velocity apply to every selected note; Start appears only for one note; the Quantize/Strength/Apply group immediately follows the Note inspector, Apply sits directly below Strength, and only the disclosed selection changes; no-op input creates no history. |

## 5. Deferred capabilities

The following stay out of the interactive UI until separately implemented and verified:

- destructive in-place source editing;
- source-file backup/revert menus;
- transient detection or transient-marker editing;
- time/pitch processing that lacks live/export parity;
- editor tools with no complete pointer, keyboard, touch, Undo, and persistence path;
- any exact Logic Pro shortcut inferred from the ambiguous focus test.
