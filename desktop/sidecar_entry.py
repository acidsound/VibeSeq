import sys


def main() -> None:
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
