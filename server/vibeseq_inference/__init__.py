"""VibeSeq local inference service."""

__version__ = "0.1.0"


def create_app(*args, **kwargs):
    from .app import create_app as factory

    return factory(*args, **kwargs)


__all__ = ["create_app"]
