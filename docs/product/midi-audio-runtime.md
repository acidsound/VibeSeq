# MIDI and realtime audio runtime

Status: implemented runtime contract; release evidence remains tracked in
`docs/product/verified-slice.md`.

## Audio thread boundary

The Studio selects `AudioWorklet` as its normal playback backend. The main UI
thread decodes and integrity-checks local media, then sends immutable PCM and a
project render snapshot to the worklet. Playback position, Audio and MIDI
rendering, gain/pan smoothing, mute/solo decisions, metering, audition, cycle,
and transport advancement run in the audio render callback.

Ordinary mixer gestures do not rebuild the audio graph. Track gain, pan,
mute/solo, master gain, and cycle changes are small worklet messages. Project
edits send a new render snapshot while preserving the existing node and decoded
assets. Before playback, every Audio asset referenced by the arrangement is
decoded and synchronized, including initially muted or non-soloed tracks, so a
live mute/solo change cannot reveal a missing buffer.

For live Track gain/pan/mute/solo and master-gain controls, the UI sends the
small parameter message before committing the separately coalesced project
mutation. The audio render callback therefore does not wait for React rendering,
autosave, or a full project snapshot. If the project mutation is rejected, the
host resynchronizes that parameter from committed state; it does not stop and
recreate transport as rollback. This is the runtime contract behind both the
Arrangement controls and mobile/Inspector sliders.

Live mute/solo target changes use a finite 5 ms sample-domain gate ramp. A
second target change restarts the ramp from its current value, avoiding an
endpoint jump during rapid toggles. Offline export has no live-control
transition to smooth: it applies the persisted final mute/solo decision from
the first rendered frame. The two paths intentionally differ only at that live
control edge, not in the final audible track decision.

Returning from a hidden page uses an explicit re-entry path. A closed owned
`AudioContext` is recreated, the processor module and all retained PCM are
resynchronized, and playback resumes only when the previous engine state
requires it. Processor errors are surfaced to the user; they do not silently
switch the shipping path to the older main-thread scheduler. The legacy Web
Audio engine exists only as an explicitly selected compatibility backend.

## MIDI routing model

Routing belongs to a MIDI track, not to individual note widgets:

- Channels are stored as the MIDI wire value `0..15` and displayed as `1..16`.
- Melodic tracks use WebAudio-TinySynth. Their channel cannot be wire channel
  `9`, and their General MIDI program is stored as `0..127`.
- Drum tracks use `WebAudioFont 128_0_Chaos_sf2_file` and are fixed to wire
  channel `9`, displayed as channel 10.
- Legacy projects and hot-loaded history snapshots are normalized before an
  edit. Missing old routing metadata therefore cannot block Solo, Mute, or an
  unrelated clip edit.
- Standard MIDI export writes each track's selected channel and, for melodic
  tracks, its program-change event.

The track inspector is the user-facing source of truth for profile, channel,
and program. Changing melodic/drum profile is atomic: choosing drums also fixes
the channel to 10; choosing melodic restores a valid melodic default.

Detail-editor audition resolves that same track-owned routing snapshot. Note
selection and piano-key pointer/keyboard input send start/release commands to
AudioWorklet with the selected MIDI track ID, pitch, velocity, channel, program,
and melodic/drum profile. TinySynth melodic previews and pinned Chaos drum
previews therefore follow Track properties rather than a widget-local default.
Replacement, pointer/key release, cancellation, and focus loss use the MIDI
preview release path; candidate-audio audition has independent state and is not
stopped by a MIDI-note release.

Candidate and Library audition bytes are decoded into Worklet-only ephemeral
asset IDs rather than retained in the project buffer cache. Natural end,
replacement, explicit stop, hidden-page cancellation, and engine disposal
remove those assets. An AbortController plus a monotonically increasing preview
epoch invalidates fetch, integrity, decode, and resume continuations from an
older preview, so a slow candidate cannot begin after a newer candidate or Stop.
Placed project assets remain on the separate retained synchronization path.

## Compact built-in instruments

The melodic renderer uses WebAudio-TinySynth's quality-0 table: 128 General
MIDI programs with one oscillator voice per program. The table is synchronized
from the pinned Apache-2.0 upstream revision recorded in
`scripts/sync-midi-instruments.mjs`.

The drum renderer uses four actual encoded samples from the pinned MIT-licensed
`webaudiofontdata` Chaos kit:

| GM note | Built-in role |
| --- | --- |
| 36 | kick |
| 38 | snare |
| 42 | closed hi-hat |
| 46 | open hi-hat |

Other drum notes map to the nearest core voice with a bounded pitch shift. This
is intentionally a compact kit, not a claim to ship the complete Chaos SF2.
The four bundled MP3 payloads total about 30 KiB; their original WebAudioFont
JavaScript wrappers total about 42 KiB.

Run the following to reproduce the generated table and samples. The script
downloads exact revisions, rejects a source SHA-256 mismatch, and overwrites
only the generated instrument assets.

```sh
npm run sync:midi-instruments
```

Live AudioWorklet and offline WAV export share the same TinySynth envelope,
waveform, deterministic noise, program handling, Chaos sample mapping, playback
rate, and gains. Offline drum rendering rejects a missing decoded built-in
sample rather than substituting a synthetic sound.

TinySynth note-off uses the same finite tail boundary in both renderers:
`releaseSeconds * 8`, with the per-program release itself bounded by the runtime
contract. The Worklet's backwards event scan and offline renderer therefore do
not truncate a long-release program at the former fixed four-second boundary.

## Honest limitations

- TinySynth quality 0 is deliberately lightweight and does not reproduce a
  multi-sample workstation or the higher-quality TinySynth program table.
- The compact drum kit has four source samples; mappings outside those notes
  are approximations.
- Track routing does not yet expose banks, per-note multi-channel routing,
  external MIDI ports, plug-ins, sends, or automation.
- The main-thread compatibility backend is not the release parity target.
- Worklet mixer-command, 5 ms gate, ephemeral-audition lifecycle,
  render-kernel/release-tail parity, re-entry, and host synchronization have
  source/unit coverage, but the integrated controls still await the final
  batched Playwright continuity run and captured-audio underrun/click evidence.
- Playback preparation now binds the latest committed Project render graph and
  its verified PCM set at the Play command boundary. A UI-side content-hash hit
  is accepted only when the AudioWorklet engine still owns that buffer, and a
  project/placement change during decode causes bounded re-preparation instead
  of playing against stale asset IDs. The project-reopen → generate/place →
  play regression is queued in the same batched Playwright run.
- Routed Detail audition has source and unit-level coverage, but final batched
  browser interaction/captured-audio verification is still pending.

Upstream attribution and revision details are listed in
`THIRD_PARTY_NOTICES.md`.
