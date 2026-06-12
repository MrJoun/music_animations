#!/usr/bin/env python3
"""Real-audio line-onset accuracy vs human LRCLIB timestamps.

There is no per-word ground truth for a real recording, but LRCLIB ships human-authored
*line-level* synced timestamps. This compares the first-word start of each line in our
forced-aligned word_schedule to the curated LRC line time -- a genuine (if line-grained
and slightly noisy) real-audio reference. Positive error = our highlight is late.

Usage:
  python tools/eval_lrc_lines.py "Artist - Title.mp3"
  python tools/eval_lrc_lines.py "Artist - Title.mp3" --schedule path/to/word_schedule.json
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

import numpy as np
import soundfile as sf

from pipeline.lyrics_fetch import fetch_lyrics, merge_meta

_LRC_RE = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]")


def _norm(text: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", (text or "").lower()).split())


def _lrc_lines(synced: str) -> list[tuple[float, str]]:
    out: list[tuple[float, str]] = []
    for raw in synced.splitlines():
        m = _LRC_RE.match(raw.strip())
        if not m:
            continue
        body = _LRC_RE.sub("", raw).strip()
        if body:
            out.append((int(m.group(1)) * 60 + float(m.group(2)), body))
    return out


def _schedule_line_starts(schedule: list[dict]) -> list[tuple[float, str]]:
    by_line: dict[int, list[dict]] = defaultdict(list)
    for w in schedule:
        by_line[int(w["lineIndex"])].append(w)
    out: list[tuple[float, str]] = []
    for li in sorted(by_line):
        words = sorted(by_line[li], key=lambda w: w["wordIndex"])
        out.append((float(words[0]["start"]), " ".join(w["word"] for w in words)))
    return out


def _match_lines(lrc, sched):
    """Pair LRC lines with schedule lines.

    The schedule is built from the same ordered lyrics as the LRC, so when the counts
    match we pair by index (correct even when choruses repeat identical lines). Otherwise
    fall back to a monotonic Needleman-Wunsch match on normalized line text.
    """
    if len(lrc) == len(sched):
        return [(lrc[i][0], sched[i][0]) for i in range(len(lrc))]

    n, m = len(lrc), len(sched)
    NEG = -1e9
    dp = [[NEG] * (m + 1) for _ in range(n + 1)]
    bt = [[0] * (m + 1) for _ in range(n + 1)]
    dp[0][0] = 0
    for i in range(1, n + 1):
        dp[i][0] = -i; bt[i][0] = 1
    for j in range(1, m + 1):
        dp[0][j] = -j; bt[0][j] = 2
    ltoks = [set(_norm(t).split()) for _, t in lrc]
    stoks = [set(_norm(t).split()) for _, t in sched]
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            a, b = ltoks[i - 1], stoks[j - 1]
            jac = len(a & b) / max(1, len(a | b))
            diag = dp[i - 1][j - 1] + (jac if jac > 0.34 else -0.5)
            up, left = dp[i - 1][j] - 1, dp[i][j - 1] - 1
            best, d = diag, 0
            if up > best: best, d = up, 1
            if left > best: best, d = left, 2
            dp[i][j], bt[i][j] = best, d
    pairs = []
    i, j = n, m
    while i > 0 and j > 0:
        if bt[i][j] == 0:
            a, b = ltoks[i - 1], stoks[j - 1]
            if len(a & b) / max(1, len(a | b)) > 0.34:
                pairs.append((lrc[i - 1][0], sched[j - 1][0]))
            i -= 1; j -= 1
        elif bt[i][j] == 1:
            i -= 1
        else:
            j -= 1
    pairs.reverse()
    return pairs


def main() -> int:
    ap = argparse.ArgumentParser(description="Line-onset accuracy vs LRCLIB")
    ap.add_argument("audio", type=Path)
    ap.add_argument("--schedule", type=Path)
    ap.add_argument("--artist")
    ap.add_argument("--title")
    args = ap.parse_args()

    sched_path = args.schedule or (
        args.audio.parent / f"{args.audio.stem}.analysis" / "word_schedule.json"
    )
    schedule = json.loads(Path(sched_path).read_text(encoding="utf-8"))

    with sf.SoundFile(str(args.audio)) as f:
        dur = len(f) / f.samplerate
    meta = merge_meta(args.audio, artist=args.artist, title=args.title)
    res = fetch_lyrics(meta, dur)
    if not res or not res.synced_lrc:
        print(json.dumps({"error": "no synced LRC from LRCLIB", "track": meta.title}))
        return 1

    lrc = _lrc_lines(res.synced_lrc)
    sched = _schedule_line_starts(schedule)
    pairs = _match_lines(lrc, sched)
    if not pairs:
        print(json.dumps({"error": "no line matches", "lrc_lines": len(lrc)}))
        return 1

    err = np.array([s - l for l, s in pairs])
    ae = np.abs(err)
    print(
        json.dumps(
            {
                "track": f"{meta.artist} - {meta.title}",
                "lrc_lines": len(lrc),
                "matched_lines": len(pairs),
                "signed_median_ms": round(float(np.median(err)) * 1000, 1),
                "abs_median_ms": round(float(np.median(ae)) * 1000, 1),
                "abs_mean_ms": round(float(np.mean(ae)) * 1000, 1),
                "abs_p90_ms": round(float(np.percentile(ae, 90)) * 1000, 1),
                "within_150ms_pct": round(100 * float(np.mean(ae <= 0.150)), 1),
                "within_300ms_pct": round(100 * float(np.mean(ae <= 0.300)), 1),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
