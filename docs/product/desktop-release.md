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

## Current validation scope

The first prerelease intentionally packages the lightweight inference runtime
and demo providers. It validates installation/launch, local persistence,
arrangement editing, playback, `.vibeseq` project transfer, and WAV/MIDI/stem
export on a clean target machine.

Stable Audio 3 Medium and MuScriptor Medium weights are not embedded. Their
model packages and heavyweight platform runtimes remain a separate release
boundary. A desktop shell smoke test is not evidence that either real model
runs on the target machine.

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
4. Generate with the labelled demo provider and run the labelled demo MIDI
   extraction path; confirm provenance never claims Stable Audio or MuScriptor.
5. Export a `.vibeseq` project, full mix, MIDI, one track, and the all-track ZIP;
   reopen the project and validate the exported files.
6. Switch away from and back to VibeSeq during playback, then repeat mute, solo,
   gain, piano-key audition, and note-selection edits.
7. Retain the exact release asset name, checksum, Windows version, hardware,
   screen recording, exported fixtures, and the desktop log from the Electron
   logs directory.
