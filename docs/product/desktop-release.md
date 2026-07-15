# Desktop release target

Status: unsigned prerelease packaging for native Windows and Apple Silicon
validation.

## Artifacts

A tag matching `v*` runs `.github/workflows/desktop-release.yml` and publishes a
private GitHub prerelease containing:

- `VibeSeq-<version>-Windows-x64.exe`: portable Windows executable.
- `VibeSeq-<version>-macOS-arm64.dmg`: Apple Silicon disk image.
- `VibeSeq-<version>-macOS-arm64.zip`: Apple Silicon application archive.
- `SHA256SUMS.txt`: release-asset checksums.

The builds embed the production Studio bundle and a frozen Python inference
sidecar. Node.js, Python, `uv`, and a separate web server are not required on the
target machine. The Electron renderer has no Node integration, uses context
isolation and the Chromium sandbox, and can navigate only within its randomly
allocated loopback origin.

## Storage root

VibeSeq keeps large and durable data out of opaque operating-system caches.
The Windows portable executable creates `VibeSeq Data` beside the distributed
`.exe`. The macOS application uses `~/VibeSeq Data`. `VIBESEQ_HOME` overrides
either default for an external drive or another user-selected location.

The root contains `models`, `runtimes`, `projects`, `library`, `inference`,
`cache`, `logs`, and `profile`. The Electron profile (including IndexedDB),
model downloads, inference artifacts, and runtime caches therefore move as one
unit. The macOS application bundle itself is never modified.

## Model runtime and offline demo build

The desktop sidecar freezes the real medium-model dependencies and pinned
Stable Audio execution source. It defaults to Stable Audio 3 Medium and
MuScriptor Medium; demo providers are never substituted silently.

Standard GitHub assets do not embed the multi-gigabyte weights. They resolve
exact revisions from the `VibeSeq Data/models` cache. For an offline Apple
Silicon demonstration build, first ensure both exact model snapshots exist in
the local Hugging Face cache, then run:

```sh
npm run desktop:pack
npm run desktop:bundle-models:mac -- release/mac-arm64/VibeSeq.app
```

The second command APFS-clones only the required Stable Audio MLX and
MuScriptor files into the unsigned application bundle. At launch VibeSeq
detects both repositories, switches Hugging Face into offline mode, and reads
the bundled cache. Mutable projects, Library assets, inference output, logs,
and the Electron profile still remain under `~/VibeSeq Data`.

The model-bundled `.app` is about 7 GB and is intended for local demonstration
and clean-machine transfer outside GitHub's normal release-asset path. Perform
model injection before code signing in a signed distribution workflow.

The builds are unsigned. Windows SmartScreen and macOS Gatekeeper may warn until
code-signing identities are configured. Do not describe an unsigned prerelease
as a production installer.

## Local packaging

With Node 24, Python 3.12, and `uv` available:

```sh
npm ci
npm run desktop:package
```

`npm run desktop:package` builds the Studio, freezes the inference sidecar,
checks both `/api/health` and the served Studio entrypoint, and then invokes
Electron Builder. Outputs are written to `release/`.

## Windows acceptance pass

On a clean Windows 11 x64 machine:

1. Verify the downloaded `.exe` against `SHA256SUMS.txt`.
2. Launch it and record any SmartScreen warning separately from application
   failures.
3. Create a project, add independent Audio and MIDI tracks, edit and play both,
   save, close, and reopen the app.
4. Install the exact model cache, generate with Stable Audio 3 Medium, extract
   with MuScriptor Medium, and confirm both provenance records and runtime
   routes match the health response.
5. Export a `.vibeseq` project, full mix, MIDI, one track, and the all-track ZIP;
   reopen the project and validate the exported files.
6. Switch away from and back to VibeSeq during playback, then repeat mute, solo,
   gain, piano-key audition, and note-selection edits.
7. Retain the exact release asset name, checksum, Windows version, hardware,
   screen recording, exported fixtures, and the desktop log from the Electron
   logs directory.
