# VibeSeq interaction model

Status: product contract

Depends on: `docs/product/behavioral-baseline.md`

Arrangement/clip refinement: `docs/product/arrangement-clip-interaction-contract.md`

Detail-editor refinement: `docs/product/detail-editor-interaction-contract.md`

## 1. Product loop

VibeSeq optimizes one continuous musical loop:

1. Express an intent as a prompt plus optional musical constraints.
2. Generate and audition Stable Audio candidates without interrupting the current song.
3. Place a chosen audio asset at a musically meaningful track/time location.
4. Extract MIDI structure from selected audio with MuScriptor.
5. Edit Audio and MIDI with ordinary DAW operations.
6. Build the arrangement, listen in context, revise, persist, and export.

The UI must make each transition reversible. Generation and extraction are not destinations or separate projects; they are asynchronous operations that feed the same arrangement.

## 2. Information architecture

### 2.1 Object model

The information architecture follows musical objects rather than pages.

```text
Project
├── musical clock: tempo, meter, grid, cycle, playhead
├── tracks
│   ├── track state: name, type, order, level, pan, mute, solo, MIDI routing
│   └── clip instances
│       ├── timeline placement and loop/trim/fade parameters
│       └── reference to a source or derived asset
├── assets
│   ├── imported audio/MIDI
│   ├── generated candidates and accepted source audio
│   └── rendered/processed derivatives
├── extraction results
│   ├── source audio reference and time mapping
│   ├── model/job metadata and confidence where available
│   └── one or more versioned MIDI assets
├── automation and processing state
├── ordered edit history and recovery checkpoints
└── export records
```

Project assets and clip instances are separate. One generated asset can be placed more than once; every placement can have independent trim, gain, fades, loop, stretch, and automation.

### 2.2 Workspace roles

The following are semantic roles, not mandatory panel names or fixed screen positions:

| Role | User question | Required content |
| --- | --- | --- |
| Composition stage | “Where is this in my song?” | Tracks, clips, musical ruler, playhead, cycle, selection, automation summary |
| Source and creation surface | “What can I bring into the song?” | Generate, Import, and a device-local Library shared across local projects; prompt, constraints, generation status, candidates, search, audition, place, download, delete |
| Contextual detail surface | “What is inside this selected material?” | Audio waveform/transients/envelopes or MIDI notes/velocity, scoped edit controls |
| Properties surface | “What is true about this selection?” | Name, timing, gain/velocity, loop/stretch, provenance, target, status, destructive/non-destructive labels |
| Mix surface | “How do the tracks sound together?” | Shared track level/pan/mute/solo, meters, master state, later FX/routing |
| Global control surface | “What is the project doing now?” | Transport, position, tempo/meter, grid, compute target, job state, undo/redo, save/export |

At any viewport size, the composition stage remains the spatial anchor. Supporting roles may be persistent, collapsed, overlaid, or staged, but their state must not fork.

## 3. State model: no opaque global modes

VibeSeq avoids a global “AI mode versus edit mode” switch. Available commands derive from:

- the focused surface;
- the primary selection and its type;
- any secondary selection;
- the current tool only when direct manipulation is insufficient;
- project/job state and device capability.

The default pointer/touch behavior is select and manipulate. Local tools are
appropriate only when their gesture grammar would otherwise conflict. The MIDI
Detail surface therefore exposes three adjacent, stateful tools—Pencil for
drawing, Range Select for marquee/group editing, and Eraser for deletion—in its
own header. It does not expose a generic `Add note` command. Leaving Detail
returns to the neutral Arrangement behavior, and the current tool remains
visible next to the surface it affects.

## 4. Selection and focus contract

### 4.1 Independent scopes

The following states must never be conflated:

| Scope | Meaning | Example effect |
| --- | --- | --- |
| Focus | Which surface receives keyboard commands | `Delete` removes notes when the note editor is focused, not the arrangement clip |
| Primary object | Anchor for detail/properties | Selected audio clip opens waveform detail and Audio properties |
| Secondary objects | Additional objects changed as a group | Move or duplicate multiple clips/notes |
| Track selection | One or more complete tracks | Default placement target, direct reorder, Track-properties rename/delete, mix and MIDI routing |
| Time selection | A musical interval, optionally across tracks | Duplicate Time, export range, set cycle, consolidate |
| Insert position | Where paste/place/record begins | Place generated audio at bar 17 without selecting bar 17–21 |
| Playhead | Current playback/scrub position | Split selected clip at the playhead |
| Cycle range | Repeated playback interval | Audition bars 17–21 while keeping a different clip selection |
| Automation points | Selected parameter events | Move/copy/delete breakpoints only |
| Source candidate | Auditioned asset outside arrangement | Preview Candidate 02 without changing the selected arrangement clip |

