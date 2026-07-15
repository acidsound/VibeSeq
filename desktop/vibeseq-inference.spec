from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules


project_root = Path(SPECPATH).parent
hidden_imports = sorted(
    set(
        ["vibeseq_inference.app"]
        + collect_submodules("uvicorn")
    )
)

analysis = Analysis(
    [str(project_root / "desktop" / "sidecar_entry.py")],
    pathex=[str(project_root / "server")],
    binaries=[],
    datas=[],
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "ai_edge_litert",
        "flash_attn",
        "mlx",
        "muscriptor",
        "pytest",
        "stable_audio_3",
        "torch",
        "torchaudio",
        "transformers",
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
