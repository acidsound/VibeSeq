# VibeSeq arrangement and clip interaction contract

Status: focused product contract; current implementation wired, release verification pending

Evidence date: 2026-07-16

Depends on: `docs/product/behavioral-baseline.md`

Refines: `docs/product/interaction-model.md`

Scope: arrangement selection, track creation/properties/order, Region
properties, selected-track placement, provenance reveal, playhead placement,
clip hit zones, moving, trimming, source looping, snapping, overlap, contextual
commands, MIDI splitting, preview/commit, and undo

## 1. Evidence boundary

This contract combines two deliberately separate inputs:

1. **Observed Logic Pro behavior** from a controlled macOS accessibility/computer-use session.
2. **VibeSeq product decisions** derived from those observations and VibeSeq's local-first Audio/MIDI workflow.

An observed label or command is evidence, not a requirement to copy Logic Pro. A VibeSeq decision is normative even when its wording or result differs. The following official Apple documentation corroborates terminology and discoverable interaction zones:

- [Get started arranging regions in Logic Pro](https://support.apple.com/guide/logicpro/arranging-regions-lgcp4d686a1a/10.7/mac/11.0)
- [Loop regions in Logic Pro](https://support.apple.com/en-ca/guide/logicpro/lgcpf7c0e0db/10.7/mac/11.0)
- [Snap items to the grid](https://support.apple.com/guide/logicpro/snap-items-to-the-grid-lgcpf7c0f66a/mac)
- [Use drag modes](https://support.apple.com/en-mide/guide/logicpro/lgcpf7c0a2ec/mac)
- [Repeat regions](https://support.apple.com/guide/logicpro/repeat-regions-lgcpe51317b6/10.7/mac/11.0)

### 1.1 Direct observations

| Observation | Confidence and boundary |
| --- | --- |
| Region selection, track focus, and playhead were visibly independent. | Directly observed. |
| Clicking blank lane space deselected the region without relocating the playhead. | Directly observed. |
| Clicking the lower ruler relocated the playhead. | Directly observed. |
| Accessibility help identified the region center as move, the lower edge as resize, and the upper-right corner as source loop. | Directly observed through accessibility metadata; corroborated by Apple's arranging and looping guides. |
| `Smart` Snap and `Drag: No Overlap` were visible. | Visibility was observed. Collision outcomes for every drag mode were not exercised. |
| `Option+Right Arrow` nudged the selected region by one current division; Undo restored the original position. | Directly executed and restored. VibeSeq need not copy the shortcut. |
| Inspector fields included Mute, Loop, Quantize, Q Swing, Transpose, Fine Tune, Pitch Source, Flex & Follow, and Gain. | Field visibility was observed. Processing semantics for every field were not exercised. |
| Enabling Loop on a one-bar MIDI base region from `5` to `6` retained that base region while repeated notches extended to the project end. | Directly observed. This is source-region looping, not project-cycle playback. |
| The region context menu exposed split, repeat, move, nudge, trim, convert, and automation command families. | Menu presence was observed; every command result was not executed. |
| Splitting MIDI at `5|3` with a note crossing the cut opened `Keep`, `Shorten`, and `Split` choices. Choosing `Split` created two regions, selected the right region, created a continuation note, and Undo restored the original. | Directly executed and restored for the `Split` choice only. |
| A direct pointer drag issued through computer-use did not commit a move. | Inconclusive. This contract makes no claim about Logic Pro's exact drag threshold, timing, auto-scroll, or pointer-event sequence. |

### 1.2 Current VibeSeq implementation inventory

This inventory records commands and state paths wired in the current source on 2026-07-16. It is **not** evidence that the release-blocking cases in section 10 have passed as a complete browser, device, persistence, playback, and export suite.

| Area | Implemented source path | Verification still required |
| --- | --- | --- |
| Source-loop geometry | `sourceLoop` stores cycle start, cycle length, and phase independently from placement duration. Arrangement Audio/MIDI content is expanded from that mapping, repetition notches and a repeat count are rendered, the lower cycle-end handle edits the source cycle, and the distinct upper-right handle edits the repeated placement extent. Inspector `Clip loop` toggles the same state. | `ARR-ZONE-01`, `ARR-LOOP-01`, live/export parity, reload, and the supported pointer/touch matrix. |
| Overlap | Project schema 4 fixes `arrangement.overlapPolicy` to `prevent`. Arrangement displays `OVERLAP · PREVENT`; move/trim previews identify collisions, collision release does not commit, and domain guards reject keyboard or command mutations with named feedback. | `ARR-OVERLAP-01` across every mutation entry point, Undo/Redo, reload, and concurrent async commits. |
| Command registry | Desktop right-click, keyboard context-menu invocation, and a 550 ms touch long-press open the same `ClipCommandMenu`. Its current real commands are Open Detail, Split at the displayed playhead position, Duplicate, Enable/Disable Clip Loop, Extract Editable MIDI for Audio, and Delete. | `ARR-MENU-01`, keyboard focus/screen-reader coverage, and physical iOS/Android long-press cancellation. |
| Track creation and properties | Two direct icon controls, plus Audio-waveform and plus MIDI-note, create the requested track kind without opening a chooser. Move up/down remain direct header buttons; no track-row ellipsis is rendered. Selecting a track exposes Track properties in the desktop right Inspector or mobile selected-track Inspector. Its identity row keeps Edit/Delete adjacent; Edit swaps the name for an in-place input that commits on Enter/focus-out and cancels on Escape. Until the parent project prop confirms the new name, the same draft may be submitted again after a rejected mutation. Deletion removes regions and routing as one undoable command. | `ARR-TRACK-01` and `ARR-TRACK-PROPS-01`, responsive layout, keyboard/screen-reader focus, reload, and exact Undo/Redo. |
| Region properties | The selected Audio or MIDI Region identity row keeps Edit and Delete adjacent. Edit uses the same in-place draft contract as Track properties: trimmed non-empty Enter/focus-out commit, Escape cancellation, and no mutation for an unchanged draft. Until the parent project prop confirms the new name, the same draft remains retryable after a rejected mutation. Delete invokes the existing undoable Region deletion command; no duplicate destructive control is rendered lower in the Inspector. | `ARR-REGION-PROPS-01`, desktop/mobile focus restoration, reload, and exact Undo/Redo. |
| Gesture cancellation | Clip move/trim, loop-boundary, pinch, wheel-zoom, and pending long-press state share a cancellation path. Window blur, hidden visibility, pointer cancellation, owned lost pointer capture, selection-changing external commands, and unmount cancel state, release pointer capture, clear previews, and prevent a later stale pointer-up from committing. | `ARR-POINTER-01`, browser lost-capture behavior, tab/app switching, and physical touch cancellation. |
| Selected-track placement | `Place at playhead` targets the selected track. A free Audio track accepts the region; MIDI selection or a colliding Audio range returns a named block without rerouting. No track selection permits creation of a new Audio track. | `ARR-PLACE-01`, generation/Library parity, persistence, exact Undo/Redo, and batched full browser revalidation. |
| Linked-region reveal | An extracted MIDI Region with an available Audio parent exposes an actionable Provenance link. Invoking it revalidates the target, selects the Audio Region and track, closes competing mobile overlays, returns to Arrangement, scrolls the Region into view, and focuses its body control. Missing/non-Audio parents render an unavailable lineage state instead of a dead link. | `ARR-LINK-01`, desktop/mobile scroll/focus behavior, missing-parent recovery, keyboard/screen-reader operation, and the pending batched browser run. |
| Audio prompt reuse | An Audio Region with a non-empty Provenance prompt exposes one reuse icon beside Prompt. It copies the exact value into Generate sound, switches to the Generate/Create surface, and focuses the prompt field at its end without starting generation or changing project history. MIDI, empty, and whitespace-only prompts expose no reuse control. | `PROV-PROMPT-01`, repeated-invocation focus, desktop/mobile keyboard behavior, unchanged job/history assertions, and the pending batched browser run. |
| MIDI split policy | The command counts arranged note instances that cross the cut and opens a modal before mutation. The modal exposes Keep, Shorten, and Split, names the affected-note count, supports cancel, and commits the chosen policy as one split transaction with the right clip selected. Looped MIDI enables only Keep and explains that Shorten/Split require flattening the shared source loop first. | Both `ARR-SPLIT` cases, playback note-off safety, persistence, and exact Undo/Redo round-trips. |
| Persistence | The canonical project is `schemaVersion: 4`; schema 1–3 imports migrate to schema 4, including Audio timebase, the fixed overlap policy, and optional source-loop state. The outer project serialization envelope remains version 1 and is a separate version number. | `ARR-RELOAD-01`, released-schema fixtures, corrupt/partial payloads, and recovery evidence. |

## 2. VibeSeq state separation

The arrangement must preserve these independent states:

| State | Visual and behavioral contract |
| --- | --- |
| Clip selection | Outlines the object affected by clip commands and anchors Inspector/Detail. It does not imply a seek. |
| Track focus | Identifies the track receiving track commands, Track properties, or default placement. Selecting a header or blank lane changes it; clearing a clip within that track does not. |
| Playhead | Marks the playback/split position. It moves through ruler seek, transport, or an explicit seek command—not as a side effect of clip selection. |
| Time selection | Represents an editable/exportable interval. It is not the playhead, clip selection, or cycle. |
| Project cycle | Repeats transport across a project interval. It is controlled on the ruler and is independent of every clip's loop setting. |
| Clip source loop | Repeats material inside one clip instance up to an explicit instance extent. It does not enable or resize project cycle. |

### 2.1 Blank lane and ruler

- A click/tap on blank lane space clears clip/object selection, selects that
  lane's track, and leaves the playhead unchanged.
- A blank-lane drag that crosses the movement threshold may create a time selection. A click without that threshold must not create a zero-length selection.
- A click/tap in the ruler's seek band moves the playhead and does not silently select or deselect a clip.
- Cycle handles occupy a separately rendered and hit-tested ruler band. Seeking must not accidentally resize the cycle, and resizing the cycle must not silently seek.
- Selecting a clip does not move the playhead. A separate gesture or command may offer “Select and seek,” but it cannot be the hidden default.

## 3. Clip hit-zone grammar

One neutral selection/manipulation tool owns the common clip gestures. Hit zones, pointer feedback, accessibility help, and touch handles must all describe the same command.

| Zone | Pointer/touch result | Required feedback |
| --- | --- | --- |
| Body/center | Select; after movement threshold, preview a horizontal move or same-kind vertical track move. | Move cursor or touch lift state, snapped start preview, target track, collision state. |
| Lower-left edge | Preview and commit start trim. | Resize cursor/handle, source offset, resulting start and duration. |
| Lower-right edge, loop off | Preview and commit placement/source end trim. | Resize cursor/handle, resulting end and duration. |
| Lower source-cycle end, loop on | Preview and commit the repeated source cycle length without changing the clip's repeated placement extent. | Lower cycle handle, source-cycle boundary, phase-safe cycle length, repeated waveform/note preview. |
| Upper-right loop-extent handle, loop on | Preview and commit the clip's repeated placement extent without changing the source cycle. | Distinct loop icon/cursor, base-cycle boundary, repetition notches, resulting extent. |

Additional rules:

- Hit zones cannot overlap at the minimum supported zoom. When geometry is too small, selecting the clip reveals external handles instead of stacking invisible targets.
- Touch handles provide at least a 44-by-44 CSS-pixel logical target without visually enlarging or falsifying clip duration.
- A vertical move accepts only a compatible track of the same musical kind: Audio to Audio, MIDI to MIDI. An invalid target stays uncommitted and names the reason. Moving a clip never performs implicit conversion.
- Source-loop handles use a different shape and color token from project-cycle handles. Color is supplemental; iconography, position, and accessible name carry the distinction.
- Every zone has an accessible name such as `Move clip`, `Trim clip start`, `Trim clip end`, or `Set clip loop extent`.

## 4. Preview, commit, cancel, and history

Direct manipulation is a transaction:

1. Pointer/touch down updates selection but does not mutate project data.
2. Crossing the movement threshold starts a preview from a frozen pre-gesture snapshot.
3. Snap, compatible-track, bounds, and overlap rules are applied to the preview and shown before release.
4. Release on a valid target commits exactly one domain command and one undo-history item.
5. `Escape`, pointer cancellation, an invalid target, or returning to the origin restores the snapshot without adding history.
6. Undo restores geometry, track assignment, source offset/loop extent, and the prior primary selection. Redo reapplies the complete transaction.

Keyboard nudge, menu move, and pointer move call the same domain command. A nudge advances by one displayed effective division, announces the resulting musical position, and produces one reversible history item per deliberate command. Modifier names may follow platform conventions; the behavioral unit must not be hidden.

The unsuccessful computer-use drag is not evidence for an exact Logic Pro gesture. VibeSeq's pointer threshold, capture, auto-scroll, and commit behavior require independent browser tests with real pointer events.

## 5. Snap and overlap policy

- Arrangement Snap always shows both its mode (`Off`, fixed division, or adaptive) and the effective musical division at the current zoom.
- A move/trim/loop preview shows the snapped value before commit. Temporary snap bypass changes only the current gesture, not the saved setting.
- The active overlap policy is a persisted, visible editor value. It cannot be an undocumented consequence of clip order.
- The initial safe policy is `Prevent overlap`: a collision preview is visibly invalid and release does not commit. VibeSeq does not silently shorten either clip.
- `Allow overlap` remains absent until overlapping layers, playback summing, selection order, fades/crossfades, and export have an unambiguous implementation and test suite.
- A future policy change is a project edit with a defined migration/result; it cannot reinterpret an existing arrangement silently.

Logic Pro's visible `No Overlap` setting motivates explicitness, but VibeSeq's non-committing collision result is its own product decision.

## 6. Source loop versus project cycle

Source loop and project cycle are separate commands, stored in separate fields, and rendered in separate layers.

### Clip source loop

- The base source interval remains identifiable while the clip instance extends through repetitions.
- Repetition boundaries are derived from the base interval and displayed as notches; they are not duplicated source assets.
- Dragging the lower source-cycle end changes the cycle length and immediately re-slices the visible waveform or MIDI instances across the existing placement.
- Dragging the upper-right loop handle changes only the clip instance's loop extent.
- Disabling source loop restores the non-repeated base extent without deleting the source or changing project cycle.
- Inspector `Clip loop` toggles source-loop state; the lower handle changes its source cycle and the upper-right handle changes its repeated placement extent. All three controls render from the same clip state and remain synchronized.

### Project cycle

- The cycle is a transport interval on the ruler and can include zero, one, or many clips.
- Enabling, moving, or resizing cycle does not alter a clip's loop, trim, or source interval.
- Mobile labels use `Clip loop` and `Project cycle`; the ambiguous label `Loop range` is not used without its scope.

## 7. Contextual command surface

Desktop right-click and mobile long-press open the same command registry for the same selection. Presentation may differ, but command IDs, enabled rules, scope labels, result, and undo behavior do not.

The current implemented registry is:

- Open Detail Editor;
- Split at the displayed playhead position;
- Duplicate after the region, using the next free non-overlapping range;
- Enable or Disable Clip Loop;
- Extract Editable MIDI for Audio regions;
- Delete Region.

Move, trim, and nudge remain direct-manipulation/keyboard commands rather than decorative menu rows. Automation and conversion commands that do not yet have an end-to-end implementation are absent.

Only implemented commands appear. A command that is temporarily unavailable because of current selection or engine state may remain disabled only when its reason is visible or announced. Unsupported commands, decorative chevrons, and menu rows with no result stay absent.

Opening the menu makes its target clip the primary selection when needed, but does not move the playhead or create project/history mutation. Split names its insertion point, for example `Split at 5|3`. Convert/extract names its source and always preserves the source asset.

Region rename is intentionally not added to this context menu. Selecting a
Region exposes its visible identity in the Inspector, where Edit temporarily
replaces the name with an in-place field and Delete sits beside it. Enter or
focus-out commits one trimmed, non-empty rename; Escape restores the committed
name; an unchanged draft is mutation-free. The same component and command path
serve Audio and MIDI Regions.

An extracted MIDI Region's Provenance link is navigation, not linked movement.
It selects and reveals the still-existing source Audio Region in Arrangement
without changing either Region's timing, name, source bytes, or history. When
the parent ID cannot resolve to an Audio Region, the Inspector names the missing
source and renders no actionable navigation target.

An Audio Region's Prompt reuse icon is also navigation rather than an edit. It
copies the stored prompt into the shared Generate sound draft, opens that source
surface, and moves focus/caret to the prompt field. It does not modify the
Region's provenance, enqueue generation, or enter Undo history. The affordance
is absent when there is no reusable non-whitespace Audio prompt.

## 8. MIDI split with crossing notes

If no note crosses the cut, Split commits immediately. If one or more notes cross it, VibeSeq opens a focused modal before mutation and shows the count of affected notes plus three VibeSeq-defined outcomes:

| Choice | VibeSeq result |
| --- | --- |
| Keep | Keep the complete note event in the left/start-side clip. The right clip receives no new onset; the left clip sustains to the original note end and emits the matching note-off even when it falls beyond the visual cut. Stop, mute, seek, and clip deletion still send a safety note-off. |
| Shorten | End the left note exactly at the split; create no continuation note. |
| Split | End the left note at the split and create a continuation note at time zero of the right clip with the remaining duration and the same pitch, velocity, channel, and relevant expression data. |

Commit postconditions:

1. Two clip instances replace the original instance; the underlying MIDI source/version remains recoverable.
2. The right clip becomes primary selection and Detail follows it.
3. The split choice and generated continuation lineage are persisted.
4. One Undo restores the original region, notes, timing, and primary selection; one Redo restores both split regions and the chosen crossing-note treatment.
5. Cancel closes the modal with no project or history mutation.

Only the observed `Split` outcome is evidence from Logic Pro. `Keep` and `Shorten` above are VibeSeq semantics and require their own unit, playback, persistence, and undo tests.

For a looped MIDI clip, the current implementation enables only `Keep`. `Shorten` and `Split` would otherwise rewrite the one shared MIDI source and therefore every repetition; the dialog keeps those choices disabled and names flattening the source loop as the prerequisite. This constraint is implementation truth, not a passed acceptance result.

## 9. Inspector field adoption rule

The observed Logic Pro inspector is an inventory of possible musical properties, not a checklist to render. VibeSeq exposes a field only when its value changes real persisted state and playback/export agree.

| Observed field | VibeSeq interpretation |
| --- | --- |
| Mute | Show when clip-instance mute affects playback and export. |
| Loop | Show as `Clip loop`; synchronized with the source-loop handle. |
| Quantize | Show for MIDI only after preview, strength/division, playback, persistence, and undo use the same value. |
| Q Swing | Hide until the quantize engine and visual timing preview implement it. |
| Transpose | Show only for supported Audio/MIDI types and state whether the edit is real-time or rendered. |
| Fine Tune | Hide until pitch processing, units, range, and export are verified. |
| Pitch Source | Do not copy the Logic-specific label. Introduce a VibeSeq control only if the engine has a real equivalent. |
| Flex & Follow | Do not copy the Logic-specific label. Tempo-follow/stretch controls require a working processing path and explicit source-versus-project timing. |
| Gain | Show for Audio when playback, meters, waveform overlay, persistence, and export share the value. |

## 10. Release-blocking acceptance cases

The implementation inventory in section 1.2 does not mark any case below as passed. Each case requires fresh state assertions and the stated playback/export or device evidence.

| ID | Scenario | Required result |
| --- | --- | --- |
| `ARR-SEL-01` | Select a clip, record playhead, click blank lane on a named track. | Clip deselects; playhead stays unchanged; the clicked lane's track becomes the explicit focus/placement target. |
| `ARR-RULER-01` | Select a clip, click the ruler seek band. | Playhead moves to the snapped/unsnapped target; clip selection stays unchanged. |
| `ARR-ZONE-01` | Exercise body, both lower edges, and upper-right handle. | Only the named move, trim, or source-loop preview occurs; no hit-zone ambiguity at supported zooms. |
| `ARR-MOVE-01` | Move Audio/MIDI horizontally and onto compatible/incompatible tracks. | Valid preview commits once; incompatible target explains and does not commit; Undo/Redo are exact. |
| `ARR-NUDGE-01` | Nudge one division, Undo, Redo. | Position advances by the displayed effective division and round-trips exactly. |
| `ARR-SNAP-01` | Change zoom, fixed/adaptive Snap, and temporary bypass. | Effective division is visible and preview/commit use the displayed rule. |
| `ARR-OVERLAP-01` | Move a clip into an occupied interval. | Visible `Prevent overlap` policy produces an invalid preview and no commit; no clip is silently trimmed. |
| `ARR-LOOP-01` | Loop a one-bar source, extend it, then edit project cycle. | Base interval remains visible, repetitions are derived, and cycle changes do not change clip loop. |
| `ARR-MENU-01` | Right-click on desktop and long-press on mobile. | Same valid command IDs and scope; unsupported commands are absent. |
| `ARR-TRACK-01` | Invoke the direct plus Audio-waveform and plus MIDI-note controls, then use direct Move up/down. | Each control creates its named kind without a chooser, each new track is selected, MIDI receives valid default routing, order commits once per click, boundary buttons disable, no track ellipsis is present, and Undo/Redo plus reload preserve exact order. |
| `ARR-TRACK-PROPS-01` | Select a track on desktop and mobile; invoke Edit in its Track-properties identity row, rename by Enter and blur, cancel by Escape, retry the same name after a rejected parent mutation, then Delete and Undo. | Edit/Delete remain adjacent to the visibly named track; rename commits once per accepted in-place draft and remains retryable until the parent prop confirms it; Escape is mutation-free; Delete removes the track, regions, and routing once; Undo restores the complete track; the Arrangement row has no ellipsis. |
| `ARR-REGION-PROPS-01` | Select Audio and MIDI Regions; rename each by Enter and focus-out, cancel by Escape, submit empty/unchanged drafts, retry a rejected same-name draft, then Delete and Undo. | Edit/Delete remain adjacent to the visibly named Region without a second Delete control; accepted names trim and commit once and remain retryable until parent confirmation; empty/unchanged/Escape paths create no mutation; Delete removes only the selected Region; Undo restores its complete Region data. |
| `ARR-PLACE-01` | Place the same available sound with a free Audio track selected, an occupied Audio track selected, a MIDI track selected, and no track selected. | Free Audio receives it at the displayed playhead; occupied/MIDI targets remain unchanged and name the block; no selection creates a new Audio track; generation and Library entry points behave identically. |
| `ARR-LINK-01` | From an extracted MIDI Region, invoke each Provenance navigation affordance with an available Audio parent, then repeat with a missing/non-Audio parent. | The valid parent becomes the selected Region and track, Arrangement scrolls it into view and focuses the Region body on desktop/mobile; no project/history mutation occurs. Invalid lineage is named unavailable/`LOST` and exposes no dead button. |
| `PROV-PROMPT-01` | Invoke Prompt reuse for an Audio Region on desktop/mobile, repeat with the same prompt, then inspect Audio-without-prompt and MIDI cases. | The exact prompt appears in Generate sound, Generate/Create opens, the textarea owns focus with its caret at the end on every request, no generation job or project/history mutation occurs, and invalid scopes render no reuse button. |
| `ARR-SPLIT-01` | Split MIDI with no crossing note. | Two clips commit in one history item; right clip is selected; Undo restores the original. |
| `ARR-SPLIT-02` | Split MIDI with crossing notes and choose each modal outcome. | Notes match the documented Keep/Shorten/Split semantics; cancel is mutation-free; persistence and Undo/Redo round-trip. |
| `ARR-POINTER-01` | Drag with mouse, pen-equivalent pointer, and touch, then interrupt each gesture by blur, hidden visibility, pointer cancel, owned lost capture, and unmount. | Threshold, pointer capture, preview, edge auto-scroll, and normal release produce one deterministic result; every interruption clears gesture state and a later stale pointer-up produces no mutation. |
| `ARR-RELOAD-01` | Reload after each committed gesture and after Undo. | Persisted project geometry and history checkpoint match the last acknowledged state. |

No screenshot alone passes these cases. Verification requires state assertions against the canonical project model plus playback/export checks where the edit affects sound.