### 4.2 Pointer and keyboard behavior

1. Clicking a clip selects it and makes it the detail anchor.
2. Clicking an already selected clip preserves the selection until a drag threshold is crossed; this prevents accidental moves.
3. Clicking empty lane space clears clip selection, selects that lane's track as
   the placement/properties target, and does not move the playhead. Dragging it
   past the movement threshold may create a time selection. Clicking the ruler
   seek band moves the playhead; cycle changes require a separate rendered
   handle/state.
4. `Shift` extends a contiguous range. The platform modifier toggles non-adjacent objects.
5. Clicking a note after opening MIDI detail moves focus and the active sub-selection to notes while the parent clip remains visibly identified.
6. `Escape` moves outward one level: cancel current gesture/tool → clear sub-selection → return focus to parent clip → clear object selection.
7. `Delete`, duplicate, quantize, split, extract, and export-selection resolve against focus first, then visible selection. Ambiguous destructive commands require a short scope label such as “Delete 8 notes” rather than a generic confirmation dialog.
8. The inspector/detail header names the current scope, for example `Clip · Drums Loop 01` or `MIDI notes · 8 selected`.
9. Range Select drag creates a marquee. A plain marquee replaces the nested
   note selection; `Shift` unions it. Moving or deleting a multi-selection is
   one atomic edit, and Pitch, Source Length, and Velocity properties apply to
   every selected source note rather than only the visual anchor.
10. Double-clicking a piano key selects every source note at that pitch;
    `Shift`-double-click adds that pitch to the current nested selection. Loop
    occurrences resolve to their source-note IDs so one source event is never
    edited or deleted more than once.
11. Arrangement previews cancel on blur, hidden visibility, pointer cancel,
    owned lost pointer capture, or unmount. Detail fade/MIDI previews cancel on
    clip change, blur, hidden visibility, pointer cancel, or unmount; piano-key
    lost capture releases its audition. A stale pointer-up after cancellation
    never commits the abandoned preview.

### 4.3 Touch behavior

1. Tap selects. Tapping the ruler seek band sets the playhead; tapping empty
   lane space clears clip selection, selects that lane's track, and does not
   move the playhead.
2. A selected clip exposes the hit zones defined in `docs/product/arrangement-clip-interaction-contract.md`: body moves, lower edges trim, and the upper-right source-loop handle repeats. Handles must not overlap at minimum supported zoom.
3. Long-press empty space starts marquee/multi-select. Long-press a selected object opens its complete action menu. A short vibration is optional and must respect device settings.
4. Pinch zooms time around the gesture centroid. Drag empty canvas to pan. Two-finger pan remains available if the first finger starts on an object.
5. Gestures have visible previews and commit on release. Cancel, undo, or moving back to the origin recovers the prior state.
6. Auto-scroll near viewport edges is proportional and capped so a long arrangement remains controllable.

## 5. Arrangement and detail relationship

### 5.1 Shared musical context

The arrangement and detail editor are two scales of the same material:

- Detail follows the selected parent clip by default; a nested note/transient selection does not replace that parent identity.
- They share the project tempo/meter map, playhead, cycle, and clip start offset.
- They may have different zoom and snap divisions; each surface displays its own active division.
- Selecting a time range inside a clip can reveal the corresponding range in detail. Selecting notes or transients in detail updates the clip's miniature representation without moving the arrangement viewport.
- Opening or resizing detail does not reset arrangement scroll/zoom.
- Collapsing and reopening detail is a layout command, not a selection command;
  the selected parent clip, nested edit state, playhead, and playback continue.
- Playback continues when detail opens, closes, or changes between Audio and MIDI.

### 5.2 Audio detail

Audio detail progressively exposes:

1. trim/start/end, fades, clip gain, reverse, and loop boundaries;
2. project-tempo following, stretch ratio, transpose, and transient preservation;
3. transient/warp anchors and envelopes when supported;
4. source and derivative provenance, model/generation metadata, and render state.

The waveform represents the referenced, content-hashed source segment. A gain/envelope overlay shows audible transformation; the raw waveform must not visually “bake” a non-destructive gain change. The current surface is a non-destructive clip-slice editor, not a source-file editor. Render/consolidate or later file-level processing creates a new versioned derivative only after an explicit action and recovery semantics exist. Exact selection, integrity, and live/export requirements follow `docs/product/detail-editor-interaction-contract.md`.

