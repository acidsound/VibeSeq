from __future__ import annotations

from vibeseq_inference import __main__


def test_main_uses_configured_host_and_port(monkeypatch) -> None:
    calls: list[tuple[str, dict[str, object]]] = []

    monkeypatch.setenv("VIBESEQ_HOST", "127.0.0.1")
    monkeypatch.setenv("VIBESEQ_PORT", "49321")
    monkeypatch.setattr(
        __main__.uvicorn,
        "run",
        lambda app, **options: calls.append((app, options)),
    )

    __main__.main()

    assert calls == [
        (
            "vibeseq_inference.app:app",
            {"host": "127.0.0.1", "port": 49321, "reload": False},
        )
    ]
