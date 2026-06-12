#!/usr/bin/env python3
"""Generate a synthetic vocal track with EXACT ground-truth word timings.

Used to objectively validate karaoke alignment ("no delay / not ahead on every word").
Each lyric word is synthesized with espeak-ng, trimmed to its voiced region, and placed
on a timeline at a known time -- so we know the true onset/offset of every word and can
measure how closely the aligner recovers them.

Outputs (next to --out basename):
  <out>.vocals.wav     mono vocal-only track (the "singer")
  <out>.mix.wav        vocals + light music bed (full-mix, for the demucs path)
  <out>.mp3            44.1k stereo MP3 of the mix (load this in the browser)
  <out>.ground_truth.json   [{lineIndex, wordIndex, word, start, end}]
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 22050
INTRA_WORD_GAP = 0.07
INTER_LINE_GAP = 0.45
LEAD_SILENCE = 0.5
SILENCE_FLOOR = 0.02  # fraction of peak that counts as "voiced"


def _tokenize(text: str) -> list[str]:
    return [w.strip() for w in re.split(r"\s+", text or "") if w.strip()]


def _strip_lrc(line: str) -> str:
    return re.sub(r"\[(\d+):(\d+(?:\.\d+)?)\]", "", line).strip()


def _speakable(token: str) -> str:
    cleaned = re.sub(r"[^A-Za-z']+", " ", token).strip()
    return cleaned or "uh"


def _synth_word(token: str, tmp: Path, voice: str, wpm: int) -> np.ndarray:
    wav = tmp / "w.wav"
    subprocess.run(
        ["espeak-ng", "-v", voice, "-s", str(wpm), "-w", str(wav), _speakable(token)],
        check=True,
        capture_output=True,
    )
    data, sr = sf.read(str(wav), always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    data = np.asarray(data, dtype=np.float32)
    if sr != SR:
        # linear resample is plenty for a test fixture
        idx = np.linspace(0, len(data) - 1, int(len(data) * SR / sr))
        data = np.interp(idx, np.arange(len(data)), data).astype(np.float32)
    return _trim_silence(data)


def _trim_silence(data: np.ndarray) -> np.ndarray:
    if data.size == 0:
        return data
    peak = float(np.max(np.abs(data))) or 1.0
    mask = np.abs(data) >= peak * SILENCE_FLOOR
    if not mask.any():
        return data
    first = int(np.argmax(mask))
    last = int(len(mask) - np.argmax(mask[::-1]))
    return data[first:last]


def _music_bed(n_samples: int) -> np.ndarray:
    """Simple chord-ish pad + kick so demucs has something to separate out."""
    t = np.arange(n_samples) / SR
    bed = np.zeros(n_samples, dtype=np.float32)
    for f in (110.0, 164.81, 220.0):  # A2, E3, A3
        bed += 0.12 * np.sin(2 * np.pi * f * t).astype(np.float32)
    kick_period = int(SR * 0.5)  # 120 BPM
    env = np.zeros(n_samples, dtype=np.float32)
    for k in range(0, n_samples, kick_period):
        seg = np.arange(0, min(kick_period, n_samples - k))
        env[k : k + len(seg)] = np.exp(-seg / (SR * 0.12))
    kick = (env * np.sin(2 * np.pi * 55 * t)).astype(np.float32)
    return bed * 0.5 + kick * 0.6


def build(lyrics_path: Path, out_base: Path, voice: str, wpm: int) -> None:
    lines = [
        _strip_lrc(raw)
        for raw in lyrics_path.read_text(encoding="utf-8", errors="replace").splitlines()
    ]
    lines = [ln for ln in lines if ln]

    timeline: list[np.ndarray] = []
    ground_truth: list[dict] = []
    cursor = LEAD_SILENCE

    def add_silence(seconds: float) -> None:
        nonlocal cursor
        timeline.append(np.zeros(int(seconds * SR), dtype=np.float32))
        cursor += seconds

    add_silence(0.0)
    timeline.append(np.zeros(int(LEAD_SILENCE * SR), dtype=np.float32))

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        for li, line in enumerate(lines):
            tokens = _tokenize(line)
            for wi, token in enumerate(tokens):
                clip = _synth_word(token, tmp, voice, wpm)
                dur = len(clip) / SR
                start = cursor
                end = start + dur
                ground_truth.append(
                    {
                        "lineIndex": li,
                        "wordIndex": wi,
                        "word": token,
                        "start": round(start, 3),
                        "end": round(end, 3),
                    }
                )
                timeline.append(clip)
                cursor = end
                if wi < len(tokens) - 1:
                    add_silence(INTRA_WORD_GAP)
            add_silence(INTER_LINE_GAP)

    vocals = np.concatenate(timeline) if timeline else np.zeros(SR, dtype=np.float32)
    vocals = vocals / (np.max(np.abs(vocals)) or 1.0) * 0.9

    out_base.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_base.with_suffix(".vocals.wav")), vocals, SR)

    bed = _music_bed(len(vocals))
    mix = vocals * 0.85 + bed * 0.45
    mix = mix / (np.max(np.abs(mix)) or 1.0) * 0.95
    sf.write(str(out_base.with_suffix(".mix.wav")), mix, SR)

    (out_base.with_suffix(".ground_truth.json")).write_text(
        json.dumps(ground_truth, indent=2), encoding="utf-8"
    )

    # 44.1k stereo MP3 for the browser demo
    mp3 = out_base.with_suffix(".mp3")
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", str(out_base.with_suffix(".mix.wav")),
            "-ar", "44100", "-ac", "2", "-b:a", "192k", str(mp3),
        ],
        check=True,
    )

    print(
        json.dumps(
            {
                "words": len(ground_truth),
                "lines": len(lines),
                "duration_sec": round(len(vocals) / SR, 2),
                "vocals": str(out_base.with_suffix(".vocals.wav")),
                "mix": str(out_base.with_suffix(".mix.wav")),
                "mp3": str(mp3),
                "ground_truth": str(out_base.with_suffix(".ground_truth.json")),
            },
            indent=2,
        )
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Synthesize a ground-truth karaoke fixture")
    ap.add_argument("lyrics", type=Path, help="Lyrics file (.lrc or plain .txt)")
    ap.add_argument("--out", type=Path, required=True, help="Output basename (no extension)")
    ap.add_argument("--voice", default="en-us+f3", help="espeak-ng voice")
    ap.add_argument("--wpm", type=int, default=150, help="espeak-ng words-per-minute")
    args = ap.parse_args()
    build(args.lyrics, args.out, args.voice, args.wpm)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
