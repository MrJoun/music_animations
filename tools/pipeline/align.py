"""DTW lyric alignment — port of js/whisper-aligner.js schedule builder."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .word_refine import VocalEnvelope

TIMESTAMP_PAD_SEC = 0.02
MIN_WORD_SEC = 0.09
INTER_WORD_GAP_SEC = 0.05
FILL_RATIO = 0.94
GAP = -3
MIN_MATCH_SCORE = 1
SEGMENT_GAP_SEC = 0.9


def _norm(word: str) -> str:
    return re.sub(r"[^a-z0-9']", "", (word or "").lower())


def _norm_line(text: str) -> str:
    return " ".join(_norm(w) for w in _tokenize(text))


def _tokenize(text: str) -> list[str]:
    return [w.strip() for w in re.split(r"\s+", text or "") if w.strip()]


def _syllable_weight(word: str) -> float:
    w = _norm(word)
    if not w:
        return 0.75
    vowels = len(re.findall(r"[aeiouy]+", w))
    return max(0.75, vowels or len(w) * 0.35)


def _estimate_line_duration(text: str) -> float:
    tokens = _tokenize(text)
    if not tokens:
        return 4.0
    return sum(_syllable_weight(w) for w in tokens) * 0.18 + 0.5


def _match_score(a: str, b: str) -> int:
    na, nb = _norm(a), _norm(b)
    if not na or not nb:
        return -2
    if na == nb:
        return 4
    if na in nb or nb in na:
        return 2
    if len(na) >= 3 and len(nb) >= 3 and na[:3] == nb[:3]:
        return 1
    return -1


def _asr_segments(asr_words: list[dict]) -> list[dict]:
    if not asr_words:
        return []

    segments: list[dict] = []
    words = [asr_words[0]["word"]]
    start = asr_words[0]["start"]
    end = asr_words[0]["end"]

    for w in asr_words[1:]:
        if w["start"] - end > SEGMENT_GAP_SEC:
            segments.append({"start": start, "end": end, "text": " ".join(words)})
            words = [w["word"]]
            start = w["start"]
            end = w["end"]
        else:
            words.append(w["word"])
            end = w["end"]

    segments.append({"start": start, "end": end, "text": " ".join(words)})
    return segments


def _line_segment_score(line_text: str, segment_text: str) -> float:
    line_tokens = [_norm(w) for w in _tokenize(line_text)]
    seg_tokens = [_norm(w) for w in _tokenize(segment_text)]
    if not line_tokens or not seg_tokens:
        return 0.0
    hits = sum(1 for w in line_tokens if any(_match_score(w, s) >= MIN_MATCH_SCORE for s in seg_tokens))
    return hits / len(line_tokens)


def anchor_plain_lines(timed_lines: list[dict], asr_words: list[dict]) -> list[dict]:
    """Assign approximate line start times to plain-text lyrics using ASR segments."""
    if not timed_lines or not asr_words:
        return timed_lines
    if not any(line.get("hintEstimated") for line in timed_lines):
        return timed_lines

    segments = _asr_segments(asr_words)
    if not segments:
        return timed_lines

    seg_cursor = 0
    prev_end = 0.0

    for line in timed_lines:
        if not line.get("hintEstimated"):
            prev_end = max(prev_end, line.get("time", 0.0) + _estimate_line_duration(line.get("text", "")))
            continue

        tokens = _tokenize(line.get("text", ""))
        if not tokens:
            continue

        best_j = seg_cursor
        best_score = -1.0
        for j in range(seg_cursor, min(len(segments), seg_cursor + 10)):
            score = _line_segment_score(line.get("text", ""), segments[j]["text"])
            if score > best_score:
                best_score = score
                best_j = j

        if best_score >= 0.25:
            line["time"] = max(prev_end + 0.05, segments[best_j]["start"])
            prev_end = segments[best_j]["end"]
            seg_cursor = best_j + 1
        else:
            est = _estimate_line_duration(line.get("text", ""))
            line["time"] = prev_end + 0.08
            prev_end = line["time"] + est

        line.pop("hintEstimated", None)

    return timed_lines


def _align_line_tokens(line_tokens: list[str], asr_pool: list[dict]) -> list[dict]:
    n, m = len(line_tokens), len(asr_pool)
    if n == 0:
        return []
    if m == 0:
        return [{"lyric_idx": i, "asr_idx": -1} for i in range(n)]

    neg = -1e9
    dp = [[neg] * (m + 1) for _ in range(n + 1)]
    bt = [[0] * (m + 1) for _ in range(n + 1)]

    dp[0][0] = 0
    for i in range(1, n + 1):
        dp[i][0] = dp[i - 1][0] + GAP
        bt[i][0] = 1
    for j in range(1, m + 1):
        dp[0][j] = dp[0][j - 1] + GAP
        bt[0][j] = 2

    for i in range(1, n + 1):
        for j in range(1, m + 1):
            ms = _match_score(line_tokens[i - 1], asr_pool[j - 1]["word"])
            match = dp[i - 1][j - 1] + ms if ms >= MIN_MATCH_SCORE else neg
            gap_l = dp[i - 1][j] + GAP
            gap_w = dp[i][j - 1] + GAP
            best, direction = match, 0
            if gap_l > best:
                best, direction = gap_l, 1
            if gap_w > best:
                best, direction = gap_w, 2
            dp[i][j] = best
            bt[i][j] = direction

    pairs: list[dict] = []
    i, j = n, m
    while i > 0 or j > 0:
        direction = bt[i][j]
        if direction == 0 and i > 0 and j > 0:
            pairs.append({"lyric_idx": i - 1, "asr_idx": j - 1})
            i -= 1
            j -= 1
        elif direction == 1 and i > 0:
            pairs.append({"lyric_idx": i - 1, "asr_idx": -1})
            i -= 1
        elif direction == 2 and j > 0:
            j -= 1
        elif i > 0:
            pairs.append({"lyric_idx": i - 1, "asr_idx": -1})
            i -= 1
        else:
            j -= 1
    pairs.reverse()
    return _sanitize_pairs(pairs, line_tokens, asr_pool)


def _sanitize_pairs(pairs: list[dict], line_tokens: list[str], asr_pool: list[dict]) -> list[dict]:
    """Drop weak or duplicate ASR matches so repeats interpolate instead of jumping."""
    used_asr: set[int] = set()
    out: list[dict] = []
    for pair in pairs:
        idx = pair["asr_idx"]
        if idx < 0:
            out.append(pair)
            continue
        if idx in used_asr:
            out.append({"lyric_idx": pair["lyric_idx"], "asr_idx": -1})
            continue
        score = _match_score(line_tokens[pair["lyric_idx"]], asr_pool[idx]["word"])
        if score < MIN_MATCH_SCORE:
            out.append({"lyric_idx": pair["lyric_idx"], "asr_idx": -1})
            continue
        used_asr.add(idx)
        out.append(pair)
    return out


def _is_repeat_line(timed_lines: list[dict], line_index: int) -> bool:
    if line_index <= 0:
        return False
    prev = _norm_line(timed_lines[line_index - 1].get("text", ""))
    curr = _norm_line(timed_lines[line_index].get("text", ""))
    return bool(prev and prev == curr)


def _line_window(
    timed_lines: list[dict],
    line_index: int,
    asr_words: list[dict],
    asr_cursor: int,
    prev_line_end: float,
) -> list[dict]:
    line = timed_lines[line_index]
    hint = float(line.get("time", 0) or 0)
    next_hint = (
        float(timed_lines[line_index + 1]["time"])
        if line_index + 1 < len(timed_lines)
        else None
    )
    est_dur = _estimate_line_duration(line.get("text", ""))

    if line.get("hintEstimated") and prev_line_end > 0:
        hint = prev_line_end + 0.08

    lo = max(0.0, hint - 2.5, prev_line_end - 0.25)
    if _is_repeat_line(timed_lines, line_index):
        lo = max(lo, prev_line_end + 0.05)

    if next_hint is not None:
        hi = next_hint + 2.5
    else:
        hi = hint + max(est_dur + 4.0, 12.0)

    hi = min(hi, max(hint, prev_line_end) + est_dur + 8.0)
    if line.get("hintEstimated"):
        hi = min(hi, hint + est_dur + 6.0)

    pool: list[dict] = []
    for idx in range(asr_cursor, len(asr_words)):
        w = asr_words[idx]
        if w["start"] >= lo and w["start"] < hi:
            pool.append({**w, "global_idx": idx})
        if w["start"] >= hi and len(pool) > 6:
            break

    if len(pool) < 2:
        for idx in range(asr_cursor, len(asr_words)):
            if len(pool) >= 60:
                break
            w = asr_words[idx]
            if w["start"] >= lo - 1.5 and w["start"] < hi + 4:
                if not any(p["global_idx"] == idx for p in pool):
                    pool.append({**w, "global_idx": idx})

    return pool


def _spread_by_weight(count: int, weights: list[float], t0: float, t1: float) -> list[dict]:
    if count <= 0:
        return []
    total_gap = INTER_WORD_GAP_SEC * max(0, count - 1)
    usable = max(MIN_WORD_SEC * count, t1 - t0 - total_gap)
    total = sum(weights) or 1.0
    slots: list[dict] = []
    cum = 0.0
    cursor = t0
    for i, weight in enumerate(weights):
        a = cum / total
        cum += weight
        b = cum / total
        seg_start = t0 + a * usable
        seg_end = t0 + b * usable
        dur = max(MIN_WORD_SEC, seg_end - seg_start)
        slots.append({"start": round(cursor, 3), "end": round(cursor + dur, 3)})
        cursor += dur + (INTER_WORD_GAP_SEC if i < count - 1 else 0)
    return slots


def enforce_word_gaps(entries: list[dict]) -> None:
    """Ensure consecutive words do not touch — leave inter-word silence slots."""
    for i in range(len(entries)):
        if i > 0:
            min_start = float(entries[i - 1]["end"]) + INTER_WORD_GAP_SEC
            if float(entries[i]["start"]) < min_start:
                entries[i]["start"] = round(min_start, 3)
        if float(entries[i]["end"]) <= float(entries[i]["start"]):
            entries[i]["end"] = round(float(entries[i]["start"]) + MIN_WORD_SEC, 3)
        if i + 1 < len(entries):
            max_end = float(entries[i + 1]["start"]) - INTER_WORD_GAP_SEC
            if float(entries[i]["end"]) > max_end:
                entries[i]["end"] = round(max(float(entries[i]["start"]) + MIN_WORD_SEC, max_end), 3)


def _interpolate_direct_times(
    tokens: list[str],
    pairs: list[dict],
    asr_pool: list[dict],
    floor_time: float,
    *,
    vocal_env: VocalEnvelope | None = None,
) -> list[dict]:
    n = len(tokens)
    times: list[dict | None] = [None] * n
    weights = [_syllable_weight(w) for w in tokens]

    for pair in pairs:
        if pair["asr_idx"] >= 0:
            a = asr_pool[pair["asr_idx"]]
            times[pair["lyric_idx"]] = {
                "start": a["start"] + TIMESTAMP_PAD_SEC,
                "end": a["end"] + TIMESTAMP_PAD_SEC,
            }

    anchors = [i for i, t in enumerate(times) if t is not None]
    if not anchors:
        span = sum(weights) * 0.16
        slots = _spread_by_weight(n, weights, floor_time, floor_time + span)
        return [
            {"start": s["start"], "end": max(s["start"] + MIN_WORD_SEC, s["end"])}
            for s in slots
        ]

    first = anchors[0]
    if first > 0:
        t1 = times[first]["start"] - INTER_WORD_GAP_SEC
        t0 = max(floor_time, t1 - sum(weights[:first]) * 0.15)
        slots = _spread_by_weight(first, weights[:first], t0, t1)
        for i in range(first):
            times[i] = slots[i]

    for a in range(len(anchors) - 1):
        i0, i1 = anchors[a], anchors[a + 1]
        gap_count = i1 - i0 - 1
        if gap_count <= 0:
            continue
        t0 = times[i0]["end"] + INTER_WORD_GAP_SEC
        t1 = times[i1]["start"] - INTER_WORD_GAP_SEC
        gap_weights = weights[i0 + 1 : i1]
        if vocal_env is not None and t1 > t0 + MIN_WORD_SEC:
            from .word_refine import find_onset_peaks

            slots = find_onset_peaks(vocal_env, t0, t1, gap_count)
        else:
            slots = _spread_by_weight(gap_count, gap_weights, t0, max(t0 + 0.08, t1))
        for k in range(gap_count):
            times[i0 + 1 + k] = slots[k]

    last = anchors[-1]
    if last < n - 1:
        t0 = times[last]["end"] + INTER_WORD_GAP_SEC
        tail = weights[last + 1 :]
        span = sum(tail) * 0.16
        slots = _spread_by_weight(n - last - 1, tail, t0, t0 + span)
        for k, slot in enumerate(slots):
            times[last + 1 + k] = slot

    result: list[dict] = []
    for t in times:
        if not t:
            result.append({"start": floor_time, "end": floor_time + MIN_WORD_SEC})
        else:
            result.append({"start": t["start"], "end": max(t["start"] + MIN_WORD_SEC, t["end"])})
    return result


def _build_line_schedule(
    line_index: int,
    tokens: list[str],
    pairs: list[dict],
    asr_pool: list[dict],
    prev_line_end: float | None,
    line_hint: float | None = None,
    next_hint: float | None = None,
    *,
    vocal_env: VocalEnvelope | None = None,
) -> tuple[list[dict], int]:
    floor_time = max(0.0, (prev_line_end or 0.0) + 0.06)
    if line_hint is not None and line_hint > floor_time + 0.15:
        floor_time = line_hint

    word_times = _interpolate_direct_times(tokens, pairs, asr_pool, floor_time, vocal_env=vocal_env)

    # When ASR misses trailing repeats, stretch unmatched tail toward the next LRC line.
    if next_hint is not None and tokens:
        tail_start = max(floor_time, (word_times[-1]["start"] if word_times else floor_time))
        target_end = max(tail_start + MIN_WORD_SEC, next_hint - 0.12)
        if word_times[-1]["end"] < target_end - 0.2:
            span = target_end - tail_start
            weights = [_syllable_weight(w) for w in tokens]
            slots = _spread_by_weight(len(tokens), weights, floor_time, floor_time + span)
            for i, slot in enumerate(slots):
                if not any(p["lyric_idx"] == i and p["asr_idx"] >= 0 for p in pairs):
                    word_times[i] = {
                        "start": slot["start"],
                        "end": max(slot["start"] + MIN_WORD_SEC, slot["end"]),
                    }

    words: list[dict] = []
    for wi, word in enumerate(tokens):
        wt = word_times[wi]
        words.append(
            {
                "lineIndex": line_index,
                "word": word,
                "wordIndex": wi,
                "isLineEnd": wi == len(tokens) - 1,
                "start": wt["start"],
                "end": wt["end"],
                "fillEnd": wt["start"] + (wt["end"] - wt["start"]) * FILL_RATIO,
                "matched": any(p["lyric_idx"] == wi and p["asr_idx"] >= 0 for p in pairs),
                "whisper": True,
                "direct": True,
            }
        )

    enforce_word_gaps(words)
    for word in words:
        word["fillEnd"] = word["start"] + (word["end"] - word["start"]) * FILL_RATIO

    matched = [p for p in pairs if p["asr_idx"] >= 0]
    last_global = matched[-1]["asr_idx"] if matched else -1
    if last_global >= 0:
        last_global = asr_pool[last_global]["global_idx"]
    else:
        last_global = -1

    return words, last_global


def build_schedule(
    timed_lines: list[dict],
    asr_words: list[dict],
    *,
    envelopes: dict | None = None,
) -> list[dict]:
    timed_lines = anchor_plain_lines(list(timed_lines), asr_words)

    vocal_env = None
    if envelopes and envelopes.get("times") and envelopes.get("vocals"):
        from .word_refine import VocalEnvelope

        vocal_env = VocalEnvelope.from_json(envelopes)

    schedule: list[dict] = []
    asr_cursor = 0
    prev_line_end = 0.0

    for li, line in enumerate(timed_lines):
        tokens = _tokenize(line.get("text", ""))
        if not tokens:
            continue
        pool = _line_window(timed_lines, li, asr_words, asr_cursor, prev_line_end)
        pairs = _align_line_tokens(tokens, pool)
        line_hint = float(line.get("time") or 0) if not line.get("hintEstimated") else None
        next_hint = (
            float(timed_lines[li + 1]["time"])
            if li + 1 < len(timed_lines) and not timed_lines[li + 1].get("hintEstimated")
            else None
        )
        words, last_global = _build_line_schedule(
            li, tokens, pairs, pool, prev_line_end, line_hint, next_hint, vocal_env=vocal_env
        )
        schedule.extend(words)
        prev_line_end = words[-1]["end"]
        if last_global >= 0:
            asr_cursor = max(asr_cursor, last_global + 1)

    return schedule


def parse_lyrics_file(path: Path) -> list[dict]:
    """Plain .txt (one line per row) or .lrc with [mm:ss.xx] tags."""
    text = path.read_text(encoding="utf-8", errors="replace")
    return parse_lyrics_text(text)


def parse_lyrics_text(text: str) -> list[dict]:
    lrc_re = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]")
    timed: list[dict] = []

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        match = lrc_re.match(line)
        if match:
            mins, secs = match.groups()
            t = int(mins) * 60 + float(secs)
            body = lrc_re.sub("", line).strip()
            if body:
                timed.append({"time": t, "text": body})
        else:
            timed.append({"time": 0.0, "text": line, "hintEstimated": True})

    return timed


def write_word_schedule(out_dir: Path, schedule: list[dict]) -> Path:
    path = out_dir / "word_schedule.json"
    path.write_text(json.dumps(schedule, indent=2), encoding="utf-8")
    return path
