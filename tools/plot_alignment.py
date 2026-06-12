#!/usr/bin/env python3
"""Visualize word alignment: vocal energy envelope with word onsets marked.

Renders a time window of the vocal RMS envelope and draws a vertical line + label at
each word's scheduled start, so you can see onsets landing on the vocal energy rises.
Optionally overlays ground-truth onsets for a side-by-side accuracy view.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402


def _envelope(path: Path, hop: float = 0.005, win: float = 0.025):
    data, sr = sf.read(str(path), always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    data = np.asarray(data, dtype=np.float32)
    h = max(1, int(sr * hop))
    w = max(1, int(sr * win))
    times, vals = [], []
    for i in range(0, max(0, len(data) - w), h):
        chunk = data[i : i + w]
        vals.append(float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2))))
        times.append(i / sr)
    vals = np.asarray(vals)
    if vals.size:
        vals = vals / (vals.max() or 1.0)
    return np.asarray(times), vals


def main() -> int:
    ap = argparse.ArgumentParser(description="Plot word onsets over the vocal envelope")
    ap.add_argument("vocals", type=Path, help="vocal stem wav")
    ap.add_argument("schedule", type=Path, help="word_schedule.json")
    ap.add_argument("--truth", type=Path, help="optional ground_truth.json overlay")
    ap.add_argument("--start", type=float, default=0.0, help="window start (sec)")
    ap.add_argument("--end", type=float, default=16.0, help="window end (sec)")
    ap.add_argument("--out", type=Path, required=True, help="output PNG")
    args = ap.parse_args()

    times, vals = _envelope(args.vocals)
    sched = json.loads(args.schedule.read_text(encoding="utf-8"))
    mask = (times >= args.start) & (times <= args.end)

    fig, ax = plt.subplots(figsize=(16, 5))
    ax.fill_between(times[mask], vals[mask], color="#6c8cff", alpha=0.55, label="vocal energy")
    ax.plot(times[mask], vals[mask], color="#3a5bd9", linewidth=0.8)

    for w in sched:
        s = float(w["start"])
        if args.start <= s <= args.end:
            ax.axvline(s, color="#e63a6e", linewidth=1.4, alpha=0.9)
            ax.text(s, 1.04, str(w["word"]), rotation=45, fontsize=8,
                    ha="left", va="bottom", color="#b81e52")

    if args.truth and args.truth.exists():
        truth = json.loads(args.truth.read_text(encoding="utf-8"))
        for g in truth:
            s = float(g["start"])
            if args.start <= s <= args.end:
                ax.axvline(s, color="#1aa86a", linewidth=1.0, linestyle="--", alpha=0.7)

    aligned = ax.plot([], [], color="#e63a6e", linewidth=1.4, label="scheduled word onset")[0]
    handles = [aligned]
    if args.truth and args.truth.exists():
        handles.append(ax.plot([], [], color="#1aa86a", linestyle="--", label="true onset")[0])

    ax.set_xlim(args.start, args.end)
    ax.set_ylim(0, 1.25)
    ax.set_xlabel("time (s)")
    ax.set_ylabel("normalized vocal RMS")
    ax.set_title("Forced-aligned word onsets vs vocal energy")
    ax.legend(loc="upper right")
    fig.tight_layout()
    fig.savefig(str(args.out), dpi=110)
    print("wrote", args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
