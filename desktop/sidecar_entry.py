import json
import sys


def check_bundled_runtime() -> None:
    failures: dict[str, str] = {}
    try:
        from ai_edge_litert import interpreter as litert_interpreter

        if not callable(getattr(litert_interpreter, "Interpreter", None)):
            raise RuntimeError("LiteRT Interpreter is unavailable.")
    except Exception as error:
        failures["ai_edge_litert.interpreter"] = f"{type(error).__name__}: {error}"
    try:
        import sentencepiece

        if not callable(getattr(sentencepiece, "SentencePieceProcessor", None)):
            raise RuntimeError("SentencePieceProcessor is unavailable.")
    except Exception as error:
        failures["sentencepiece"] = f"{type(error).__name__}: {error}"
    try:
        import huggingface_hub

        if not callable(getattr(huggingface_hub, "hf_hub_download", None)):
            raise RuntimeError("hf_hub_download is unavailable.")
    except Exception as error:
        failures["huggingface_hub"] = f"{type(error).__name__}: {error}"

    print(json.dumps({"ok": not failures, "failures": failures}, sort_keys=True))
    if failures:
        raise SystemExit(1)


def main() -> None:
    if "--vibeseq-check-runtime" in sys.argv[1:]:
        check_bundled_runtime()
        return

    worker = next(
        (
            argument.split("=", 1)[1]
            for argument in sys.argv[1:]
            if argument.startswith("--vibeseq-worker=")
        ),
        None,
    )
    if worker is not None:
        sys.argv = [
            sys.argv[0],
            *[
                argument
                for argument in sys.argv[1:]
                if not argument.startswith("--vibeseq-worker=")
            ],
        ]
        if worker == "stable-audio-mlx":
            from vibeseq_inference.stable_audio_mlx_worker import main as worker_main
        elif worker == "stable-audio-tflite":
            from vibeseq_inference.stable_audio_tflite_worker import main as worker_main
        else:
            raise SystemExit(f"Unknown VibeSeq worker: {worker}")
        worker_main()
        return

    from vibeseq_inference.__main__ import main as server_main

    server_main()


if __name__ == "__main__":
    main()
