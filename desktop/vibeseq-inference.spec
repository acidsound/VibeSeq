from importlib.util import find_spec
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules


project_root = Path(SPECPATH).parent
litert_datas, litert_binaries, litert_hidden_imports = collect_all("ai_edge_litert")
sentencepiece_datas, sentencepiece_binaries, sentencepiece_hidden_imports = collect_all(
    "sentencepiece"
)
hidden_imports = sorted(
    set(
        [
            "vibeseq_inference.app",
            "vibeseq_inference.stable_audio_mlx_worker",
            "vibeseq_inference.stable_audio_tflite_worker",
            "huggingface_hub",
        ]
        + litert_hidden_imports
        + sentencepiece_hidden_imports
        + collect_submodules("uvicorn")
        + collect_submodules("mlx")
    )
)

bundled_runtime = project_root / "desktop-out" / "model-runtime-source"
if not bundled_runtime.is_dir():
    raise RuntimeError("Run npm run desktop:model-runtime before PyInstaller.")

mlx_spec = find_spec("mlx")
mlx_root = (
    Path(next(iter(mlx_spec.submodule_search_locations)))
    if mlx_spec is not None and mlx_spec.submodule_search_locations
    else None
)
mlx_binaries = []
mlx_datas = []
if mlx_root is not None:
    jaccl = mlx_root / "lib" / "libjaccl.dylib"
    metallib = mlx_root / "lib" / "mlx.metallib"
    if jaccl.is_file():
        mlx_binaries.append((str(jaccl), "."))
    if metallib.is_file():
        # PyInstaller relocates libmlx.dylib to the frozen bundle root. MLX
        # resolves its default Metal library beside that relocated binary.
        mlx_datas.append((str(metallib), "."))

analysis = Analysis(
    [str(project_root / "desktop" / "sidecar_entry.py")],
    pathex=[str(project_root / "server")],
    binaries=[*mlx_binaries, *litert_binaries, *sentencepiece_binaries],
    datas=[
        (str(bundled_runtime), "stable-audio-3-runtime"),
        *mlx_datas,
        *litert_datas,
        *sentencepiece_datas,
    ],
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "flash_attn",
        "pytest",
    ],
    noarchive=False,
    optimize=0,
)
python_archive = PYZ(analysis.pure)

executable = EXE(
    python_archive,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="vibeseq-inference",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

bundle = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="vibeseq-inference",
)
