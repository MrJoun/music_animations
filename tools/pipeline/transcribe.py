"""faster-whisper transcription on vocal stem."""

from __future__ import annotations

import json
from pathlib import Path

from faster_whisper import WhisperModel


def transcribe_vocals(
    vocals_path: Path,
    *,
    model_size: str = "base.en",
    device: str = "cpu",
    compute_type: str | None = None,
) -> list[dict]:
    if compute_type is None:
        compute_type = "float16" if device == "cuda" else "int8"

    model = WhisperModel(model_size, device=device, compute_type=compute_type)
    segments, _info = model.transcribe(
        str(vocals_path),
        word_timestamps=True,
        without_timestamps=False,
        condition_on_previous_text=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 250},
    )

    words: list[dict] = []
    for segment in segments:
        if segment.words:
            for w in segment.words:
                text = (w.word or "").strip()
                if not text:
                    continue
                words.append(
                    {
                        "word": text,
                        "start": round(float(w.start), 3),
                        "end": round(float(w.end), 3),
                    }
                )
        else:
            text = (segment.text or "").strip()
            if text:
                words.append(
                    {
                        "word": text,
                        "start": round(float(segment.start), 3),
                        "end": round(float(segment.end), 3),
                    }
                )

    return words


def write_transcript(out_dir: Path, words: list[dict]) -> Path:
    path = out_dir / "transcript.json"
    path.write_text(json.dumps({"words": words}, indent=2), encoding="utf-8")
    return path
