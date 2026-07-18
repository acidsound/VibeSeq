# Desktop release target

Status: unsigned prerelease packaging for native Windows and Apple Silicon
validation.

## Artifacts

A tag matching `v*` runs `.github/workflows/desktop-release.yml` and publishes a
GitHub prerelease containing:

- `VibeSeq-<version>-Windows-x64-Setup.exe`: assisted Windows installer.
- `VibeSeq-<version>-macOS-arm64.dmg`: Apple Silicon disk image.
- `VibeSeq-<version>-macOS-arm64.zip`: Apple Silicon application archive.
- `SHA256SUMS.txt`: release-asset checksums.

The builds embed the production Studio bundle and a frozen Python inference
sidecar. Node.js, Python, `uv`, and a separate web server do not need to be
preinstalled on the target machine. On supported Windows NVIDIA hardware, the
app downloads its own digest-pinned `uv` executable and managed Python into
`VibeSeq Data/runtimes`; it never installs into or modifies a system Python.
The Electron renderer has no Node integration, uses context
isolation and the Chromium sandbox, and can navigate only within its randomly
allocated loopback origin.

Every desktop release runs the frozen sidecar with `--vibeseq-check-runtime`
before packaging succeeds. This imports the native LiteRT interpreter,
SentencePiece, and Hugging Face Hub from the bundle itself, so a clean target
machine never needs to install those packages into a system Python environment.

## Storage root

VibeSeq keeps large and durable data out of opaque operating-system caches.
Windows creates `VibeSeq Data` beside the installed `VibeSeq.exe`; the assisted
installer defaults to a current-user, writable installation. The macOS
application uses `~/VibeSeq Data`. `VIBESEQ_HOME` overrides either default for
an external drive or another user-selected location.

The root contains `models`, `runtimes`, `projects`, `library`, `inference`,
`cache`, `logs`, and `profile`. The Electron profile (including IndexedDB),
model downloads, inference artifacts, and runtime caches therefore move as one
unit. The macOS application bundle itself is never modified.

## Model installation

The desktop sidecar freezes the real medium-model dependencies and pinned
Stable Audio execution source. It defaults to Stable Audio 3 Medium and
MuScriptor Medium; demo providers are never substituted silently.

Desktop packages never embed model weights. On every launch, VibeSeq checks the
exact Stable Audio files required by the current hardware route. If
`VibeSeq Data` is new, empty, partially downloaded, or missing any required
file, the Inference readiness panel opens the built-in installer. Interrupted
assets resume with HTTP Range requests; every release part and final model file
must pass its pinned SHA-256 before activation.

Stable Audio distribution is split by operating system so no machine downloads
an unusable runtime format:

- `stable-audio-3-c2949a-macos-arm64`: MLX Medium weights for Apple Silicon,
  approximately 5.18 GB.
- `stable-audio-3-c2949a-windows-x64`: TFLite Medium weights for Windows CPU,
  approximately 2.58 GB.
- `stabilityai/stable-audio-3-medium@27b5a21`: gated PyTorch Medium weights for
  supported Windows NVIDIA GPUs, approximately 10.44 GB.

CPU-only Windows selects the public TFLite route directly. When VibeSeq detects
an Ampere-or-newer NVIDIA GPU, it instead requires the CUDA/FlashAttention 2
route and does not silently fall back to CPU. The installer provisions an
isolated managed Python 3.12 environment, official PyTorch 2.7.1 CUDA 12.6
wheels, and the community Windows FlashAttention 2.8.3 wheel pinned by URL and
SHA-256 in `desktop/cuda-runtime/uv.lock`. The runtime is activated only after
an actual FlashAttention kernel succeeds on the detected GPU. Neither route
substitutes a smaller model.

The GPU checkpoint remains gated. The user accepts access on Hugging Face and
pastes a read token for that download; VibeSeq sends it only to Hugging Face and
does not save it to disk or logs. The installed environment contains a copied
VibeSeq inference package rather than an editable link to the application
folder. Its project digest is rechecked after an app update, and its virtual
environment paths are repaired when the installation and adjacent
`VibeSeq Data` directory are moved together.

