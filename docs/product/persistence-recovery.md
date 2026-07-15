# Persistence and recovery contract

## Scope

The core persistence layer stores a complete, validated checkpoint rather than
independent project fragments. A checkpoint contains:

- the musical `Project`, including source assets, provenance, and `Project.jobs`;
- pre-placement generation candidates, optionally including their Blob or raw
  bytes;
- the current inference job identity, kind, status, progress, result, and error;
- a unique checkpoint ID, monotonic durability revision, and save timestamp.

The application can continue using `save(project)` and `load(projectId)`.
`saveWorkspace(project, session)` and `loadWorkspace(projectId)` are the P0 API
for candidate-bin and active-job durability. A later project-only autosave
preserves the most recently journaled session instead of clearing it.

`importWorkspace(checkpoint)` commits an already validated checkpoint through
the same recovery-first transaction while preserving its checkpoint ID, save
time, project jobs, session candidates, active job, and binary media. It assigns
a newer local durability revision so an imported checkpoint cannot be hidden by
an older record already present in another backend.

## Durable journal behavior

IndexedDB is the primary backend. Each save has two durable phases:

1. write the complete checkpoint to the `recovery` object store;
2. atomically replace the acknowledged `projects` record and remove the pending
   recovery record in one transaction.

The localStorage fallback uses the same order with separate recovery and project
keys. If the primary write is interrupted after the recovery write, the previous
acknowledged project remains intact and the newer complete checkpoint is
available through `loadRecovery(projectId)`.

Reads are arbitrated across IndexedDB, localStorage, and the in-session fallback
instead of trusting the first backend that responds. The checkpoint with the
greatest durability revision is authoritative. Equal revisions with different
checkpoint IDs raise `ProjectCheckpointConflictError`; VibeSeq never chooses a
side silently. A fallback checkpoint acknowledged after an IndexedDB failure
therefore cannot be replaced by an older IndexedDB record after reload.

Recovery is never silently applied. `recover(projectId)` explicitly promotes
the pending checkpoint; `discardRecovery(projectId)` removes it. A pending entry
with the same checkpoint ID as the primary is treated as completed cleanup and
is not offered as newer work.

`listRecoveries()` enumerates journals from every backend and project ID, then
applies the same global revision arbitration. This includes a failed import or
new-project transaction whose project ID has never appeared in the acknowledged
project list. Startup presents the active project's pending journal first and
then the remaining journals newest-first. Recovering or discarding one journal
does not make another pending journal unreachable.

A new save is rejected with `ProjectRecoveryPendingError` while a newer recovery
exists. This prevents startup autosave or another tab from silently overwriting
unacknowledged work before the user chooses recover or discard. When a backend
fails after writing the recovery phase, persistence does not report a memory
fallback as a successful durable save. A browser persistence instance can keep
the current session in memory, but rejects the barrier with a typed
`ProjectDurabilityError`. Quota exhaustion is distinguished from general durable
storage unavailability.

The Studio routes the 450 ms edit debounce and explicit durability barriers
through one ordered save lane. Before WAV or MIDI export, and before creating or
opening a project, `flushWorkspaceSave()` cancels any pending
timer, reads the latest project and session references, and awaits a real
`saveWorkspace` commit. A failed barrier blocks the export or project switch and
reports the storage error. It does not continue with a stale checkpoint or show
a success message. Portable project export is the deliberate exception: when a
durable flush fails, the Studio can serialize the latest coherent in-memory
project/session as a `-recovery.vibeseq` emergency bundle while keeping the
persistent unsaved warning visible. The bundle is not reported as a successful
local save. `visibilitychange` to hidden and `pagehide` enqueue the same
flush as a best effort; browser shutdown can still interrupt asynchronous work,
so the recovery journal remains authoritative.

The in-memory history queue has a separate project-boundary guard.
`replaceState` increments a state epoch; execute, update, undo, and redo work
capture that epoch before entering the async queue and check it again before
and after awaited mutation work. A queued or in-flight operation from the
previous project may finish, but its result cannot replace the newly opened or
created project and cannot add an Undo entry to that project's history. This is
an edit-history integrity rule, not a substitute for the durable flush and
recovery barrier above.

Project deletion uses the same durability boundary. The Studio first drains the
ordered save lane so an older queued write cannot recreate the removed project.
The persistence layer then removes both the acknowledged checkpoint and recovery
journal from every available backend and verifies that the project is absent
from the merged catalog. When deleting the open project, the Studio safely
cancels an active inference job and prepares another verified saved project or
a new durable blank project before removing the old record. The device-global
Sound Library has separate ownership and is deliberately preserved.

## Serialization and migration

Portable serialization uses a `vibeseq-project` envelope with an independent
serialization version and project schema version. Imports validate required
objects, enums, finite numbers, IDs, clip/track compatibility, MIDI ranges,
timestamps, jobs, candidate state, and JSON-compatible inference results before
returning a copy.

The envelope revision is required for new checkpoints. Legacy envelopes derive
a deterministic revision from `savedAt` before validation so they can participate
in cross-backend arbitration. Project schema 4 requires every Audio clip to
carry an explicit `fixed-seconds` or `tempo-follow-repitch` timebase and authored
source BPM. Schema 1–3 projects migrate on a copy: bar-generated Audio with
recorded generation BPM becomes tempo-follow/repitch, while other legacy Audio
is fixed to the imported project's current BPM. The importer supports the
released raw schema-1 document, including its former
base64 media envelopes. Future serialization or project schema versions fail
with a typed `ProjectImportError`; they are never coerced into the current
shape. Migration and validation build a new object and do not mutate the input.

A corrupt encoded project asset is isolated: its metadata remains loadable,
media is omitted, and `integrity.state` is `corrupt`. The same rule applies to
candidate media. One corrupt project record is excluded from project listing
without hiding healthy projects or preventing removal.

## Portable `.vibeseq` bundles

The Studio exports the existing versioned `vibeseq-project` checkpoint envelope
with the `.vibeseq` extension and media type
`application/vnd.vibeseq.project+json`. The bundle includes:

- the complete project, tracks, clips, Audio timebases, MIDI notes, meter,
  assets, provenance, and project job records;
- unplaced Stable Audio candidates and their encoded media;
- the current inference job snapshot, including status, progress, result, and
  error state;
- Blob or ArrayBuffer media encoded as base64 binary envelopes.

Before export, each project asset and candidate must have local bytes and pass
SHA-256 verification. Valid legacy bytes without an existing content hash are
assigned their computed identity during export. Missing, divergent, or corrupt
media blocks the bundle instead of producing an incomplete portable project.

Import is staged before any visible project mutation: parse and schema
validation, binary decode, and asynchronous SHA-256 verification all complete
first. The current workspace is then flushed and the imported checkpoint is
committed through `importWorkspace`. Only after that commit succeeds does the UI
replace the active project, candidate/job session, selection, playback buffers,
and remembered active-project ID. Any validation, integrity, current-save, or
import-commit failure leaves the previous project active and reports a clear
failure message.

## Integration boundary

The core contract is exported from `src/core/persistence.ts`, with portable
bundle verification in `src/core/projectBundle.ts`. The UI must pass
its candidate list and active job to `saveWorkspace`, enumerate
`listRecoveries()` at startup, and explicitly ask whether to recover or discard.
Candidate bytes only
survive offline reload when the caller supplies `blob` or `bytes`; an API URL by
itself remains dependent on the local inference service's asset store.

The memory backend follows the same API but is not durable across process
restart. A UI must not label the memory fallback as a durable local save.
