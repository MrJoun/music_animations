"""Vocal-envelope refinement for Whisper word timestamps and karaoke schedules."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import soundfile as sf

from .align import FILL_RATIO, INTER_WORD_GAP_SEC, MIN_WORD_SEC

MERGE_GAP_SEC = 0.02
MIN_INTER_WORD_GAP_SEC = INTER_WORD_GAP_SEC
TAIL_THRESHOLD_RATIO = 0.25
ONSET_THRESHOLD_RATIO = 0.15
SILENCE_RMS_RATIO = 0.14
FINE_HOP_SEC = 0.01
TAIL_HOLD_SAMPLES = 2
MAX_TAIL_EXTEND_SEC = 0.42
PEAK_MIN_SPACING_SEC = 0.28


class VocalEnvelope:
    """Normalized RMS envelope with fast time lookup."""

    __slots__ = ("times", "values")

    def __init__(self, times: list[float], values: list[float]) -> None:
        self.times = times
        self.values = values

    @classmethod
    def from_json(cls, envelopes: dict) -> VocalEnvelope:
        return cls(list(envelopes["times"]), list(envelopes["vocals"]))

    @classmethod
    def from_wav(cls, path: Path, *, hop_sec: float = FINE_HOP_SEC) -> VocalEnvelope:
        data, sr = sf.read(str(path), always_2d=False)
        if data.ndim > 1:
            data = data.mean(axis=1)
        samples = np.asarray(data, dtype=np.float32)
        hop = max(1, int(sr * hop_sec))
        win = max(1, int(sr * 0.05))
        times: list[float] = []
        values: list[float] = []
        for i in range(0, max(0, len(samples) - win), hop):
            chunk = samples[i : i + win]
            rms = float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2)))
            times.append(i / sr)
            values.append(rms)
        if not values:
            return cls([0.0], [0.0])
        peak = max(values) or 1.0
        values = [min(1.0, v / peak * 1.15) for v in values]
        return cls(times, values)

    def idx_at(self, t: float) -> int:
        if not self.times:
            return 0
        if t <= self.times[0]:
            return 0
        lo, hi = 0, len(self.times) - 1
        while lo < hi:
            mid = (lo + hi + 1) >> 1
            if self.times[mid] <= t:
                lo = mid
            else:
                hi = mid - 1
        return lo

    def peak_in_range(self, t0: float, t1: float) -> float:
        i0 = self.idx_at(t0)
        i1 = self.idx_at(max(t1, t0))
        if i0 > i1:
            i0, i1 = i1, i0
        chunk = self.values[i0 : i1 + 1]
        return max(chunk) if chunk else 0.0

    def extend_end(self, start: float, end: float, limit_end: float) -> float:
        whisper_end = end
        peak = self.peak_in_range(start, whisper_end)
        if peak <= 0:
            return round(end, 3)
        threshold = peak * TAIL_THRESHOLD_RATIO
        hard_limit = min(limit_end, whisper_end + MAX_TAIL_EXTEND_SEC)
        idx = self.idx_at(whisper_end)
        below = 0
        last_above = whisper_end
        while idx < len(self.values):
            t = self.times[idx]
            if t >= hard_limit:
                break
            if self.values[idx] >= threshold:
                last_above = t
                below = 0
            else:
                below += 1
                if below >= TAIL_HOLD_SAMPLES:
                    return round(max(start + MIN_WORD_SEC, last_above + FINE_HOP_SEC), 3)
            idx += 1
        return round(max(start + MIN_WORD_SEC, min(hard_limit, last_above + FINE_HOP_SEC)), 3)

    def refine_start(self, start: float, end: float, floor_start: float = 0.0) -> float:
        peak = self.peak_in_range(start, end)
        if peak <= 0:
            return round(start, 3)
        threshold = peak * ONSET_THRESHOLD_RATIO
        idx = self.idx_at(start)
        while idx > 0:
            if self.values[idx] >= threshold and self.values[idx - 1] < threshold:
                return round(max(floor_start, self.times[idx]), 3)
            idx -= 1
        return round(max(floor_start, start), 3)


def _even_slots(count: int, t0: float, t1: float) -> list[dict]:
    if count <= 0:
        return []
    gap = MIN_INTER_WORD_GAP_SEC
    total_gap = gap * max(0, count - 1)
    usable = max(MIN_WORD_SEC * count, t1 - t0 - total_gap)
    dur = usable / count
    slots: list[dict] = []
    cursor = t0
    for _ in range(count):
        slots.append({"start": round(cursor, 3), "end": round(cursor + dur, 3)})
        cursor += dur + gap
    return slots


def _inter_word_silence(env: VocalEnvelope, end: float, next_start: float, peak: float) -> bool:
    """True when RMS stays below threshold between word end and next word start."""
    if next_start - end < MIN_INTER_WORD_GAP_SEC * 0.5:
        return False
    threshold = peak * SILENCE_RMS_RATIO
    i0 = env.idx_at(end)
    i1 = env.idx_at(max(end, next_start - MIN_INTER_WORD_GAP_SEC))
    if i0 > i1:
        return True
    for idx in range(i0, i1 + 1):
        if env.values[idx] >= threshold:
            return False
    return True


def shrink_end_for_gap(
    env: VocalEnvelope,
    start: float,
    end: float,
    next_start: float,
    *,
    min_gap: float = MIN_INTER_WORD_GAP_SEC,
) -> float:
    """Trim word end at vocal decay and reserve silence before the next word."""
    hard_limit = next_start - min_gap
    end = min(end, hard_limit)
    peak = env.peak_in_range(start, max(end, start + MIN_WORD_SEC))
    if peak <= 0:
        return round(max(start + MIN_WORD_SEC, end), 3)

    if _inter_word_silence(env, end, next_start, peak):
        threshold = peak * SILENCE_RMS_RATIO
        idx_end = env.idx_at(end)
        idx_start = env.idx_at(start)
        last_voiced = start
        for idx in range(idx_end, idx_start - 1, -1):
            if env.values[idx] >= threshold:
                last_voiced = env.times[idx]
                break
        end = min(end, last_voiced + FINE_HOP_SEC, hard_limit)

    return round(max(start + MIN_WORD_SEC, end), 3)


def _local_peaks(env: VocalEnvelope, t0: float, t1: float) -> list[tuple[float, float]]:
    i0 = env.idx_at(t0)
    i1 = env.idx_at(t1)
    if i0 >= i1:
        return []
    segment = env.values[i0 : i1 + 1]
    times = env.times[i0 : i1 + 1]
    peak = max(segment) if segment else 0.0
    if peak <= 0:
        return []
    threshold = peak * 0.18
    peaks: list[tuple[float, float]] = []
    for i in range(1, len(segment) - 1):
        if segment[i] >= segment[i - 1] and segment[i] > segment[i + 1] and segment[i] >= threshold:
            peaks.append((times[i], segment[i]))
    return peaks


def _pick_spaced_peaks(peaks: list[tuple[float, float]], count: int, t0: float, t1: float) -> list[float]:
    if not peaks:
        return []
    times = sorted(p[0] for p in peaks)
    if len(times) <= count:
        return times
    chosen: list[float] = []
    for i in range(count):
        frac = i / max(count - 1, 1)
        idx = min(len(times) - 1, round(frac * (len(times) - 1)))
        t = times[idx]
        if not chosen or abs(t - chosen[-1]) >= PEAK_MIN_SPACING_SEC * 0.6:
            chosen.append(t)
    while len(chosen) < count:
        for t in times:
            if all(abs(t - c) >= PEAK_MIN_SPACING_SEC * 0.5 for c in chosen):
                chosen.append(t)
                if len(chosen) >= count:
                    break
        break
    return sorted(chosen[:count])


def find_onset_peaks(env: VocalEnvelope, t0: float, t1: float, count: int) -> list[dict]:
    """Place `count` word slots on vocal onsets/peaks inside [t0, t1]."""
    if count <= 0 or t1 <= t0 + MIN_WORD_SEC:
        return _even_slots(max(count, 0), t0, max(t1, t0 + MIN_WORD_SEC))

    peaks = _local_peaks(env, t0, t1)
    centers = _pick_spaced_peaks(peaks, count, t0, t1)

    if len(centers) < count:
        even_centers = [s["start"] + (s["end"] - s["start"]) * 0.5 for s in _even_slots(count, t0, t1)]
        for ec in even_centers:
            if len(centers) >= count:
                break
            if all(abs(ec - c) >= PEAK_MIN_SPACING_SEC * 0.5 for c in centers):
                centers.append(ec)
        centers = sorted(centers[:count])

    if not centers:
        return _even_slots(count, t0, t1)

    max_dur = max(MIN_WORD_SEC * 1.2, (t1 - t0 - MIN_INTER_WORD_GAP_SEC * max(0, count - 1)) / max(count, 1) * 1.35)
    boundaries = [t0] + centers + [t1]
    slots: list[dict] = []
    for i, center in enumerate(centers):
        seg_lo = boundaries[i]
        seg_hi = boundaries[i + 2] if i + 2 < len(boundaries) else t1
        floor = seg_lo + MERGE_GAP_SEC if i == 0 else slots[-1]["end"] + MIN_INTER_WORD_GAP_SEC
        start = env.refine_start(max(seg_lo, center - 0.12), center + 0.04, floor_start=floor)
        next_slot_start = boundaries[i + 1] if i + 1 < len(centers) else t1
        tail_limit = min(
            seg_hi - MIN_INTER_WORD_GAP_SEC,
            next_slot_start - MIN_INTER_WORD_GAP_SEC,
            start + max_dur,
            center + MAX_TAIL_EXTEND_SEC,
        )
        end = env.extend_end(start, max(center, start + MIN_WORD_SEC * 0.5), tail_limit)
        end = shrink_end_for_gap(env, start, end, min(tail_limit + MIN_INTER_WORD_GAP_SEC, next_slot_start))
        end = min(end, start + max_dur, tail_limit)
        end = max(start + MIN_WORD_SEC, end)
        slots.append({"start": round(start, 3), "end": round(end, 3)})

    if len(slots) < count:
        return _even_slots(count, t0, t1)
    return slots[:count]


def _load_envelope(envelopes: dict | None, vocals_path: Path | None) -> VocalEnvelope:
    if envelopes and envelopes.get("times") and envelopes.get("vocals"):
        return VocalEnvelope.from_json(envelopes)
    if vocals_path and vocals_path.exists():
        return VocalEnvelope.from_wav(vocals_path)
    raise ValueError("Need envelopes.json or vocals.wav for word refinement")


def _apply_fill(entry: dict, fill_ratio: float = FILL_RATIO) -> None:
    entry["start"] = round(float(entry["start"]), 3)
    entry["end"] = round(max(float(entry["start"]) + MIN_WORD_SEC, float(entry["end"])), 3)
    entry["fillEnd"] = round(entry["start"] + (entry["end"] - entry["start"]) * fill_ratio, 3)


def enforce_no_overlap(entries: list[dict]) -> None:
    for i in range(len(entries)):
        if i > 0 and float(entries[i]["start"]) < float(entries[i - 1]["end"]) + MIN_INTER_WORD_GAP_SEC:
            entries[i]["start"] = round(float(entries[i - 1]["end"]) + MIN_INTER_WORD_GAP_SEC, 3)
        if float(entries[i]["end"]) <= float(entries[i]["start"]):
            entries[i]["end"] = round(float(entries[i]["start"]) + MIN_WORD_SEC, 3)
        if i + 1 < len(entries):
            limit = float(entries[i + 1]["start"]) - MIN_INTER_WORD_GAP_SEC
            if float(entries[i]["end"]) > limit:
                entries[i]["end"] = round(max(float(entries[i]["start"]) + MIN_WORD_SEC, limit), 3)


def refine_transcript_words(
    words: list[dict],
    envelopes: dict | None = None,
    *,
    vocals_path: Path | None = None,
) -> list[dict]:
    if not words:
        return words
    env = _load_envelope(envelopes, vocals_path)
    refined: list[dict] = []
    for i, w in enumerate(words):
        start = float(w["start"])
        end = float(w["end"])
        floor = refined[-1]["end"] + MIN_INTER_WORD_GAP_SEC if refined else 0.0
        next_start = float(words[i + 1]["start"]) if i + 1 < len(words) else env.times[-1]
        limit = next_start - MIN_INTER_WORD_GAP_SEC
        start = env.refine_start(start, end, floor_start=floor)
        end = env.extend_end(start, max(end, start + MIN_WORD_SEC), limit)
        end = shrink_end_for_gap(env, start, end, next_start)
        refined.append({"word": w["word"], "start": start, "end": end})
    return refined


def refine_word_schedule(
    schedule: list[dict],
    envelopes: dict | None = None,
    *,
    vocals_path: Path | None = None,
    fill_ratio: float = FILL_RATIO,
) -> list[dict]:
    if not schedule:
        return schedule
    env = _load_envelope(envelopes, vocals_path)
    out = [{**entry} for entry in schedule]

    orig_starts = [float(entry["start"]) for entry in out]

    for i, entry in enumerate(out):
        start = float(entry["start"])
        end = float(entry["end"])
        floor = out[i - 1]["end"] + MIN_INTER_WORD_GAP_SEC if i > 0 else 0.0
        next_start = float(out[i + 1]["start"]) if i + 1 < len(out) else env.times[-1]
        limit = next_start - MIN_INTER_WORD_GAP_SEC
        if entry.get("matched"):
            start = env.refine_start(start, end, floor_start=floor)
        end = env.extend_end(start, max(end, start + MIN_WORD_SEC), limit)
        end = shrink_end_for_gap(env, start, end, next_start)
        entry["start"] = start
        entry["end"] = end

    i = 0
    while i < len(out):
        if out[i].get("matched"):
            i += 1
            continue
        run_start = i
        run_line = out[run_start]["lineIndex"]
        while i < len(out) and not out[i].get("matched"):
            if out[i]["lineIndex"] != run_line:
                break
            i += 1
        run_end = i
        count = run_end - run_start
        if count <= 0:
            continue
        # Only remap repeat gaps sandwiched after a matched word on the same line.
        if run_start == 0 or not out[run_start - 1].get("matched"):
            continue
        if out[run_start - 1]["lineIndex"] != run_line:
            continue
        prev_end = float(out[run_start - 1]["end"]) + MIN_INTER_WORD_GAP_SEC
        next_start = orig_starts[run_end] - MIN_INTER_WORD_GAP_SEC if run_end < len(out) else env.times[-1]
        if run_end < len(out) and out[run_end]["lineIndex"] > run_line:
            next_start = max(next_start, orig_starts[run_end] - MIN_INTER_WORD_GAP_SEC)
        if next_start <= prev_end + MIN_WORD_SEC:
            continue
        slots = find_onset_peaks(env, prev_end, next_start, count)
        for j, slot in enumerate(slots):
            idx = run_start + j
            out[idx]["start"] = slot["start"]
            out[idx]["end"] = slot["end"]

    enforce_no_overlap(out)
    for entry in out:
        _apply_fill(entry, fill_ratio)
    return out


def write_refined_transcript(out_dir: Path, words: list[dict]) -> Path:
    path = out_dir / "transcript.json"
    path.write_text(json.dumps({"words": words}, indent=2), encoding="utf-8")
    return path