The public MLX and TFLite bundles are fixed GitHub Releases rather than `latest`
aliases; the gated PyTorch files come from an exact Hugging Face commit. The app
bundles immutable manifests containing file names, sizes, and digests. The user
must accept the Stability AI Community License and Gemma Terms before the
download starts; copies of both terms and the required notice are installed
beside the model snapshot.

- Stable Audio 3 Medium optimized:
  <https://huggingface.co/stabilityai/stable-audio-3-optimized>
- Stable Audio 3 Medium PyTorch:
  <https://huggingface.co/stabilityai/stable-audio-3-medium>
- MuScriptor Medium:
  <https://huggingface.co/MuScriptor/muscriptor-medium>

The installer writes the exact Hugging Face repository snapshot layout beneath
the path shown by the application, so the inference process can run offline
after installation. The default cache roots are:

- macOS: `~/VibeSeq Data/models/huggingface/hub`
- Windows: `VibeSeq Data/models/huggingface/hub` beside the installed
  `VibeSeq.exe`

MuScriptor remains gated. Each user must sign in on its official model page,
complete the access form, and accept the model conditions. The Inference
readiness panel then links directly to the pinned `config.json` and
`model.safetensors`. **SAVE CACHE UNDER** opens the exact pinned snapshot in
Finder or File Explorer. The user places both downloaded files directly in that
folder, then **Verify files in cache** checks their names, sizes, MuScriptor
config, and safetensors structure. VibeSeq does not download, select, or move
these gated files, ask for or store a Hugging Face token, redistribute the
weights, or bypass the gate. A failed verification tells the user to check the
two files under the displayed cache path and try again.

The cache path shown after **SAVE CACHE UNDER** is clickable in desktop builds.
For MuScriptor it is the exact revision snapshot; VibeSeq creates the directory
if needed and opens it in Finder or File Explorer.

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

Windows uses an assisted NSIS installer rather than a portable self-extracting
executable. The installer owns extraction progress for the large bundled local
runtime and defaults to a writable current-user installation; elevation from
the installer is disabled so `VibeSeq Data` can remain beside `VibeSeq.exe`.
After installation, the application opens its startup window before preparing
durable folders or launching the inference sidecar. That window shows the active
startup stage and elapsed engine-wait time until Studio is ready.

## Windows acceptance pass

On a clean Windows 11 x64 machine:

1. Verify the downloaded `*-Setup.exe` against `SHA256SUMS.txt`.
2. Run the assisted installer and record any SmartScreen warning separately
   from installation or application failures.
3. Confirm `VibeSeq Data` is created beside the installed `VibeSeq.exe`, not in
   the user home or an opaque operating-system data directory.
4. Confirm the startup window appears before the local engine is ready and
   advances through Local data, Audio engine, Health check, and Studio.
5. Create a project, add independent Audio and MIDI tracks, edit and play both,
   save, close, and reopen the app.
6. On CPU-only Windows, start with an absent or empty `VibeSeq Data`, accept the
   displayed model terms, install the Windows TFLite files, and confirm the
   `cpu-tflite` route generates with Stable Audio 3 Medium.
7. On Ampere-or-newer NVIDIA Windows, accept gated model access, provide a
   read-only Hugging Face token, and confirm the installer reports the managed
   CUDA runtime, FlashAttention kernel check, and exact PyTorch model download.
   Confirm health and generation both report `cuda-ampere-fa2`, never
   `cpu-tflite`.
8. Export a `.vibeseq` project, full mix, MIDI, one track, and the all-track ZIP;
   reopen the project and validate the exported files.
9. Switch away from and back to VibeSeq during playback, then repeat mute, solo,
   gain, piano-key audition, and note-selection edits.
10. Retain the exact release asset name, checksum, Windows version, hardware,
   screen recording, exported fixtures, and the desktop log from the Electron
   logs directory.
