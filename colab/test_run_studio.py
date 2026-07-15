from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from auth_bootstrap import load_hf_token_from_colab_secrets
from run_studio import (
    MODEL_SIZE,
    DetectedGpu,
    GpuTarget,
    ModelPins,
    gpu_info,
    inference_environment,
    load_model_pins,
    main,
    validate_gpu_target,
)
from vibeseq_inference.config import Settings
from vibeseq_inference.devices import HardwareProbe
from vibeseq_inference.readiness import (
    generation_capability,
    transcription_capability,
)


class ColabTargetTest(unittest.TestCase):
    def test_gpu_info_reads_compute_capability(self) -> None:
        with (
            patch("run_studio.shutil.which", return_value="/usr/bin/nvidia-smi"),
            patch(
                "run_studio.subprocess.run",
                return_value=SimpleNamespace(stdout="Tesla T4, 7.5\n"),
            ) as run,
        ):
            self.assertEqual(gpu_info(), DetectedGpu("Tesla T4", (7, 5)))
        self.assertIn("--query-gpu=name,compute_cap", run.call_args.args[0])

    def test_existing_hf_token_takes_precedence(self) -> None:
        environment = {"HF_TOKEN": "existing-test-token"}

        def unexpected_reader(_name: str) -> str:
            self.fail("Colab Secrets must not override an existing environment")

        self.assertTrue(
            load_hf_token_from_colab_secrets(environment, unexpected_reader)
        )
        self.assertEqual(environment["HF_TOKEN"], "existing-test-token")

    def test_hf_token_loads_from_colab_secrets_without_output(self) -> None:
        environment: dict[str, str] = {}
        requested: list[str] = []

        def reader(name: str) -> str:
            requested.append(name)
            return "colab-test-token"

        self.assertTrue(load_hf_token_from_colab_secrets(environment, reader))
        self.assertEqual(requested, ["HF_TOKEN"])
        self.assertEqual(environment["HF_TOKEN"], "colab-test-token")

    def test_missing_colab_secret_preserves_interactive_fallback(self) -> None:
        environment: dict[str, str] = {}

        def missing(_name: str) -> str:
            raise KeyError("missing")

        self.assertFalse(load_hf_token_from_colab_secrets(environment, missing))
        self.assertNotIn("HF_TOKEN", environment)

    def test_t4_selects_medium_sdpa_provisional_route(self) -> None:
        self.assertEqual(
            validate_gpu_target(DetectedGpu("Tesla T4", (7, 5)), False),
            GpuTarget(
                target="colab-t4",
                route="cuda-t4-sdpa",
                runtime="pytorch-sdpa",
                provisional=True,
            ),
        )
        with self.assertRaisesRegex(RuntimeError, "must report compute capability 7.5"):
            validate_gpu_target(DetectedGpu("Tesla T4", (8, 0)), False)

    def test_compatible_cuda_uses_ampere_fa2_plan(self) -> None:
        self.assertEqual(
            validate_gpu_target(DetectedGpu("NVIDIA A100-SXM4-40GB", (8, 0)), True),
            GpuTarget(
                target="colab-cuda",
                route="cuda-ampere-fa2",
                runtime="pytorch-fa2",
                provisional=False,
            ),
        )
        with self.assertRaisesRegex(RuntimeError, "--allow-other-cuda"):
            validate_gpu_target(DetectedGpu("NVIDIA A100-SXM4-40GB", (8, 0)), False)
        with self.assertRaisesRegex(RuntimeError, "compute capability 8.0"):
            validate_gpu_target(DetectedGpu("NVIDIA V100", (7, 0)), True)

    def test_environment_forces_medium_without_touching_hf_token(self) -> None:
        plan = validate_gpu_target(DetectedGpu("Tesla T4", (7, 5)), False)
        environment = inference_environment(
            {
                "HF_TOKEN": "private-test-token",
                "VIBESEQ_GENERATION_PROVIDER": "procedural-demo",
                "VIBESEQ_TRANSCRIPTION_PROVIDER": "signal-demo",
                "VIBESEQ_STABLE_AUDIO_MODEL": "small-music",
                "VIBESEQ_MUSCRIPTOR_MODEL": "small",
            },
            plan,
            enable_provisional_t4=False,
        )
        self.assertEqual(environment["HF_TOKEN"], "private-test-token")
        self.assertEqual(environment["VIBESEQ_GENERATION_PROVIDER"], "stable-audio-3")
        self.assertEqual(environment["VIBESEQ_TRANSCRIPTION_PROVIDER"], "muscriptor")
        self.assertEqual(environment["VIBESEQ_STABLE_AUDIO_MODEL"], "medium")
        self.assertEqual(environment["VIBESEQ_MUSCRIPTOR_MODEL"], "medium")
        self.assertEqual(environment["VIBESEQ_ENABLE_PROVISIONAL_T4"], "0")

    def test_t4_execution_requires_explicit_provisional_opt_in(self) -> None:
        environment = inference_environment(
            {},
            validate_gpu_target(DetectedGpu("Tesla T4", (7, 5)), False),
            enable_provisional_t4=True,
        )
        self.assertEqual(environment["VIBESEQ_ENABLE_PROVISIONAL_T4"], "1")

    def test_t4_health_contract_is_medium_only_and_opt_in_gated(self) -> None:
        probe = HardwareProbe("Linux", "x86_64", True, (7, 5), "Tesla T4", False)
        with tempfile.TemporaryDirectory() as data_dir:
            common = {
                "data_dir": Path(data_dir),
                "target": "colab-t4",
                "generation_provider": "stable-audio-3",
                "transcription_provider": "muscriptor",
            }
            disabled = Settings(**common).validate()
            enabled = Settings(**common, enable_provisional_t4=True).validate()
            with (
                patch(
                    "vibeseq_inference.readiness.module_installed",
                    return_value=True,
                ),
                patch(
                    "vibeseq_inference.readiness.cached_files",
                    return_value=(True, ()),
                ),
            ):
                disabled_generation = generation_capability(disabled, probe=probe)
                enabled_generation = generation_capability(enabled, probe=probe)
                transcription = transcription_capability(enabled, probe=probe)

        self.assertEqual(disabled_generation["route"], "cuda-t4-sdpa")
        self.assertEqual(disabled_generation["model"], "medium")
        self.assertFalse(disabled_generation["executionEnabled"])
        self.assertFalse(disabled_generation["ready"])
        self.assertEqual(enabled_generation["routePriority"], ["cuda-t4-sdpa"])
        self.assertEqual(enabled_generation["runtime"], "pytorch-sdpa")
        self.assertTrue(enabled_generation["executionEnabled"])
        self.assertTrue(enabled_generation["provisional"])
        self.assertTrue(enabled_generation["ready"])
        self.assertEqual(transcription["provider"], "muscriptor")
        self.assertEqual(transcription["model"], "medium")
        self.assertEqual(transcription["route"], "cuda-pytorch")
        self.assertEqual(transcription["runtime"], "pytorch-cuda")
        self.assertTrue(transcription["ready"])

    def test_launcher_uses_frozen_lock_and_never_prints_token(self) -> None:
        calls: list[tuple[list[str], Path, dict[str, str] | None]] = []

        def record_run(
            command: list[str],
            cwd: Path,
            env: dict[str, str] | None = None,
        ) -> None:
            calls.append((command, cwd, env))

        pins = ModelPins(
            stable_id="stabilityai/stable-audio-3-medium",
            stable_revision="stable-revision",
            stable_code_revision="stable-code-revision",
            muscriptor_id="MuScriptor/muscriptor-medium",
            muscriptor_revision="muscriptor-revision",
            muscriptor_code_revision="muscriptor-code-revision",
        )
        secret = "private-token-value-that-must-not-be-printed"
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            (repo / "server").mkdir()
            (repo / "server" / "pyproject.toml").write_text("[project]\n")
            (repo / "package.json").write_text("{}\n")
            (repo / "dist").mkdir()
            (repo / "dist" / "index.html").write_text("<!doctype html>\n")
            output = io.StringIO()
            with (
                patch.object(
                    sys,
                    "argv",
                    ["run_studio.py", "--repo", str(repo), "--skip-build"],
                ),
                patch(
                    "run_studio.gpu_info", return_value=DetectedGpu("Tesla T4", (7, 5))
                ),
                patch("run_studio.load_model_pins", return_value=pins),
                patch("run_studio.shutil.which", return_value="/usr/bin/uv"),
                patch("run_studio.run", side_effect=record_run),
                patch.dict(os.environ, {"HF_TOKEN": secret}),
                redirect_stdout(output),
            ):
                main()

        self.assertEqual(calls[0][0][:3], ["uv", "sync", "--frozen"])
        self.assertEqual(calls[-1][0][:3], ["uv", "run", "--frozen"])
        self.assertEqual(calls[-1][2]["HF_TOKEN"], secret)
        self.assertEqual(calls[-1][2]["VIBESEQ_TARGET"], "colab-t4")
        self.assertEqual(calls[-1][2]["VIBESEQ_STABLE_AUDIO_MODEL"], "medium")
        self.assertNotIn(secret, output.getvalue())

    def test_exact_medium_revisions_are_pinned(self) -> None:
        pins = load_model_pins(Path(__file__).resolve().parents[1] / "server")
        self.assertEqual(MODEL_SIZE, "medium")
        self.assertEqual(pins.stable_id, "stabilityai/stable-audio-3-medium")
        self.assertEqual(
            pins.stable_revision,
            "27b5a21b791b1b033d193a9e1e3ce78493f102f9",
        )
        self.assertEqual(
            pins.stable_code_revision,
            "b32763cf3b71c160f10a0daa4fa0e0d471b5772e",
        )
        self.assertEqual(pins.muscriptor_id, "MuScriptor/muscriptor-medium")
        self.assertEqual(
            pins.muscriptor_revision,
            "f32236969308476e01fd3aae67357de5feb05a2d",
        )
        self.assertEqual(
            pins.muscriptor_code_revision,
            "6c1460cc75e5f120948de7656da05b2c489e8715",
        )

    def test_notebook_launches_nonblocking_studio_and_exposes_colab_proxy(self) -> None:
        notebook_path = Path(__file__).with_name("VibeSeq_T4.ipynb")
        notebook = json.loads(notebook_path.read_text(encoding="utf-8"))
        self.assertEqual(notebook["nbformat"], 4)
        self.assertEqual(notebook["metadata"]["accelerator"], "GPU")

        code = "\n".join(
            "".join(cell.get("source", []))
            for cell in notebook["cells"]
            if cell["cell_type"] == "code"
        )
        compile(code, str(notebook_path), "exec")
        self.assertIn("load_hf_token_from_colab_secrets", code)
        self.assertRegex(code, r'\["uv", "sync", "--frozen",')
        self.assertNotIn("subprocess.check_call(launch)", code)
        self.assertIn("subprocess.Popen(", code)
        self.assertIn("/api/health", code)
        self.assertIn('"download"', code)
        self.assertIn('bootstrap["revision"]', code)
        self.assertIn('*bootstrap["files"]', code)
        self.assertIn("output.serve_kernel_port_as_window(PORT)", code)
        self.assertNotRegex(code, r"""["']\.env(?:["']|/)""")
        self.assertNotRegex(code, r"\bhf_[A-Za-z0-9_-]{8,}\b")

        ignore_rules = notebook_path.parent.parent.joinpath(".gitignore").read_text(
            encoding="utf-8"
        )
        self.assertIn(".vibeseq-colab-data/", ignore_rules)
        self.assertIn(".vibeseq-colab.log", ignore_rules)


if __name__ == "__main__":
    unittest.main()
