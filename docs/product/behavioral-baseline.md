# VibeSeq behavioral baseline

Status: product baseline

Research date: 2026-07-15

Scope: arrangement, region/clip editing, audio/MIDI editing, transport, navigation, selection, snapping, zoom, track/mixer, undo/redo, desktop and mobile interaction

Focused arrangement supplement: `docs/product/arrangement-clip-interaction-contract.md`

Focused detail-editor supplement: `docs/product/detail-editor-interaction-contract.md`

## 1. Why these references

VibeSeq is not an Ableton Live or BandLab skin. The two products are used as complementary evidence:

- Ableton Live 12 is the reference for a dense desktop editing model: a linear Arrangement, selection-based commands, a context-sensitive Clip View, adaptive/fixed grids, and mixer controls available without abandoning the arrangement.
- BandLab Studio is the reference for carrying the same musical objects and commands between web and mobile: regions remain directly editable, a selected region gets a compact action menu, and deeper Audio/MIDI editing moves into a contextual editor.
- Ableton Live itself is not a mobile DAW and its UI does not officially support multi-touch. Therefore VibeSeq must not shrink Ableton's desktop layout onto a phone. Mobile behavior is derived primarily from BandLab's official mobile flows and from the musical invariants shared by both products.

The baseline is behavioral. Labels, exact panel positions, colors, icons, and shortcuts may differ when VibeSeq's generation and extraction loop requires a better solution.

Focused Logic Pro computer-use observations supplement the arrangement/clip and detail-editor portions of this baseline. They do not replace the broader Ableton Live and BandLab research, and only directly executed or visible behavior is treated as evidence. The observation boundaries and VibeSeq-specific decisions are recorded in `docs/product/arrangement-clip-interaction-contract.md` and `docs/product/detail-editor-interaction-contract.md`.

## 2. Official evidence

### Ableton Live 12

