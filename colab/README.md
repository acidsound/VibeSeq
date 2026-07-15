# Colab Studio target

This target builds the complete Vite Studio and serves its static output and the
FastAPI inference routes from one origin. It is intentionally separate from the
desktop local target.

## Model contract

Colab uses medium models only. The launcher overwrites inherited small-model
values with `medium`; it never downgrades to `small-music`, `small`, or a demo
provider after a real-provider failure. Runtime pin output is read directly from
`server/vibeseq_inference/model_manifest.py`, not maintained as a second source.

- Stable Audio 3 weights:
  `stabilityai/stable-audio-3-medium@27b5a21b791b1b033d193a9e1e3ce78493f102f9`
- Stable Audio 3 code:
  `Stability-AI/stable-audio-3@b32763cf3b71c160f10a0daa4fa0e0d471b5772e`
- MuScriptor weights:
  `MuScriptor/muscriptor-medium@f32236969308476e01fd3aae67357de5feb05a2d`
- MuScriptor code:
  `muscriptor/muscriptor@6c1460cc75e5f120948de7656da05b2c489e8715`

Accept both gated repositories before starting:

- <https://huggingface.co/stabilityai/stable-audio-3-medium>
- <https://huggingface.co/MuScriptor/muscriptor-medium>

MuScriptor medium weights are licensed CC BY-NC 4.0. Confirm that restriction
is compatible with the intended use before treating this target as deployable.

## Authentication and start

Choose a T4 GPU runtime and place the repository in the notebook working
directory. Add `HF_TOKEN` in the Colab Secrets panel and grant the notebook
access; do not upload a local `.env` file. The notebook uses interactive Hugging
Face login only when the process environment and Colab Secrets are both absent.
The token is never printed.

```sh
python -m pip install uv
uv sync --frozen --project server --extra models
python colab/run_studio.py --repo .
```

The notebook starts the server in the background, reads the exact file manifests
from `/api/health`, downloads only those pinned Stable Audio and MuScriptor
files, refreshes health, prints only a credential-free capability summary, and
opens the complete Studio through Colab's authenticated kernel-port proxy. Its
log remains in `.vibeseq-colab.log`; do not publish that runtime file. The
default command leaves real Stable Audio execution on T4 disabled. `/api/health`
reports route
`cuda-t4-sdpa`, runtime
`pytorch-sdpa`, `provisional=true`, `executionEnabled=false`, and `ready=false`.
This preserves access to the Studio and explicit demo fixtures without claiming
that unverified medium generation works.

To run the provisional medium path intentionally:

```sh
python colab/run_studio.py --repo . --enable-provisional-t4
```

This sets `VIBESEQ_ENABLE_PROVISIONAL_T4=1`; it does not certify production
readiness. Standard FlashAttention 2 does not support Turing, so this path uses
the upstream SDPA/chunked fallback. No real T4 generation or endurance evidence
has been recorded in this repository yet.

For an intentional Ampere-or-newer CUDA runtime, use:

```sh
python colab/run_studio.py --repo . --allow-other-cuda
```

That target selects `cuda-ampere-fa2`. Health remains not ready if FlashAttention
2, exact weights, or another required runtime component is missing.

## Verification gate

Inspect health from another shell or notebook process while the server runs:

```sh
curl -s http://127.0.0.1:8000/api/health | python -m json.tool
```

Do not call the T4 target operationally ready until the generation capability
shows all of the following for the exact revisions above:

- `provider=stable-audio-3`, `model=medium`, route `cuda-t4-sdpa`, and runtime
  `pytorch-sdpa`;
- `packageInstalled=true`, `weightsCached=true`, `accessGranted=true`,
  `runtimeCompatible=true`, and `executionEnabled=true`;
- `provisional=true` remains visible; no small or demo substitution occurred;
- a real generated WAV completes, plays in the Studio, persists after restart,
  and exports without an OOM or corrupted output;
- repeated representative-duration runs establish latency and memory headroom.

Until that evidence exists, the route is provisional rather than production
ready even if one health response reports `ready=true`.

After the notebook has started the background Studio with
`ENABLE_PROVISIONAL_T4 = True`, the target-aware browser contract can be run
against the same-origin server without starting local demo fixtures:

```sh
npx playwright install --with-deps chromium
VIBESEQ_E2E_BASE_URL=http://127.0.0.1:8000 \
VIBESEQ_REAL_MEDIUM_E2E=1 \
VIBESEQ_REAL_MEDIUM_TARGET=colab-t4 \
npx playwright test e2e/real-medium.spec.ts --repeat-each=3
```

Passing this contract records real generation/extraction provenance, edit and
reload behavior, WAV/MIDI validators, screenshots, and three independent
outputs. It does not by itself prove a real T4-to-desktop project-bundle round
trip, latency percentiles, memory headroom, or endurance requirements.

Colab runtime storage is ephemeral. Notebook termination, idle timeout, or
resource revocation can remove the server-side assets and journal without
notice. Before ending a session, open **Project → Export project bundle** and
save the resulting `.vibeseq` file outside the runtime. The bundle contains the
arrangement, project and inference job state, unplaced candidates, and encoded
source media. On desktop, use **Project → Import project bundle**. The desktop
Studio validates the project schema and every embedded media hash before the
import is committed; a rejected or damaged bundle leaves the current project
open. WAV and MIDI exports remain useful rendered outputs but cannot restore an
editable Studio session.

The transfer UI and fixture-browser round trip are automated, but no actual T4
runtime bundle has yet been exported and reopened on desktop. That real-target
evidence remains part of the Colab production gate.

`COLAB_API_KEY` is not consumed by this manual notebook target. Colab Enterprise
API automation is a separate deployment concern and uses Google Application
Default Credentials, not a repository API-key variable.