The current waveform is also the clip-local seek surface: pointer/keyboard seek
moves the shared project playhead but does not create history. Fade-in and
fade-out handles preview and commit real clip parameters, with the same values
driving live playback, persistence, and export.

### 5.3 MIDI detail

MIDI detail progressively exposes:

1. Pencil draw, Range Select, Eraser, note position, pitch, length, velocity,
   multi-note move/delete/property editing, and audition;
2. quantize division/strength, transpose, legato, and humanize when implemented;
3. velocity and later controller/automation lanes;
4. extraction provenance and confidence overlays that can be hidden.

Extracted MIDI is normal MIDI. A confidence display is advisory; it cannot block editing or be the only way to distinguish uncertain notes.

In Range Select mode, dragging blank MIDI-detail space creates a marquee while
a click clears only the nested note selection and retains the parent clip and
track context. Pencil draws from blank snapped grid space; its first click on
an unfocused note selects it, a stationary second click on that selected note
deletes it, body drag moves, and right-edge drag resizes. One Eraser drag
deletes every crossed unique source-note ID, including rendered loop
occurrences, as one atomic edit. Move, resize, velocity, batch property, delete,
and quantize mutations update the Arrangement miniature from the same note data
and must be exactly reversible. The complete Quantize/Strength/Apply group sits
immediately below the Note inspector, with `Apply quantize` directly below
Strength so its scope and inputs read as one command. Narrow/mobile Detail
retains both the Note inspector and this group instead of hiding them. Exact
nesting and acceptance behavior follow
`docs/product/detail-editor-interaction-contract.md`.

Pitch geometry is invariant across Detail sizes. The complete `0..127` range is
rendered as 128 fixed 12 px rows; expanding the surface reveals more rows rather
than scaling notes. Piano keys and note rows share vertical scrolling. Black-key
faces move upward by half their own height, extend two CSS pixels for a usable
target, and sit above adjacent white-key hit areas so the visible black key
always receives the press. Selecting a note or pressing a piano key auditions
through the parent track's current MIDI channel, program, and TinySynth/Chaos
profile, with matching release on pointer/key-up or focus loss.

### 5.4 Pinning and comparison

By default detail follows the primary selection. Desktop may provide an explicit Pin action for comparing an editor against another arrangement selection. A pinned editor must clearly identify its clip and stop claiming to follow selection. Mobile does not need pinning until comparison testing demonstrates demand.

## 6. AI-assisted operations

### 6.1 Stable Audio generation

1. The user supplies a prompt. Tempo, duration, meter, key, and seed are optional constraints, not hidden prompt text.
2. Generate starts a non-blocking job with queued/running/progress/cancel/failure/complete states.
3. Existing candidates remain playable while another job runs. Candidate and
   Library audition use a preview path separate from project transport and
   provide an obvious stop. Preview PCM uses an ephemeral Worklet asset removed
   on end/replacement/stop, while abort plus preview epoch prevents a stale
   fetch, integrity check, or decode from starting after a newer request.
4. Accepting a candidate stores it as a local source asset. Placement is a second, explicit action: drag to a track/time, place at insert position, or place into the current time selection.
5. The placement preview shows target track, start, expected duration, snap, and whether tempo-follow will be enabled.
6. Regeneration adds candidates. It does not replace a placed clip or delete prior candidates.
7. `Place at playhead` treats the selected track as an explicit target. A free
   selected Audio track accepts the region; a selected MIDI track or occupied
   Audio range reports a named block and does not create or choose another
   track. When no track is selected, the command may create a new Audio track.
8. Completed generated media is also written to the global local Library after
   integrity verification. Library placement follows the same selected-track
   contract as a current candidate; deleting a Library entry does not delete
   existing project assets or clips.
9. Generate, Import, and Library are peer source tabs. Library is global to the
   local device rather than scoped to the open project, and its filter,
   audition, placement, download, and deletion commands operate on stored media
   rather than decorative cards.
10. An Audio region with a non-empty generation prompt exposes `Reuse prompt`
    beside Prompt in Provenance. Invoking it copies the exact prompt into
    Generate sound, opens the Create/Generate surface, and focuses the prompt
    field with the caret at the end. This is a focus/navigation action, not a
    project mutation and not an automatic generation request.

### 6.2 Audio tempo detection

1. Tempo detection is scoped to a selected Audio region with available,
   integrity-checked local media.
2. After integrity verification, the browser decodes and maps the selected clip
   to mono PCM. The computational onset/tempo analysis runs in a Worker and
   exposes cancellation, failure, confidence, and alternative BPM candidates.