- [Arrangement View](https://www.ableton.com/en/live-manual/12/arrangement-view/): linear song structure, overview navigation, track lanes, selection-based editing, adaptive/fixed grid, temporary snap bypass, time commands, fades, and arrangement mixer.
- [Clip View](https://www.ableton.com/en/live-manual/12/clip-view/): selected-clip context, audio/MIDI-specific editors, resizable detail area, and multi-clip selection.
- [Editing MIDI](https://www.ableton.com/en/live-manual/12/editing-midi/): piano-roll editing, selection-aware zoom, grid behavior, and temporary snap bypass.
- [Audio Clips, Tempo, and Warping](https://www.ableton.com/en/live-manual/12/audio-clips-tempo-and-warping/): tempo following, non-destructive time manipulation, warp markers, transient-aware modes, and follow behavior.
- [Mixing](https://www.ableton.com/en/live-manual/12/mixing/): peak/RMS meters, volume, pan, mute, solo, arm, multi-track adjustment, and resizable mixer detail.
- [Live Concepts](https://www.ableton.com/en/live-manual/12/live-concepts/): persistent control bar, transport, tempo, cycle, automation, follow, and view relationships.
- [Apps for controlling Live with an iOS or Android device](https://help.ableton.com/hc/en-us/articles/209071989-Apps-for-controlling-Live-with-an-iOS-or-Android-device): Live's own interface does not support multi-touch; phone/tablet control is delegated to purpose-built surfaces.

### BandLab Studio

- [Getting Started with the BandLab Studio](https://help.bandlab.com/hc/en-us/articles/115002945153-Getting-Started-with-the-BandLab-Studio): web/mobile parity for adding tracks, importing material, recording, metronome, and basic Studio flow.
- [Editing Audio Regions](https://help.bandlab.com/hc/en-us/articles/900003878046-Editing-Audio-Regions): fades, normalization, reverse, gain, pitch, playback rate, and mobile quick actions.
- [Editing MIDI Regions](https://help.bandlab.com/hc/en-us/articles/360022659314-Editing-MIDI-Regions): contextual piano roll, note drawing/resizing, velocity, quantize, and mobile-specific commands.
- [Duplicating and Extending Regions](https://help.bandlab.com/hc/en-us/articles/57253754933529-Duplicating-and-Extending-Regions): multi-region copy/paste and shared trim behavior on web/mobile.
- [Slicing and Merging Regions](https://help.bandlab.com/hc/en-us/articles/57252800910745-Slicing-and-Merging-Regions): playhead-based slicing and multi-region merge on web/mobile.
- [Looping Regions and Setting a Playback Cycle](https://help.bandlab.com/hc/en-us/articles/57252306473497-Looping-Regions-and-Setting-a-Playback-Cycle): region looping and a separately controlled playback cycle.
- [Using Automation](https://help.bandlab.com/hc/en-us/articles/360021039314-Using-Automation): expandable automation lanes, breakpoint editing, and mobile long-press selection.
- [Studio keyboard shortcuts](https://help.bandlab.com/hc/en-us/articles/360021363353-What-are-the-shortcuts-for-the-Studio-): conventional undo/redo, transport, zoom, selection, snap, and duplicate commands on web.
- [Converting Audio to MIDI](https://help.bandlab.com/hc/en-us/articles/37575596722329-Converting-Audio-to-MIDI): conversion begins from a selected audio region and creates a new MIDI instrument track rather than mutating the source.
- [Downloading Mixdowns and Tracks](https://help.bandlab.com/hc/en-us/articles/115002959774-Downloading-Mixdowns-and-Tracks): project mixdown and per-track Audio/MIDI export.
- [Can I use BandLab offline?](https://help.bandlab.com/hc/en-us/articles/360025765673-Can-I-use-BandLab-offline): BandLab's content and save model are cloud-based, so its interaction patterns are evidence but its persistence architecture is not a model for local-first VibeSeq.
- [Supported Import and Export File Formats](https://help.bandlab.com/hc/en-us/articles/360036010533-Supported-Import-and-Export-File-Formats): export capabilities differ between web, iOS, and Android, reinforcing that adaptive UI must disclose target capability rather than imply false parity.

## 3. Common practices and VibeSeq interpretation

| Area | Verified common practice | VibeSeq behavioral baseline |
| --- | --- | --- |
| Arrangement | Audio and MIDI occupy track lanes on a left-to-right musical time axis. Regions/clips can be moved, trimmed, duplicated, split, looped, and reordered without opening a separate page. | The arrangement is the canonical statement of the song. Generated assets and extracted structures become clip instances on this time axis only after an explicit place/commit action. |
| Clip/region identity | A region is a manipulable instance; source media and timeline placement are conceptually distinct. Edits such as trim, fade, gain, pitch, and timing do not require destructive source replacement. | Keep immutable or versioned source assets separate from clip instances. Moving, trimming, stretching, fading, muting, or deleting an instance never overwrites generated audio or the original imported file. |
| Contextual detail | Selecting or double-clicking a clip opens a content-specific detail editor. The main arrangement remains the context for where that material lives. | Audio opens implemented clip-slice waveform controls; MIDI opens notes/velocity/quantize controls. Detail follows the primary selection, keeps nested selection distinct from the parent clip, and shares playhead, loop, and musical time while retaining an independent zoom level. See `docs/product/detail-editor-interaction-contract.md`. |
| Audio editing | Direct edge trim, fade handles, region gain, reverse, pitch/playback manipulation, transient-aware stretch, and source-preserving edits are standard. | Always expose implemented trim and fade controls on the clip or contextual detail. Every render-affecting control must show whether it is real-time/non-destructive or creates a new derived asset. VibeSeq does not expose a source-file editor until versioned derivative and recovery semantics exist. |
| MIDI editing | Notes are horizontal bars on a time/pitch grid. Move, resize, draw/delete, velocity, transpose, quantize, and multi-note editing are expected. | Extracted MIDI is immediately ordinary editable MIDI. Extraction confidence/provenance may be shown, but must never make notes second-class or lock normal editing. Velocity gets both a numeric/graphical editor and an in-note cue. |
| Audio-to-MIDI | Conversion starts from selected audio and produces a new MIDI result while preserving the audio. | MuScriptor extraction creates a linked, versioned MIDI derivative aligned to the source clip's musical start. Re-extraction makes a new take/version; it never silently replaces hand-edited MIDI. |
| Transport | Play/stop, record when available, current position, tempo, meter, metronome, cycle/loop, and follow are globally reachable and visually stable. | Play/stop and position remain available while generating, extracting, editing, mixing, or exporting. Generation jobs cannot seize transport. Cycle state is distinct from a looping clip and from a time selection. |
| Timeline navigation | Horizontal scroll/pan, ruler scrubbing, overview/fit, follow-playhead, and selection-aware zoom reduce loss of context. | Zoom is centered on pointer/pinch focal point. Fit Selection and Fit Arrangement are explicit. Follow pauses when the user navigates or edits, then resumes only through an explicit action or predictable playback restart. |
| Selection | Editing is selection-based. Object, track, note, automation-point, and time-range selections can span related content; modifiers or long-press extend to multiple objects. | One visible primary selection anchors the inspector/detail editor. Multi-selection is additive. Focus, insertion playhead, time range, cycle, and object selection are separate states and use different visuals. Destructive commands state their scope before execution. |
| Snapping | Grid snapping is normally on, can be fixed or zoom-adaptive, and can be bypassed temporarily. Grid spacing is visible. | Show the active musical division beside the timeline/editor. Support off, fixed musical divisions, and adaptive display. A temporary bypass must work during drag without changing the saved grid setting. Arrangement and detail can have different divisions but must display both. |
| Zoom | Horizontal zoom is continuous; vertical track/editor sizing is separate; a full-project or selected-content fit command exists. | Wheel/trackpad/pinch zoom time around the user's focal point. Vertical resize changes information density, not audio gain or MIDI velocity. Preserve scroll position when opening/closing supporting panels. |
| Track workflow | Track headers keep identity and essential state close to content. Reorder, resize, mute, solo, arm, volume, and pan are available without navigating away. | Each track exposes name/type, mute, solo, level, and minimal activity. Advanced routing/FX may live in Mix/Inspector surfaces, but all views read and write the same track state. Generated, imported, and extracted provenance is metadata, not a separate track class. |
| Mixer workflow | Compact track controls support arranging; a more detailed mixer exposes meters and additional controls. State is shared between both. | Arrangement track controls and the expanded mixer are two projections of one model. Changing level, pan, mute, or solo anywhere updates everywhere immediately and participates in undo when the change is an edit rather than a temporary audition. |
| Undo/redo | Standard platform shortcuts and visible commands are expected. Repeated micro-adjustments should feel reversible without surprising scope. | All project mutations—including placement, extraction commit, note edits, clip transforms, mixer automation, track changes, and import—enter one ordered history. Scrub/play/selection/focus/audition do not. Continuous drags coalesce into one history item. |
| Responsive/mobile | BandLab preserves the same objects but relocates commands into selected-region menus and bottom editors. Ableton demonstrates why a desktop control surface should not simply be scaled down. | Preserve arrangement, clips, tracks, transport, and detail semantics. On narrow screens, use selection-triggered quick actions and a staged bottom sheet; do not hide core edits behind a desktop-only path. Touch targets and gestures must be deliberate and undoable. |

## 4. Editing invariants

These are release-blocking contracts, not visual preferences.

1. **What plays is explainable.** The playhead, active cycle, clip mute state, track mute/solo state, and any tempo-follow behavior are visible from the working context.
2. **The source survives.** Generated/imported audio and an extraction input remain recoverable after any arrangement edit. Destructive processing creates a named derived asset with provenance.
3. **Selection predicts effect.** The same selection highlight that appears on screen is the scope used by duplicate, delete, split, extract, consolidate, quantize, and export-selection commands.
4. **Time has one meaning.** Arrangement, waveform detail, MIDI detail, cycle range, and export use the same bar/beat mapping and project tempo/meter map.
5. **Transport is independent of jobs.** Playback and editing continue while generation or extraction is queued/running when resource limits permit; when they do not, the UI explains the reason and never fakes playback state.
6. **AI results are candidates.** Auditioning a Stable Audio result does not alter the arrangement. Placing it does. Previewing MuScriptor output does not overwrite edited MIDI. Committing it does so as a new linked derivative.
7. **Every mutation is recoverable.** Undo/redo or an explicit version action can recover the prior musical state; a reload cannot reveal a different state than the last acknowledged save.
8. **The mobile project is the same project.** A project opened on desktop and mobile retains musical timing, clip parameters, provenance, and history checkpoint semantics even when controls are rearranged.

## 5. Command baseline

Exact shortcuts can be customized later, but the command grammar must stay conventional.

| Intent | Desktop baseline | Touch baseline |
| --- | --- | --- |
| Play/stop | `Space` and persistent control | Persistent, comfortably sized control |
| Undo/redo | `Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z` plus menu | Visible in overflow/toolbar; gesture alone is insufficient |
| Select one | Click/tap object | Tap object |
| Extend/toggle selection | `Shift` for ranges; platform modifier for non-adjacent objects | Long-press or explicit multi-select, then tap additional objects |
| Move clip/note | Drag body with movement threshold | Drag selected body; edge handles remain distinct |
| Trim/resize | Drag edge handle | Drag enlarged edge handle |
| Duplicate | Shortcut/menu and modifier-drag where safe | Selected-object quick action |
| Split | Playhead/time-selection command | Selected-object quick action at visible playhead |
| Open detail | Double-click or explicit Edit | Double-tap or selected-object Edit action |
| Pan timeline | Trackpad/wheel/scrollbar; drag empty overview | Drag empty canvas; two-finger pan remains available while an object is selected |
| Zoom time | Trackpad/wheel modifier around pointer; fit commands | Pinch around gesture centroid; fit command |
| Temporary snap bypass | Modifier during drag | Hold/press snap chip during drag or use selected-object precision action; never require a hidden multi-finger chord |

## 6. Explicit non-goals

- Do not recreate Ableton's Session View unless user research proves a clip-launch performance workflow is central to VibeSeq.
- Do not import BandLab's social publishing, cloud-revision, or membership model. VibeSeq is local-first.
- Do not make generation a modal wizard that removes the arrangement from view.
- Do not represent generated audio as a special clip that lacks ordinary DAW editing.
- Do not couple an extracted MIDI clip so tightly to its audio source that editing one silently changes the other.
- Do not use color alone to encode Audio, MIDI, selected, muted, generated, or error states.
