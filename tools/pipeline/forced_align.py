"""CTC forced alignment of known lyrics to a vocal track.

Unlike ASR-timestamp alignment (faster-whisper + DTW), forced alignment takes the
*known* transcript and finds the most likely time for every token directly from the
acoustic model's frame posteriors. This is the same technique used by WhisperX / MFA
and produces word boundaries that track the singer without drifting ahead or behind.

The output schedule entries use the exact same shape as ``align.build_schedule`` so the
browser (Timing Lab + main app) renders them with no frontend changes.
"""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path

from .align import FILL_RATIO, INTER_WORD_GAP_SEC, MIN_WORD_SEC, enforce_word_gaps, _tokenize

# MMS_FA frame stride is 20 ms; sub-frame rounding lives well under perception.
_DEFAULT_BUNDLE = "MMS_FA"

# CTC token starts sit a little off the true acoustic onset (usually late, sometimes
# early when a window has trailing sustain). We snap each word start to the nearest
# vocal-energy onset in a bounded window around the forced start, so highlights fire
# exactly when the syllable is sung. A tiny lead keeps them from trailing the voice.
ONSET_BACK_SEC = 0.40
ONSET_FWD_SEC = 0.28
ONSET_RISE_RATIO = 0.22
ONSET_LEAD_SEC = 0.02


def _ascii_fold(text: str) -> str:
    """Strip accents so e.g. café -> cafe before dictionary filtering."""
    nfkd = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in nfkd if not unicodedata.combining(ch))


def _normalize_word(word: str, allowed: set[str]) -> str:
    """Lowercase, fold accents, and keep only characters the aligner dictionary knows."""
    folded = _ascii_fold(word or "").lower()
    kept = [ch for ch in folded if ch in allowed]
    out = "".join(kept)
    # collapse repeated apostrophes / stray separators the dict may not model well
    out = re.sub(r"'+", "'", out).strip("'")
    return out


class ForcedAligner:
    """Lazy wrapper around a torchaudio Wav2Vec2 forced-alignment bundle."""

    def __init__(self, *, bundle_name: str = _DEFAULT_BUNDLE, device: str = "cpu") -> None:
        import torch
        import torchaudio

        self._torch = torch
        self._torchaudio = torchaudio
        self.device = "cuda" if device == "cuda" and torch.cuda.is_available() else "cpu"

        bundle = getattr(torchaudio.pipelines, bundle_name)
        self.bundle = bundle
        self.sample_rate = bundle.sample_rate
        self.model = bundle.get_model(with_star=False).to(self.device)
        self.model.eval()
        self.tokenizer = bundle.get_tokenizer()
        self.aligner = bundle.get_aligner()
        # The dictionary reserves index 0 for the CTC blank ("-") and "*" for the
        # star token. Neither may appear in a forced-alignment target, so drop them
        # from the allowed set (e.g. "Yabba-da-ba-doo" -> "yabbadabadoo").
        token_dict = bundle.get_dict()
        self.allowed = {
            ch for ch, idx in token_dict.items() if idx != 0 and ch != "*"
        }

    def load_waveform(self, path: Path):
        """Load a file as a mono waveform tensor at the model sample rate."""
        ta = self._torchaudio
        waveform, sr = ta.load(str(path))
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)
        if sr != self.sample_rate:
            waveform = ta.functional.resample(waveform, sr, self.sample_rate)
        return waveform.to(self.device)

    def align_waveform(self, waveform, words: list[str]) -> list[dict]:
        """Force-align ``words`` to an in-memory mono waveform.

        Returns ``[{word, start, end, matched}]`` with times relative to the start of
        the given waveform. Words that normalize to empty (pure punctuation, ad-libs)
        get a ``None`` slot and are interpolated by the schedule builder.
        """
        torch = self._torch
        norm = [_normalize_word(w, self.allowed) for w in words]
        align_idx = [i for i, n in enumerate(norm) if n]
        transcript = [norm[i] for i in align_idx]
        results: list[dict] = [
            {"word": w, "start": None, "end": None, "matched": False} for w in words
        ]
        if not transcript or waveform.shape[1] < self.sample_rate * 0.1:
            return results

        total_sec = waveform.shape[1] / self.sample_rate
        with torch.inference_mode():
            emission, _ = self.model(waveform)
            token_spans = self.aligner(emission[0], self.tokenizer(transcript))

        num_frames = emission.shape[1]
        sec_per_frame = total_sec / max(1, num_frames)
        for spans, orig_i in zip(token_spans, align_idx):
            if not spans:
                continue
            start = spans[0].start * sec_per_frame
            end = spans[-1].end * sec_per_frame
            score = sum(s.score * (s.end - s.start) for s in spans)
            denom = sum((s.end - s.start) for s in spans) or 1
            results[orig_i] = {
                "word": words[orig_i],
                "start": round(float(start), 3),
                "end": round(float(max(end, start + MIN_WORD_SEC)), 3),
                "matched": True,
                "score": round(float(score / denom), 4),
            }
        return results

    def align(self, vocals_path: Path, words: list[str]) -> list[dict]:
        """Force-align ``words`` to a whole audio file (single global pass)."""
        return self.align_waveform(self.load_waveform(vocals_path), words)


