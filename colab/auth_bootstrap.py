from __future__ import annotations

import os
from collections.abc import Callable, MutableMapping
from typing import Optional


SecretReader = Callable[[str], Optional[str]]


def _read_colab_secret(name: str) -> str | None:
    from google.colab import userdata

    return userdata.get(name)


def load_hf_token_from_colab_secrets(
    environ: MutableMapping[str, str] | None = None,
    secret_reader: SecretReader | None = None,
) -> bool:
    """Load HF_TOKEN without displaying it, preferring an existing environment."""

    target = os.environ if environ is None else environ
    if target.get("HF_TOKEN", "").strip():
        return True

    reader = _read_colab_secret if secret_reader is None else secret_reader
    try:
        token = reader("HF_TOKEN")
    except (ImportError, KeyError, RuntimeError):
        return False
    except Exception:
        # Colab uses environment-specific exception classes for missing or denied
        # notebook secrets. Authentication can still continue interactively.
        return False

    if not isinstance(token, str) or not token.strip():
        return False
    target["HF_TOKEN"] = token.strip()
    return True
