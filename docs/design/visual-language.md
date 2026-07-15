# VibeSeq visual language

Status: selected direction

Selected concept: Candidate A

Source images: [A desktop](candidates/a-desktop.png), [A mobile](candidates/a-mobile.png), [B desktop](candidates/b-desktop.png), [B mobile](candidates/b-mobile.png)

## 1. Direction

VibeSeq should feel like a quiet, precise instrument that happens to use AI—not a dashboard with music widgets and not a neon “AI music” toy. The stage stays dark so waveform shape, MIDI structure, playhead, selection, and meter movement carry meaning. Warm light and restrained color make long sessions legible without flattening the product into generic gray SaaS.

Candidate A is the visual source of truth. It is a direction, not a pixel specification; component behavior and accessibility may change exact dimensions and values.

## 2. Why Candidate A was selected

| Criterion | Candidate A | Candidate B | Decision |
| --- | --- | --- | --- |
| Musical hierarchy | Arrangement remains dominant; source, detail, and properties read as supporting instruments | Transport, generator, meters, arrangement, and detail compete at similar contrast | Use A's calmer hierarchy |
| Full creative loop | Generation candidates, placement, extraction action, Audio/MIDI content, and detail are visible without turning AI into the whole product | Generation prompt and neon selection dominate the working stage | Use A's “AI beside the song” relationship |
| Long-session comfort | Warm ivory on charcoal with amber/teal accents gives focus without large saturated fields | Lime/coral/blue contrast is energetic but fatiguing at full-screen density | Use A palette and contrast rhythm |
| Desktop information density | Dense but readable: persistent transport, track state, central arrangement, contextual detail/properties | Highly data-dense but too many always-on numeric and meter surfaces | Start with A; reveal expert detail progressively |
| Mobile adaptation | Keeps the arrangement, adds selected-clip actions, and turns detail into a bottom sheet | Strong visual identity, but generation and transport occupy too much of the narrow screen | Use A's staged mobile flow |
| Audio/MIDI distinction | Amber waveform and teal MIDI are clear; an additional violet family supports track identity | Coral/indigo are strong but selection lime becomes a third competing system | Use A semantics with non-color labels/icons |
| Brand fit | Warm, tactile, authored | Aggressive technical/editorial aesthetic | A better matches “creative instrument” |

## 3. What is borrowed from Candidate B

Borrow the following concepts, translated into A's lower-noise language:

- **Explicit provenance:** labels such as source, generated locally, model/backend, and extracted-from relationship belong in properties and lineage views.
- **Precise musical readout:** bar/beat/subdivision, effective grid, and selection duration become available when the related object is active.
- **Audio ↔ MIDI lineage:** a restrained connector/badge appears when either linked result is selected or hovered. It is not a permanently bright cable across the arrangement.
- **Dense expert detail:** velocity, confidence/provenance, exact values, and advanced Audio parameters can coexist in an expanded detail editor rather than being removed for visual simplicity.
- **Production metering:** peak plus later loudness/true-peak information belongs in the expanded mixer/export check, not constantly across every edge of the composition stage.

Exclude the following:

- neon lime as the universal selection/focus/action color;
- large coral waveform fields that overwhelm track identity;
- narrow all-caps/condensed text for clip names, prompts, and body copy;
- a permanently expanded generator occupying the full width above the arrangement;
- simultaneous display of every meter, knob, provenance field, selection property, and editor control;
- oversized mobile transport and AI controls that reduce the visible song to a background;
- glow as a substitute for selection, focus, or status.

## 4. Typography

Fonts are bundled with the application. Do not load them from a remote font service in the local-first desktop target.

| Token | Family | Weight | Typical use |
| --- | --- | --- | --- |
| `font-interface` | Space Grotesk Variable | 400–720 | Navigation, track/clip names, buttons, properties, prompts |
| `font-data` | IBM Plex Mono | 400 | Bar/beat, BPM, meter, grid, dB, percentages, timestamps, compact technical labels |
| `font-fallback` | system sans-serif / system monospace | matching | Immediate fallback while bundled fonts load or under platform accessibility settings |