def _interpolate_missing(aligned: list[dict]) -> None:
    """Fill start/end for tokens that had no alignable characters, using neighbors."""
    n = len(aligned)
    for i, entry in enumerate(aligned):
        if entry["start"] is not None:
            continue
        prev_end = None
        for j in range(i - 1, -1, -1):
            if aligned[j]["end"] is not None:
                prev_end = aligned[j]["end"]
                break
        next_start = None
        for j in range(i + 1, n):
            if aligned[j]["start"] is not None:
                next_start = aligned[j]["start"]
                break
        if prev_end is not None and next_start is not None and next_start > prev_end:
            mid = (prev_end + next_start) / 2
            entry["start"] = round(mid, 3)
            entry["end"] = round(min(next_start, mid + MIN_WORD_SEC), 3)
        elif prev_end is not None:
            entry["start"] = round(prev_end, 3)
            entry["end"] = round(prev_end + MIN_WORD_SEC, 3)
        elif next_start is not None:
            entry["start"] = round(max(0.0, next_start - MIN_WORD_SEC), 3)
            entry["end"] = round(next_start, 3)
        else:
            entry["start"] = 0.0
            entry["end"] = MIN_WORD_SEC


def _snap_onsets(schedule: list[dict], vocals_path: Path, *, lead: float = ONSET_LEAD_SEC) -> None:
    """Snap each word start to the nearest vocal-energy onset, bounded by neighbors.

    Bidirectional: a word the CTC placed *late* (e.g. single-letter "I") is pulled
    earlier, and a word placed *early* (window with trailing sustain) is pushed onto the
    real onset. The search is bounded by the previous and next word so it can't grab a
    neighbor's onset, and it picks the energy rise closest to the forced start.
    """
    from .word_refine import VocalEnvelope

    env = VocalEnvelope.from_wav(vocals_path)
    orig_starts = [float(e["start"]) for e in schedule]
    prev_end = 0.0
    for i, entry in enumerate(schedule):
        start = float(entry["start"])
        end = float(entry["end"])
        floor = prev_end + INTER_WORD_GAP_SEC
        next_start = orig_starts[i + 1] if i + 1 < len(schedule) else env.times[-1]
        lo = max(floor, start - ONSET_BACK_SEC)
        hi = min(next_start - INTER_WORD_GAP_SEC, start + ONSET_FWD_SEC)
        onset = start
        if hi > lo:
            i_lo = env.idx_at(lo)
            i_hi = env.idx_at(hi)
            window = env.values[i_lo : i_hi + 1]
            peak = max(window) if window else 0.0
            if peak > 0:
                threshold = peak * ONSET_RISE_RATIO
                cur = min(max(env.idx_at(start), i_lo), i_hi)
                if env.values[cur] >= threshold:
                    # Inside voiced energy: walk back to where this region began.
                    k = cur
                    while k > i_lo and env.values[k - 1] >= threshold:
                        k -= 1
                    if k > i_lo and env.values[k - 1] < threshold:
                        onset = env.times[k]
                else:
                    # Landed in a gap: snap forward to the next onset (the word's attack).
                    k = cur
                    while k < i_hi and env.values[k] < threshold:
                        k += 1
                    if env.values[k] >= threshold:
                        onset = env.times[k]
        new_start = min(max(onset + lead, floor), max(floor, hi))
        new_end = max(new_start + MIN_WORD_SEC, end)
        entry["start"] = round(new_start, 3)
        entry["end"] = round(new_end, 3)
        prev_end = new_end