3. Choosing a candidate invokes the normal project-tempo preflight and commits
   one undoable project command. It cannot bypass fixed-seconds rebasing or the
   overlap-prevention policy.

### 6.3 MuScriptor extraction

1. Extract MIDI is enabled only when at least one suitable audio clip/source is selected; its label includes scope when multiple clips are selected.
2. The extraction request records source asset/version, source interval, clip start, project tempo/meter, and the requested interpretation when exposed by MuScriptor.
3. Running extraction is non-blocking and cancelable. The selected audio stays playable.
4. A preview overlays or pairs extracted notes with the source waveform on a shared time axis.
5. Commit creates a new MIDI asset and clip aligned to the audio clip. The default target is an adjacent new MIDI track unless the user explicitly selects a compatible target track.
6. The audio and MIDI receive a visible lineage relationship. Moving one later does not silently move the other; an explicit linked-move action may be added after testing.
7. Re-extract creates a version. If a result already has hand edits, VibeSeq must offer compare/new version, never overwrite.
8. A MIDI region whose parent Audio region still exists exposes an actionable
   provenance link. Invoking it selects the Audio region, returns to
   Arrangement, scrolls the region into view, and gives its body control focus.
   A missing or non-Audio parent is rendered as `LOST`/unavailable and is not a
   clickable link.

### 6.4 Compute target

- Desktop auto-selects a supported local GPU backend first and reports the selected backend. If unavailable or initialization fails, it offers/uses the documented CPU fallback and states the expected performance impact.
- No network/cloud fallback occurs without explicit consent.
- Colab T4 is a separate full-Studio deployment target, not a hidden compute provider for the desktop build. Projects move between targets through the same versioned project bundle and asset format.
- Actual T4 execution is deferred outside the current goal. Launcher/readiness
  coverage is not runtime evidence and does not change the desktop GPU-first,
  CPU-fallback contract.
- Capability, download, warm-up, out-of-memory, and fallback states are visible but do not masquerade as musical errors.

## 7. Adaptive composition flow

Breakpoints are driven by usable musical space, not device labels. The values below are initial validation targets, not immutable CSS contracts.

### 7.1 Wide workspace (typically ≥ 1280 CSS px)

- Composition stage stays central.
- Creation/library and properties may coexist as collapsible side surfaces.
- Detail may occupy a resizable lower region while arrangement and playhead stay visible.
- The compact track controls are always available; an expanded mixer may replace a support surface or occupy a resizable region.
- Generation/extraction progress appears near its initiating surface and in one global job indicator, not as duplicated modal overlays.

### 7.2 Compact workspace (typically 768–1279 CSS px)

- Show at most one auxiliary side surface at a time.
- Detail uses a resizable lower drawer or temporarily expands over a portion of the arrangement.
- Properties join detail or an overflow sheet rather than squeezing the timeline below a useful width.
- Transport, playhead position, tempo, grid, undo, and job state remain reachable.

### 7.3 Narrow/touch workspace (typically < 768 CSS px)

- Arrangement remains the default spatial view; the phone is not reduced to a candidate browser.
- Selecting a track makes the Track properties Inspector reachable without
  adding a track-row ellipsis; its commands operate on the visibly named track.
- A selected clip reveals a compact quick-action row: Edit, Extract MIDI for Audio, Loop, and More. Actions are contextual, not permanently repeated on every clip.
- Creation and Mix are peer work surfaces reached through bottom-level navigation or sheets while retaining project/transport state.
- Audio/MIDI detail opens as a bottom sheet with useful collapsed, medium, and full-editor snap points. The collapsed sheet names the selection and exposes snap plus one primary edit.
- Expanded MIDI Detail keeps the selected-note inspector and complete
  Quantize/Strength/Apply group reachable above its Piano Roll; mobile changes
  placement and scrolling, not note-edit capability.
- The sheet may cover the arrangement at full height, but the playhead/time mapping stays continuous and a clear drag handle/back action restores context.
- Essential transport remains reachable with one hand and is not displaced by the software keyboard. Prompt entry may temporarily condense transport but cannot hide stop.
- Mobile uses larger handles and fewer simultaneous properties; it does not remove project-saving, undo/redo, snapping, precise value entry, or export.

## 8. Track, mix, and provenance behavior

- Track headers expose name/type, activity, mute, solo, and a compact level control. Record arm appears only when recording/input is supported.
- Two direct, adjacent add controls—plus Audio-waveform and plus MIDI-note—create
  Audio and MIDI tracks independently and select the new track. They have
  explicit accessible names and do not hide kind selection in a menu. Move up
  and Move down remain direct header controls; their boundary control is
  disabled when no move exists. Track rows do not expose an ellipsis menu.