Type scale:

| Token | Size / line height | Use |
| --- | --- | --- |
| `type-brand` | 24/28 desktop, 26/32 mobile; 600 | Wordmark only; custom tracking, never all caps |
| `type-title` | 18/24; 600 | Empty-state or creation/detail title |
| `type-section` | 14/20; 600 | Track name, sheet title, main contextual heading |
| `type-body` | 13/19 desktop, 14/20 mobile; 400 | Prompt, property values, explanations |
| `type-control` | 12/16 desktop, 14/20 touch; 500 | Buttons, tabs, menus |
| `type-clip` | 12/16; 500 | Clip/region labels; ellipsize after preserving meaningful stem |
| `type-data` | 12/16; 500 mono | BPM, snap, musical position, level |
| `type-micro` | 10/14; 500 mono, +0.08em | Short category labels only, for example `SOURCE`, `DETAIL`, `MIDI`; never paragraphs |

Rules:

- Numeric columns use tabular figures. Bar/beat/subdivision stays fixed-width while playing.
- Do not uppercase prompts, asset names, track names, errors, or long button labels.
- Use weight and spacing before increasing size. The arrangement should not jump when a value becomes selected.
- At 200% text zoom, essential labels wrap or reflow; they do not overlap transport or trim handles.

## 5. Color system

All values are initial sRGB design tokens and must be verified in the rendered component states.

### 5.1 Neutral stage

| Token | Value | Role |
| --- | --- | --- |
| `color-canvas` | `#0B0D0E` | Window and deepest background |
| `color-stage` | `#101415` | Arrangement/editor canvas |
| `color-surface-1` | `#111315` | Supporting panels and track headers |
| `color-surface-2` | `#171A1C` | Raised controls, selected sheets, menus |
| `color-surface-hover` | `#1D2224` | Hover/pressed preparation state |
| `color-line-subtle` | `rgba(232, 227, 216, 0.08)` | Bar subdivisions and panel separators |
| `color-line-strong` | `#2D3436` | Boundaries, inactive handles, major grid lines |
| `color-text-primary` | `#E8E3D8` | Primary text and critical icons |
| `color-text-secondary` | `#9C9A93` | Secondary properties and labels |
| `color-text-muted` | `#6F7471` | Inactive/supporting metadata; never critical status alone |

### 5.2 Semantic voices

| Token | Value | Role |
| --- | --- | --- |
| `color-audio` | `#F6A84B` | Audio waveform, Audio type icon, Audio-local edit handles |
| `color-audio-soft` | `#B97235` | Audio secondary accent; clip wash is derived with `color-mix()` |
| `color-midi` | `#5DD6D1` | MIDI notes, MIDI type icon, extraction action/result |
| `color-midi-soft` | `#123A3A` | MIDI clip/editor wash |
| `color-track-alt` | `#A98BE8` | Optional third track identity family, not a status |
| `color-success` | `#68D69B` | Local backend ready, saved, completed |
| `color-warning` | `#E9B657` | Slow fallback, clipping risk, recoverable attention |
| `color-danger` | `#F07868` | Failed, destructive, unavailable |
| `color-focus` | `#F6EBDD` | Keyboard focus ring and high-precision insertion cue |

Color contracts:

- Amber and teal identify material families; they do not alone mean selected. Selection combines a 2 px material-colored outline, brighter content, and handles. Keyboard focus adds an outer ivory ring.
- Playhead is warm ivory on dark content; cycle/range uses amber at low fill opacity. They must remain distinguishable when crossing an amber Audio clip.
- Muted content keeps geometry but drops to roughly 28% opacity and adds a visible muted/type indicator.
- Generated and extracted states use provenance icon/text. Do not add another permanent “AI purple.”
- Error and warning colors never replace explanatory text.

## 6. Spacing, density, and shape

Use a 4 px base grid.

