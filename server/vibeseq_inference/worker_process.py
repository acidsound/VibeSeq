from __future__ import annotations

import sys


def isolated_worker_command(kind: str, module: str) -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, f"--vibeseq-worker={kind}"]
    return [sys.executable, "-m", module]
