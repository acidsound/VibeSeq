# VibeSeq inference service

The service exposes a persistent asynchronous job API:

- `GET /api/health`
- `POST /api/generate`
- `POST /api/transcribe`
- `GET` and `DELETE /api/jobs/{id}`
- `GET /api/assets/{id}`

The default providers are deliberately named `procedural-demo` and
`signal-demo`. They provide deterministic end-to-end fixtures and never claim to
be Stable Audio 3 or MuScriptor. Selecting `stable-audio-3` or `muscriptor`
loads that model lazily. A missing package, model license acceptance, or
Hugging Face authentication fails the job explicitly; it never substitutes a
demo provider.

Install and run the fixture-capable service:

```sh
cd server
uv sync --extra dev
uv run --extra dev pytest
uv run --extra dev ruff check .
uv run --extra dev ruff format --check .
uv run uvicorn vibeseq_inference.app:app --host 127.0.0.1 --port 8787
```

Install real model adapters when their licenses are appropriate for the use
case:

```sh
cd server
uv sync --extra models
```

The repository launchers conditionally pass the root `.env` file through
Uvicorn's data-only `--env-file` parser. They do not source it as shell or
PowerShell code. Existing process variables have precedence over `.env`.
For a direct server invocation from this directory, use
`--env-file ../.env`. Credential-like values are removed from failed job errors
before those errors are persisted or returned by the API.

Real inference is medium-only. `VIBESEQ_STABLE_AUDIO_MODEL` and
`VIBESEQ_MUSCRIPTOR_MODEL` may be omitted or set to `medium`; any small-model
value is rejected. There is no automatic model-size or demo fallback.

Stable Audio runtime routes are selected explicitly:

- Apple Silicon: official MLX medium weights, then official TFLite medium CPU
  fallback. MLX is preferred; the CPU route uses the official `w8a8-dyn`
  medium DiT and SAME-L decoder and never switches to a small model.
- Ampere-or-newer CUDA: pinned PyTorch medium code and weights with
  FlashAttention 2. The Windows desktop installs official PyTorch 2.7.1 CUDA
  12.6 and a digest-pinned community FlashAttention 2.8.3 wheel into an
  isolated managed Python under `VibeSeq Data/runtimes`. It runs a real
  FlashAttention kernel before marking that route ready and never modifies a
  system Python.
- Colab T4: pinned PyTorch medium through the upstream SDPA/chunked path. This
  route is provisional and disabled unless `VIBESEQ_ENABLE_PROVISIONAL_T4=1`.
  Colab targets never silently switch to the desktop CPU fallback.
- Other CPU-only hosts: official TFLite medium weights through LiteRT/XNNPACK.
  The exact `w8a8-dyn` DiT, SAME-L decoder, and T5Gemma files are revision-pinned.
  This is a portability fallback and is expected to be materially slower than
  the supported GPU routes.

MuScriptor medium uses pinned PyTorch weights and prefers CUDA, then MPS, then
CPU. Intel macOS is excluded because the current upstream MuScriptor package
pins NumPy below 2 there while Stable Audio 3 requires NumPy 2.

Set `VIBESEQ_FORCE_CPU=1` to verify the local desktop fallback on a GPU-capable
host. It is rejected for non-local targets. With it enabled, Stable Audio is
selected as `cpu-tflite` and MuScriptor as `cpu-pytorch`; `/api/health` reports
`hardware.forceCpu=true` and only `cpu` in the selected device list. This is an
explicit test/operator choice, not an automatic remote or model-size fallback.

`GET /api/health` reports `packageInstalled`, `weightsCached`,
`accessGranted`, `runtimeCompatible`, and `ready` separately. It also includes
the exact model/code revisions, route priority, selected and fallback routes,
and a data-only bootstrap descriptor (`modelId`, `revision`, required files,
and access URL). FlashAttention-compatible NVIDIA hardware exposes only
`cuda-ampere-fa2`; a missing or failed CUDA runtime blocks generation instead
of selecting `cpu-tflite`. CPU-only hosts select `cpu-tflite` directly. Token
presence alone is not treated as proof of gated access.

The pinned production candidates are:

- Stable Audio 3 medium weights:
  `stabilityai/stable-audio-3-medium@27b5a21b791b1b033d193a9e1e3ce78493f102f9`
- Stable Audio 3 optimized MLX/TFLite weights:
  `stabilityai/stable-audio-3-optimized@c2949a435de2392fe49c5914c52bc174cfc05a9b`
- Stable Audio 3 code:
  `Stability-AI/stable-audio-3@b32763cf3b71c160f10a0daa4fa0e0d471b5772e`
- MuScriptor medium weights:
  `MuScriptor/muscriptor-medium@f32236969308476e01fd3aae67357de5feb05a2d`
- MuScriptor code:
  `muscriptor/muscriptor@6c1460cc75e5f120948de7656da05b2c489e8715`

The 2026-07-15 Apple M2 execution evidence is stored under
`artifacts/qa/2026-07-15-real-medium/` at the repository root. It includes
Stable Audio MLX and TFLite CPU runs, MuScriptor MPS and CPU runs, media
validators, and fresh provider processes completing with network access denied
after installation, plus three consecutive Apple-GPU browser workflows. Three
consecutive explicitly forced-CPU browser workflows and their timing samples
are under `artifacts/qa/2026-07-15-real-medium-cpu-browser/`. Each small timing
sample is an observation, not a p50 or p95 distribution. The actual Colab T4
run is deferred and no T4 execution evidence is included.

Stable Audio's recorded license metadata is Stability AI Community License plus
Gemma Terms of Use. MuScriptor Medium is redistributed unchanged through a
digest-pinned VibeSeq Release under CC BY-NC 4.0 after the user accepts its
upstream conditions; commercial production use remains blocked unless separate
permission is obtained.

State is stored under the platform user-data directory. Override it with
`VIBESEQ_DATA_DIR`. Other relevant environment variables are
`VIBESEQ_GENERATION_PROVIDER`, `VIBESEQ_TRANSCRIPTION_PROVIDER`,
`VIBESEQ_TARGET`, `VIBESEQ_FORCE_CPU`, and `VIBESEQ_STUDIO_DIST`.