| Token | Value | Use |
| --- | --- | --- |
| `space-1` | 4 px | Icon/text micro-gap, grid-safe inset |
| `space-2` | 8 px | Compact control gap, clip inset |
| `space-3` | 12 px | Control padding, grouped values |
| `space-4` | 16 px | Panel inset, mobile action spacing |
| `space-5` | 24 px | Section separation |
| `space-6` | 32 px | Large empty-state separation only |

Density rules:

- Desktop compact control height: 28–32 px. High-frequency transport controls: 36–40 px.
- Touch target: at least 44×44 CSS px, even when the visible icon is smaller.
- Track default height should show name, type/state, and recognizable clip content; compacting may reduce properties, never hide selection or mute/solo state.
- Use 1 px separators to establish the instrument chassis. Avoid placing every group in a rounded floating card.
- Clip corner radius: 4–6 px. Desktop panel radius: 6–8 px. Mobile sheet radius: 20–24 px at exposed top corners. Toast/job pill radius may be fully rounded because it is transient.
- Shadows are reserved for overlapping menus/sheets. Prefer border, contrast, and slight tonal lift for persistent regions.

## 7. Hierarchy and layout rhythm

Visual priority follows musical consequence:

1. **Audible now:** playhead, transport state, cycle, meters, solo/mute, current position.
2. **Selected intent:** selected clip/note/time, handles, detail editor, exact scoped values.
3. **Song structure:** tracks, clips, bar grid, waveform/MIDI silhouettes.
4. **Available creation:** prompt, candidates, import/library.
5. **Provenance and diagnostics:** model, backend, source chain, timestamps, confidence.

Candidate A's desktop composition stage is allowed to be visually larger than creation and properties. On mobile, the arrangement remains visible while a compact selection action strip and staged detail sheet appear. Generation progress is a small persistent job indicator rather than a modal takeover.

Panel boundaries align with track rows, ruler, and editor timing lines where possible. Avoid dashboard-style independent card grids that break the shared musical axis.

## 8. Waveform language

### 8.1 Arrangement waveform

- Draw cached min/max peaks per horizontal pixel; never draw a misleading smoothed area when zoomed out.
- Use a 1 px centerline at low contrast. Mono is mirrored; stereo uses separate upper/lower channels when track height permits.
- Audio color comes from `color-audio` or a user track family. Peak density may change opacity slightly, but amplitude is primarily geometry, not a decorative gradient.
- Selection raises waveform contrast and reveals trim/loop handles. Fade curves appear as thin ivory/amber lines with distinct control points.
- Muting preserves waveform shape at reduced contrast. Missing/offline media uses an outlined placeholder and named error rather than a fake waveform.

### 8.2 Detail waveform

- Preserve transients at every zoom level using level-of-detail peak data.
- Major beats, minor subdivisions, clip/source boundary, loop boundary, and warp/transient anchors have distinct weights/shapes.
- Raw source geometry remains stable under non-destructive clip gain. A gain/envelope line and audible preview show transformation.
- Extracted MIDI onset/pitch overlays use teal stems/notes aligned to the same clock. The overlay is optional and never obscures waveform zero crossings or fade handles.
- Loading uses a neutral skeleton or progressive peak refinement, not random decorative waveform motion.

## 9. MIDI language

### 9.1 Arrangement MIDI

- Notes are crisp horizontal bars positioned by pitch and time. Preserve start, duration, chord density, and register even at reduced height.
- Use teal as the default MIDI voice; other track families may vary, while the MIDI type icon/label remains present.
- Selected clips increase boundary/content contrast; individual note selection belongs to detail and is not faked at arrangement scale.
- Linked source Audio and extracted MIDI show a small lineage badge; connectors appear only on selection/hover.

### 9.2 Piano roll/detail

