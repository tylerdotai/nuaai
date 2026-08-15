#!/usr/bin/env python3
"""Local NUAAI voice bridge backed by the existing Faster-Whisper/Kokoro stack."""

from __future__ import annotations

import argparse
import json
import sys
import wave
from pathlib import Path


def transcribe(args: argparse.Namespace) -> None:
    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    segments, info = model.transcribe(
        str(Path(args.input).resolve()),
        beam_size=5,
        vad_filter=True,
    )
    captured = []
    text_parts = []
    for segment in segments:
        text = segment.text.strip()
        if text:
            text_parts.append(text)
        captured.append(
            {
                "start": float(segment.start),
                "end": float(segment.end),
                "text": text,
            }
        )
    print(
        json.dumps(
            {
                "text": " ".join(text_parts).strip(),
                "language": getattr(info, "language", None),
                "segments": captured,
            },
            ensure_ascii=False,
        )
    )


def synthesize(args: argparse.Namespace) -> None:
    import numpy as np
    from kokoro_onnx import Kokoro

    model = Kokoro(args.kokoro_model, args.kokoro_voices)
    samples, sample_rate = model.create(args.text, voice=args.voice, speed=1.0)
    audio = np.asarray(samples, dtype=np.float32)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16)
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(output), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(sample_rate))
        handle.writeframes(pcm.tobytes())
    print(json.dumps({"path": str(output), "mimeType": "audio/wav"}))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="NUAAI local voice bridge")
    commands = parser.add_subparsers(dest="command", required=True)

    transcribe_parser = commands.add_parser("transcribe")
    transcribe_parser.add_argument("--input", required=True)
    transcribe_parser.add_argument("--model", required=True)
    transcribe_parser.add_argument("--device", required=True)
    transcribe_parser.add_argument("--compute-type", required=True)
    transcribe_parser.set_defaults(handler=transcribe)

    synthesize_parser = commands.add_parser("synthesize")
    synthesize_parser.add_argument("--text", required=True)
    synthesize_parser.add_argument("--output", required=True)
    synthesize_parser.add_argument("--voice", required=True)
    synthesize_parser.add_argument("--kokoro-model", required=True)
    synthesize_parser.add_argument("--kokoro-voices", required=True)
    synthesize_parser.set_defaults(handler=synthesize)
    return parser


def main() -> int:
    try:
        args = build_parser().parse_args()
        args.handler(args)
        return 0
    except Exception as error:
        print(f"voice bridge failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