def asr_anchor_word_times(
    flat_tokens: list[str], asr_words: list[dict], duration: float
) -> list[float]:
    """Rough per-word start times from a global, monotonic lyric<->ASR alignment.

    A single Needleman-Wunsch pass over the whole song matches lyric words to whisper
    words in time order, so repeated choruses map to their correct occurrence. Unmatched
    lyric words are linearly interpolated between matched anchors.
    """
    from .align import _align_line_tokens

    n = len(flat_tokens)
    if not asr_words or n == 0:
        return [duration * i / max(1, n) for i in range(n)]

    pairs = _align_line_tokens(flat_tokens, asr_words)
    times: list[float | None] = [None] * n
    for p in pairs:
        if p["asr_idx"] >= 0:
            times[p["lyric_idx"]] = float(asr_words[p["asr_idx"]]["start"])

    anchors = [i for i, t in enumerate(times) if t is not None]
    if not anchors:
        return [duration * i / max(1, n) for i in range(n)]

    first, last = anchors[0], anchors[-1]
    for i in range(first):
        times[i] = max(0.0, times[first] * (i + 1) / (first + 1))
    for i in range(last + 1, n):
        frac = (i - last) / max(1, n - last)
        times[i] = times[last] + (duration - times[last]) * frac
    for a in range(len(anchors) - 1):
        i0, i1 = anchors[a], anchors[a + 1]
        t0, t1 = times[i0], times[i1]
        for k in range(i0 + 1, i1):
            times[k] = t0 + (t1 - t0) * (k - i0) / (i1 - i0)
    # enforce monotonic non-decreasing
    out: list[float] = []
    cur = 0.0
    for t in times:
        cur = max(cur, float(t if t is not None else cur))
        out.append(cur)
    return out


def windows_from_word_times(
    word_times: list[float],
    owner: list[tuple[int, int]],
    num_lines: int,
    duration: float,
    *,
    pad: float = 1.0,
) -> list[tuple[float, float]]:
    """Per-line [t0, t1] window from rough per-word start times."""
    spans: dict[int, list[float]] = {}
    for (li, _wi), t in zip(owner, word_times):
        spans.setdefault(li, []).append(t)
    windows: list[tuple[float, float]] = []
    last = 0.0
    for li in range(num_lines):
        ts = spans.get(li)
        if ts:
            lo, hi = min(ts), max(ts)
        else:
            lo = hi = last
        t0 = max(0.0, lo - pad)
        t1 = min(duration, hi + pad + 1.5)  # extra tail room for held notes
        windows.append((t0, max(t1, t0 + 0.4)))
        last = hi
    return windows