- Major beat/bar lines are stronger than subdivisions. Octave C rows and scale/root rows have separate subtle emphasis.
- Notes have a minimum visible height of 3 px at low vertical zoom; hit targets can be larger than visual bars.
- Note velocity affects a secondary cue such as fill intensity, but exact values and a velocity lane remain available. Velocity is never encoded only by color.
- Selected notes use a light inner fill plus teal boundary; keyboard focus gets the ivory outer ring.
- Ghost notes from other visible clips are ≤ 22% opacity and never receive handles until promoted to the active clip.
- Extraction confidence, when available, uses a small glyph/outline or optional overlay. Low confidence does not dim a note so far that it appears absent.
- Auditioned notes provide a brief, non-glowing press state and obey the master audition level.

## 10. Icons and imagery

- Use a consistent 1.5 px stroke at 16/20/24 px optical sizes.
- Waveform means Audio; small piano keys/note bars mean MIDI; linked nodes mean extraction/provenance. Pair unfamiliar icons with labels.
- Reserve the sparkle mark for generation and model-assisted transformations. Ordinary edit, save, mix, or export actions do not receive sparkles.
- Play, stop, loop/cycle, mute, solo, record, undo, and redo retain familiar forms.
- Destructive icons use danger color only at confirmation/hover/active state; a trash can is not permanently bright red.
- Do not use stock AI brain/robot illustrations. Empty states may use abstract waveform/grid compositions derived from actual product geometry.

## 11. Motion

Motion communicates state changes and physical continuity.

| Token | Duration | Use |
| --- | --- | --- |
| `motion-instant` | 80 ms | Button press, handle activation, focus transfer |
| `motion-fast` | 120 ms | Hover/selection color and compact disclosure |
| `motion-panel` | 180 ms | Desktop drawer/detail resize when not directly dragged |
| `motion-sheet` | 220 ms | Mobile sheet between snap points |

Use an ease-out curve for appearing surfaces and ease-in-out for reflow. Direct manipulation, meters, waveform scrub, and playhead are not eased.

- Playhead travels linearly and snaps immediately after seek.
- Job progress may use a restrained moving edge or numeric progress. Indeterminate work uses one low-contrast pulse, not a full-panel shimmer.
- Candidate completion may lift contrast once; no celebratory burst interrupts playback.
- Dragging shows the exact future clip boundary and snap guide. On drop, do not bounce.
- Panel animation never delays access to Stop or Undo.
- Under `prefers-reduced-motion`, use instantaneous state changes and numeric/static progress; preserve all semantic feedback.

## 12. Component interpretation of Candidate A

| Visual concept | Working component behavior |
| --- | --- |
| Stable top transport | Shared transport state, stable-width musical readout, compute/backend status, keyboard and touch variants |
| Left creation area | Collapsible creation/library surface; generation remains asynchronous and candidates are draggable/placeable assets |
| Central arrangement | Virtualized shared-time canvas with tracks, clips, ruler, cycle, playhead, selection, snap guides |
| Right clip properties | Contextual properties bound to primary selection; provenance and destructive/non-destructive actions progressively disclosed |
| Lower detail | Selection-following Audio/MIDI editor with independent zoom/snap and shared time/playhead |
| Mobile quick actions | Selected-object command bar; only the highest-frequency valid actions are shown |
| Mobile detail card | Bottom sheet with collapsed/medium/full snap points; retains exact selection and arrangement context |
| Generation progress pill | Global job summary linked to its creation surface; cancel/retry/status without blocking music |

## 13. Visual QA checklist

- At 100%, 125%, 150%, and 200% browser zoom, transport, clip labels, handles, and selection scope remain legible.
- At 360×800 CSS px, no primary action is outside safe-area insets or behind the software keyboard.
- Lightness contrast, not hue alone, distinguishes canvas, track, clip, selection, focus, playhead, and cycle.
- A grayscale screenshot still reveals Audio/MIDI via icon/geometry, selected/focused state, muted state, and errors.
- A dense 24-track fixture does not become a wall of accent color; nonselected content recedes.
- A sparse two-track fixture still feels like an instrument, not an empty admin dashboard.
- Waveforms and MIDI notes remain geometrically stable during selection, playback, and panel resize.
- Motion-disabled and screen-recorded 30 FPS variants preserve all task-critical state.
