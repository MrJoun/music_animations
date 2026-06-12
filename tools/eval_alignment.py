#!/usr/bin/env python3
"""Measure karaoke alignment accuracy against a ground-truth fixture.

Compares a word_schedule.json against a *.ground_truth.json by matching on
(lineIndex, wordIndex) and reports onset error -- the number that matters for
karaoke ("not ahead, no delay"). Positive error == highlight fires LATE (delayed),
negative == highlight fires EARLY (ahead).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def _key(entry: dict) -> tuple[int, int]:
    return (int(entry["lineIndex"]), int(entry["wordIndex"]))


def evaluate(schedule_path: Path, truth_path: Path) -> dict:
    schedule = json.loads(schedule_path.read_text(encoding="utf-8"))
    truth = json.loads(truth_path.read_text(encoding="utf-8"))

    sched_by_key = {_key(e): e for e in schedule}
    onset_err: list[float] = []
    matched = 0
    missing = 0
    for gt in truth:
        s = sched_by_key.get(_key(gt))
        if s is None:
            missing += 1
            continue
        matched += 1
        onset_err.append(float(s["start"]) - float(gt["start"]))

    if not onset_err:
        return {"matched": 0, "missing": missing, "total": len(truth)}

    arr = np.asarray(onset_err)
    abs_arr = np.abs(arr)

    def pct_within(th: float) -> float:
        return round(100.0 * float(np.mean(abs_arr <= th)), 1)

    return {
        "total_words": len(truth),
        "matched": matched,
        "missing": missing,
        "signed_mean_ms": round(float(np.mean(arr)) * 1000, 1),
        "signed_median_ms": round(float(np.median(arr)) * 1000, 1),
        "abs_mean_ms": round(float(np.mean(abs_arr)) * 1000, 1),
        "abs_median_ms": round(float(np.median(abs_arr)) * 1000, 1),
        "abs_p90_ms": round(float(np.percentile(abs_arr, 90)) * 1000, 1),
        "abs_p95_ms": round(float(np.percentile(abs_arr, 95)) * 1000, 1),
        "abs_max_ms": round(float(np.max(abs_arr)) * 1000, 1),
        "within_50ms_pct": pct_within(0.050),
        "within_80ms_pct": pct_within(0.080),
        "within_100ms_pct": pct_within(0.100),
        "within_150ms_pct": pct_within(0.150),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Evaluate word_schedule vs ground truth")
    ap.add_argument("schedule", type=Path, help="word_schedule.json")
    ap.add_argument("truth", type=Path, help="*.ground_truth.json")
    args = ap.parse_args()
    print(json.dumps(evaluate(args.schedule, args.truth), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
