"""End-to-end analysis orchestration shared by the CLI and the web backend.

run_pipeline(audio, out_dir, ...) -> manifest dict, emitting progress via a callback so
the GUI can show a live status bar (download → stems → analyze → lyrics → blueprint).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

from .align import build_schedule, parse_lyrics_file, parse_lyrics_text, _tokenize, write_word_schedule
from .envelopes import write_envelopes
from .lyrics_fetch import fetch_lyrics, merge_meta
from .manifest import build_manifest, sidecar_dir_for, write_manifest
from .profile import analyze_profile
from .separate import separate
from .word_refine import refine_transcript_words, refine_word_schedule

Progress = Callable[[str, float, str], None]  # (step, fraction 0..1, message)


def _noop(step: str, frac: float, msg: str) -> None:  # pragma: no cover
    pass


def _resolve_lyrics(audio_path, *, lyrics_path, artist, title, duration):
    if lyrics_path:
        path = Path(lyrics_path).resolve()
        if not path.exists():
            raise FileNotFoundError(f"Lyrics not found: {path}")
        timed = parse_lyrics_file(path)
        return timed, {"source": "file", "path": str(path), "lineCount": len(timed),
                       "synced": any(float(r.get("time") or 0) > 0 for r in timed)}
    meta = merge_meta(audio_path, artist=artist, title=title)
    fetched = fetch_lyrics(meta, duration)
    if not fetched:
        raise RuntimeError("No lyrics from LRCLIB; pass lyrics or use 'Artist - Title.mp3'.")
    if fetched.synced_lrc:
        timed = parse_lyrics_text(fetched.synced_lrc)
    else:
        timed = [{"time": 0.0, "text": ln, "hintEstimated": True} for ln in fetched.plain_lines]
    return timed, {"source": fetched.source, "artist": fetched.meta.artist, "title": fetched.meta.title,
                   "album": fetched.meta.album, "lineCount": len(timed), "synced": fetched.synced}


def _aligned_schedule(timed_lines, stem_paths, envelopes, duration, *, device, anchor, model, force, out_dir, lyric_lead):
    from .forced_align import (
        asr_anchor_word_times, build_forced_schedule, windows_from_line_times, windows_from_word_times,
    )

    line_windows = None
    if anchor in ("auto", "lrc"):
        line_windows = windows_from_line_times(timed_lines, duration)
    if line_windows is None and anchor in ("auto", "whisper"):
        from .transcribe import transcribe_vocals, write_transcript
        tp = out_dir / "transcript.json"
        if tp.exists() and not force:
            asr = json.loads(tp.read_text()).get("words", [])
        else:
            asr = transcribe_vocals(stem_paths["vocals"], model_size=model, device=device)
            write_transcript(out_dir, asr)
        asr = refine_transcript_words(asr, envelopes, vocals_path=stem_paths["vocals"])
        write_transcript(out_dir, asr)
        flat, owner = [], []
        for li, line in enumerate(timed_lines):
            for wi, tok in enumerate(_tokenize(line.get("text", ""))):
                flat.append(tok); owner.append((li, wi))
        wt = asr_anchor_word_times(flat, asr, duration)
        line_windows = windows_from_word_times(wt, owner, len(timed_lines), duration)
    return build_forced_schedule(timed_lines, stem_paths["vocals"], device=device,
                                 onset_lead=lyric_lead, line_windows=line_windows)


def run_pipeline(
    audio_path,
    *,
    out_dir=None,
    lyrics_path=None,
    artist=None,
    title=None,
    device="cpu",
    align="forced",
    anchor="auto",
    model="base.en",
    lyric_lead=0.02,
    with_insights=True,
    tagger=None,
    progress: Progress = _noop,
) -> dict:
    audio_path = Path(audio_path).resolve()
    if not audio_path.exists():
        raise FileNotFoundError(audio_path)
    out_dir = Path(out_dir) if out_dir else sidecar_dir_for(audio_path)
    out_dir.mkdir(parents=True, exist_ok=True)

    import librosa
    duration = float(librosa.get_duration(path=str(audio_path)))

    progress("separate", 0.05, "Separating stems with Demucs…")
    stem_paths = separate(audio_path, out_dir, device=device)

    progress("envelopes", 0.45, "Extracting stem energy envelopes…")
    envelopes_path = write_envelopes(out_dir, stem_paths)
    envelopes = json.loads(envelopes_path.read_text())

    lyrics_info = None
    word_schedule_path = None
    align_method = None
    progress("lyrics", 0.55, "Fetching lyrics + aligning words…")
    try:
        timed_lines, lyrics_info = _resolve_lyrics(
            audio_path, lyrics_path=lyrics_path, artist=artist, title=title, duration=duration
        )
        if align in ("forced", "hybrid"):
            try:
                schedule = _aligned_schedule(timed_lines, stem_paths, envelopes, duration,
                                             device=device, anchor=anchor, model=model,
                                             force=True, out_dir=out_dir, lyric_lead=lyric_lead)
                align_method = "forced"
            except Exception as err:  # noqa: BLE001
                progress("lyrics", 0.6, f"Forced align failed ({err}); using whisper.")
                schedule = None
        else:
            schedule = None
        if schedule is None:
            from .transcribe import transcribe_vocals, write_transcript
            asr = transcribe_vocals(stem_paths["vocals"], model_size=model, device=device)
            write_transcript(out_dir, asr)
            asr = refine_transcript_words(asr, envelopes, vocals_path=stem_paths["vocals"])
            write_transcript(out_dir, asr)
            schedule = build_schedule(timed_lines, asr, envelopes=envelopes)
            schedule = refine_word_schedule(schedule, envelopes, vocals_path=stem_paths["vocals"])
            align_method = "whisper"
        word_schedule_path = write_word_schedule(out_dir, schedule)
        # Persist the (synced) lyric lines so the browser never re-fetches.
        lines = [{"time": float(l.get("time") or 0), "text": l.get("text", "")} for l in timed_lines]
        (out_dir / "lyrics.json").write_text(json.dumps(lines, indent=2), encoding="utf-8")
    except (FileNotFoundError, RuntimeError) as err:
        progress("lyrics", 0.7, f"No lyric alignment ({err}).")

    progress("profile", 0.8, "Profiling tempo, energy, sections…")
    profile = analyze_profile(audio_path, envelopes)

    insights = animation = None
    if with_insights:
        progress("insights", 0.9, "Detecting genre, mood, key + animation blueprint…")
        try:
            from .insights import analyze_insights, load_tagger
            if tagger is None:
                tagger = load_tagger()
            ins = analyze_insights(audio_path, envelopes, profile, tagger=tagger)
            insights, animation = ins["insights"], ins["animation"]
        except Exception as err:  # noqa: BLE001
            progress("insights", 0.92, f"Insights skipped ({err}).")

    paths = {
        "stems": {k: f"stems/{k}.wav" for k in ("vocals", "drums", "bass", "other")},
        "envelopes": "envelopes.json",
    }
    if (out_dir / "transcript.json").exists():
        paths["transcript"] = "transcript.json"
    if word_schedule_path:
        paths["word_schedule"] = "word_schedule.json"
        paths["lyrics"] = "lyrics.json"
    if lyrics_info is not None and align_method:
        lyrics_info["alignMethod"] = align_method

    manifest = build_manifest(
        source_file=audio_path.name, duration=profile["duration"], bpm=profile["bpm"],
        profile=profile, paths=paths, lyrics=lyrics_info, schedule_refined=bool(word_schedule_path),
    )
    if insights is not None:
        manifest["insights"] = insights
    if animation is not None:
        manifest["animation"] = animation
    write_manifest(out_dir, manifest)
    progress("done", 1.0, "Analysis complete.")
    return manifest