def windows_from_schedule(
    rough: list[dict], num_lines: int, duration: float, *, pad: float = 0.6
) -> list[tuple[float, float]]:
    """Derive a per-line [t0, t1] audio window from a coarse (whisper) schedule.

    Used to anchor forced alignment: aligning each line within a short window keeps a
    long, melismatic song from drifting and resolves repeated choruses correctly.
    """
    bounds: list[tuple[float, float] | None] = [None] * num_lines
    by_line: dict[int, list[dict]] = {}
    for w in rough:
        by_line.setdefault(int(w["lineIndex"]), []).append(w)
    for li, words in by_line.items():
        if 0 <= li < num_lines and words:
            bounds[li] = (
                min(float(w["start"]) for w in words),
                max(float(w["end"]) for w in words),
            )
    # Fill gaps for lines the rough pass skipped, then pad and clamp.
    last_end = 0.0
    windows: list[tuple[float, float]] = []
    for li in range(num_lines):
        b = bounds[li]
        if b is None:
            nxt = next((bounds[j][0] for j in range(li + 1, num_lines) if bounds[j]), duration)
            b = (last_end, max(last_end + 1.0, nxt))
        t0 = max(0.0, b[0] - pad)
        t1 = min(duration, b[1] + pad)
        windows.append((t0, max(t1, t0 + 0.3)))
        last_end = b[1]
    return windows


def build_forced_schedule(
    timed_lines: list[dict],
    vocals_path: Path,
    *,
    device: str = "cpu",
    refine_onsets: bool = True,
    onset_lead: float = ONSET_LEAD_SEC,
    line_windows: list[tuple[float, float]] | None = None,
    aligner: ForcedAligner | None = None,
) -> list[dict]:
    """Force-align known lyrics to the vocal stem and emit a word_schedule list.

    When ``line_windows`` is given (one [t0, t1] per line, e.g. from whisper anchors),
    each line is aligned within its own audio slice; otherwise a single global pass is
    used (fine for short clips, drifts on long songs).
    """
    line_tokens: list[list[str]] = [_tokenize(line.get("text", "")) for line in timed_lines]
    flat_words: list[str] = []
    owner: list[tuple[int, int]] = []  # (lineIndex, wordIndex)
    for li, tokens in enumerate(line_tokens):
        for wi, tok in enumerate(tokens):
            flat_words.append(tok)
            owner.append((li, wi))

    if not flat_words:
        return []

    aligner = aligner or ForcedAligner(device=device)

    if line_windows is not None:
        waveform = aligner.load_waveform(vocals_path)
        sr = aligner.sample_rate
        aligned = []
        for li, tokens in enumerate(line_tokens):
            if not tokens:
                continue
            t0, t1 = line_windows[li]
            seg = waveform[:, int(t0 * sr) : int(t1 * sr)]
            seg_aligned = aligner.align_waveform(seg, tokens)
            for a in seg_aligned:
                if a["start"] is not None:
                    a["start"] = round(a["start"] + t0, 3)
                    a["end"] = round(a["end"] + t0, 3)
            aligned.extend(seg_aligned)
    else:
        aligned = aligner.align(vocals_path, flat_words)

    _interpolate_missing(aligned)

    schedule: list[dict] = []
    for (li, wi), a in zip(owner, aligned):
        line_len = len(line_tokens[li])
        start = float(a["start"])
        end = float(max(a["end"], start + MIN_WORD_SEC))
        schedule.append(
            {
                "lineIndex": li,
                "word": a["word"],
                "wordIndex": wi,
                "isLineEnd": wi == line_len - 1,
                "start": round(start, 3),
                "end": round(end, 3),
                "fillEnd": round(start + (end - start) * FILL_RATIO, 3),
                "matched": bool(a.get("matched")),
                "whisper": True,
                "direct": True,
                "forced": True,
            }
        )

    if refine_onsets:
        _snap_onsets(schedule, vocals_path, lead=onset_lead)

    enforce_word_gaps(schedule)
    for entry in schedule:
        entry["fillEnd"] = round(
            entry["start"] + (entry["end"] - entry["start"]) * FILL_RATIO, 3
        )
    return schedule
