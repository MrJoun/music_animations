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

# CTC models emit a token a frame or two after the true acoustic onset. We snap each
# word start back to the vocal-energy onset, bounded so we never cross into the prior
# word, then apply a tiny lead so highlights land on the beat rather than just behind it.
ONSET_BACK_SEC = 0.40
ONSET_FWD_SEC = 0.05
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

    def _load_mono(self, path: Path):
        torch = self._torch
        ta = self._torchaudio
        waveform, sr = ta.load(str(path))
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)
        if sr != self.sample_rate:
            waveform = ta.functional.resample(waveform, sr, self.sample_rate)
        return waveform.to(self.device)

    def align(self, vocals_path: Path, words: list[str]) -> list[dict]:
        """Return ``[{word, start, end, matched}]`` for the given word list.

        Words that normalize to empty (pure punctuation, ad-libs like "—") get a
        ``None`` time slot here and are interpolated by the schedule builder.
        """
        torch = self._torch
        norm = [_normalize_word(w, self.allowed) for w in words]
        align_idx = [i for i, n in enumerate(norm) if n]
        transcript = [norm[i] for i in align_idx]
        if not transcript:
            return [{"word": w, "start": None, "end": None, "matched": False} for w in words]

        waveform = self._load_mono(vocals_path)
        total_sec = waveform.shape[1] / self.sample_rate

        with torch.inference_mode():
            emission, _ = self.model(waveform)
            token_spans = self.aligner(emission[0], self.tokenizer(transcript))

        num_frames = emission.shape[1]
        sec_per_frame = total_sec / max(1, num_frames)

        results: list[dict] = [
            {"word": w, "start": None, "end": None, "matched": False} for w in words
        ]
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
    """Snap each word start to the local vocal-energy onset, bounded by neighbors.

    The search reaches back toward (but never past) the previous word so single-letter
    tokens like "I" that CTC places late are pulled onto the real onset, while words in
    legato passages can't grab a distant earlier rise.
    """
    from .word_refine import VocalEnvelope

    env = VocalEnvelope.from_wav(vocals_path)
    prev_end = 0.0
    for entry in schedule:
        start = float(entry["start"])
        end = float(entry["end"])
        floor = prev_end + INTER_WORD_GAP_SEC
        lo = max(floor, start - ONSET_BACK_SEC)
        hi = start + ONSET_FWD_SEC
        i_lo = env.idx_at(lo)
        i_hi = env.idx_at(hi)
        onset = start
        if i_hi > i_lo:
            window = env.values[i_lo : i_hi + 1]
            peak = max(window) if window else 0.0
            if peak > 0:
                threshold = peak * ONSET_RISE_RATIO
                # Walk backward from the forced start to the most recent below->above
                # crossing: the word's own onset, not an earlier blip in the gap.
                for k in range(i_hi, i_lo, -1):
                    if env.values[k] >= threshold and env.values[k - 1] < threshold:
                        onset = env.times[k]
                        break
        new_start = min(max(onset + lead, floor), start + ONSET_FWD_SEC)
        new_end = max(new_start + MIN_WORD_SEC, end)
        entry["start"] = round(new_start, 3)
        entry["end"] = round(new_end, 3)
        prev_end = new_end


def build_forced_schedule(
    timed_lines: list[dict],
    vocals_path: Path,
    *,
    device: str = "cpu",
    refine_onsets: bool = True,
    onset_lead: float = ONSET_LEAD_SEC,
    aligner: ForcedAligner | None = None,
) -> list[dict]:
    """Force-align known lyrics to the vocal stem and emit a word_schedule list."""
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