- Rename and Delete track live in Track properties, reached by selecting a track
  rather than a region. On desktop this is the right Inspector; mobile opens the
  selected-track Inspector surface. The track identity row keeps Edit and Delete
  adjacent. Edit replaces the name with an in-place input: Enter or focus-out
  commits one undoable name change, Escape restores the committed value, and an
  empty draft cannot erase the name. If a parent mutation is rejected, the same
  name remains submit-ready until a changed project prop confirms it. Delete
  removes the track, all of its
  regions, and its routing in one undoable command; Undo restores the complete
  track.
- Region identity follows the same compact grammar in Region properties: Edit
  replaces the displayed name with an in-place input and Delete sits beside it.
  Enter or focus-out commits one trimmed, non-empty rename; Escape cancels; a
  no-op draft creates no history item. A rejected same-name mutation is
  retryable until parent confirmation. Region deletion uses the existing
  region delete command and remains undoable.
- The expanded mixer adds accurate meters, pan, numeric level, master, and later FX/routing. It edits the same track state as headers.
- Solo is an audition state; export reflects the audible solo/mute state only after an explicit export summary confirms it.
- MIDI routing is track state. Melodic tracks use TinySynth, select a General
  MIDI program and one of the non-drum channels; drum tracks use the compact
  Chaos profile and are fixed to displayed channel 10. Legacy MIDI tracks are
  normalized before mutations so missing old routing metadata cannot block
  Solo, Mute, or unrelated editing.
- Normal playback runs in AudioWorklet. Gain/pan/mute/solo changes are small
  audio-thread messages rather than graph rebuilds, and re-entry recreates and
  resynchronizes a closed owned audio context instead of silently changing
  playback engines. Live mute/solo transitions use a 5 ms sample-domain gate;
  offline export instead applies the persisted final state from frame zero.
  TinySynth live/offline scans share the finite `release * 8` tail boundary.
- Generated, imported, recorded, and derived are provenance badges in properties. They do not change how a clip edits or mixes.
- A source → generated asset → clip instance → extracted MIDI chain can be
  inspected and navigated. The extracted MIDI link reveals its source Audio
  region in Arrangement; an Audio prompt can be reused in the focused Generate
  field without changing the region or starting a job. Candidate A's restrained
  amber/teal lineage treatment is used; Candidate B's always-on high-contrast
  connectors are reduced to selection/hover contexts.

## 9. History, persistence, and recovery

- Undo history records musical/project mutations in order. Continuous drags, knob moves, and text edits coalesce into meaningful actions.
- Selection, focus, panel size, audition play, transport movement, and viewport navigation are not undo items.
- Generation completion adds an asset/version event; placement is a separate undoable edit. Undoing placement keeps the generated source available.
- Extraction completion adds a versioned result; committing it to the project is a separate undoable edit.
- Adding, reordering, renaming, deleting, and changing MIDI routing are explicit
  project mutations. Track deletion keeps enough command state for Undo to
  restore regions and routing together. Track and Region in-place drafts commit
  only when accepted; focus navigation, prompt reuse, and lineage reveal do not
  enter history.
- A batch note move, delete, or shared Pitch/Source Length/Velocity change is
  one atomic project mutation over unique source-note IDs. One Undo restores the
  complete selected set; rendered loop occurrences never multiply the command.
- Autosave is local-first and incremental. The UI distinguishes `Saving`, `Saved locally`, `Recovery available`, `Exporting`, and actual errors.
- A reload restores the last acknowledged project checkpoint plus any recoverable newer journal. Recovery never silently discards the acknowledged checkpoint.
- Replacing the active project increments the history state epoch. Any queued
  or in-flight execute/update/undo/redo operation captured in the previous
  epoch is ignored before it can commit over the replacement project.
- Export takes a consistent snapshot, so edits made while rendering either wait for the next export or produce an explicitly newer snapshot.

## 10. Interaction principles to validate with users

1. The user can always answer “what will this command change?” from visible selection and focus.
2. Generated material becomes ordinary musical material as soon as it is placed.
3. Audio-to-MIDI lineage is inspectable without forcing synchronized edits.
4. The arrangement remains audible and navigable while AI jobs run.
5. Mobile preserves the same musical intent and precision through progressive disclosure, not feature removal.
6. Closing and reopening never makes the user reconstruct where a sound came from or what version was edited.
