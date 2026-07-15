from __future__ import annotations

import os
import re
from collections.abc import Mapping


REDACTED = "[REDACTED]"
_SECRET_SUFFIXES = (
    "_ACCESS_KEY",
    "_API_KEY",
    "_PASSWORD",
    "_SECRET",
    "_TOKEN",
)
_NAMED_SECRET = re.compile(
    r"(?i)\b(HF_TOKEN|COLAB_API_KEY)\s*[:=]\s*"
    r"(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"
)
_BEARER_TOKEN = re.compile(r"(?i)(\bbearer\s+)[^\s,;]+")
_HF_TOKEN = re.compile(r"\bhf_[A-Za-z0-9_-]{8,}\b")


def _configured_secret_values(environ: Mapping[str, str]) -> list[str]:
    values = {
        value
        for name, value in environ.items()
        if name.upper().endswith(_SECRET_SUFFIXES) and len(value) >= 8
    }
    return sorted(values, key=len, reverse=True)


def redact_secrets(
    text: str,
    environ: Mapping[str, str] | None = None,
) -> str:
    """Remove configured credentials and recognizable auth forms from text."""

    redacted = text
    source = os.environ if environ is None else environ
    for secret in _configured_secret_values(source):
        redacted = redacted.replace(secret, REDACTED)
    redacted = _NAMED_SECRET.sub(lambda match: f"{match.group(1)}={REDACTED}", redacted)
    redacted = _BEARER_TOKEN.sub(lambda match: f"{match.group(1)}{REDACTED}", redacted)
    return _HF_TOKEN.sub(REDACTED, redacted)


def safe_error_message(exc: BaseException, limit: int = 2_000) -> str:
    compact = " ".join(str(exc).split())
    message = redact_secrets(compact) or type(exc).__name__
    return message[:limit]
