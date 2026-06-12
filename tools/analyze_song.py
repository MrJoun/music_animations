#!/usr/bin/env python3
"""Reel Studio offline analysis: Demucs stems + lyric alignment + sidecar manifest.

Alignment strategies (``--align``):
  forced  (default)  CTC forced alignment of the known lyrics to the Demucs vocal stem
                     (torchaudio MMS_FA). Most accurate word timing; needs lyrics.
  whisper            faster-whisper ASR word timestamps + DTW lyric match + envelope
                     refinement (the original pipeline). Used as fallback automatically.
  hybrid             forced alignment, falling back to whisper per the rules above.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from pipeline.align import (
    build_schedule,
    parse_lyrics_file,
    parse_lyrics_text,
    write_word_schedule,
)
from pipeline.envelopes import write_envelopes
from pipeline.lyrics_fetch import fetch_lyrics, merge_meta
from pipeline.manifest import build_manifest, is_cache_valid, sidecar_dir_for, write_manifest
from pipeline.profile import analyze_profile
from pipeline.separate import separate
from pipeline.transcribe import transcribe_vocals, write_transcript
from pipeline.word_refine import refine_transcript_words, refine_word_schedule


def _audio_duration(audio_path: Path) -> float:
    try:
        import librosa

        return float(librosa.get_duration(path=str(audio_path)))
    except Exception:
        import soundfile as sf

        with sf.SoundFile(str(audio_path)) as f:
            return float(len(f) / f.samplerate)


def _resolve_lyrics(
    audio_path: Path,
    *,
    lyrics_path: Path | None,
    artist: str | None,
    title: str | None,
    duration: float,
) -> tuple[list[dict], dict[str, object] | None]:
    if lyrics_path:
        path = lyrics_path.resolve()
        if not path.exists():
            raise FileNotFoundError(f"Lyrics not found: {path}")
        timed = parse_lyrics_file(path)
        return timed, {
            "source": "file",
            "path": str(path),
            "lineCount": len(timed),
            "synced": any(float(row.get("time") or 0) > 0 for row in timed),
        }

    print("Fetching lyrics from LRCLIB…")
    meta = merge_meta(audio_path, artist=artist, title=title)
    fetched = fetch_lyrics(meta, duration)
    if not fetched:
        raise RuntimeError(
            "Could not auto-fetch lyrics. Pass --lyrics, or use Artist - Title.mp3 / --artist --title."
        )

    if fetched.synced_lrc:
        timed = parse_lyrics_text(fetched.synced_lrc)
    else:
        timed = [{"time": 0.0, "text": line, "hintEstimated": True} for line in fetched.plain_lines]

    print(f"  LRCLIB match: {fetched.meta.artist} — {fetched.meta.title} ({len(timed)} lines)")
    return timed, {
        "source": fetched.source,
        "artist": fetched.meta.artist,
        "title": fetched.meta.title,
        "album": fetched.meta.album,
        "lineCount": len(timed),
        "synced": fetched.synced,
    }


def _asr_words(
    out_dir: Path,
    stem_paths: dict[str, Path],
    envelopes: dict,
    *,
    model_size: str,
    device: str,
    force: bool,
) -> list[dict]:
    """faster-whisper word timestamps on the vocal stem (cached in transcript.json)."""
    transcript_path = out_dir / "transcript.json"
    if transcript_path.exists() and not force:
        words = json.loads(transcript_path.read_text(encoding="utf-8")).get("words", [])
    else:
        words = transcribe_vocals(stem_paths["vocals"], model_size=model_size, device=device)
        write_transcript(out_dir, words)
    words = refine_transcript_words(words, envelopes, vocals_path=stem_paths["vocals"])
    write_transcript(out_dir, words)
    return words


def _forced_schedule(
    timed_lines: list[dict],
    stem_paths: dict[str, Path],
    envelopes: dict,
    *,
    device: str,
    onset_lead: float,
    anchor: str,
    duration: float,
    model_size: str,
    force: bool,
    out_dir: Path,
) -> list[dict]:
    """Forced alignment, optionally anchored per-line by whisper segments."""
    from pipeline.align import _tokenize
    from pipeline.forced_align import (
        asr_anchor_word_times,
        build_forced_schedule,
        windows_from_word_times,
    )

    line_windows = None
    if anchor == "whisper":
        asr = _asr_words(
            out_dir, stem_paths, envelopes, model_size=model_size, device=device, force=force
        )
        flat_tokens: list[str] = []
        owner: list[tuple[int, int]] = []
        for li, line in enumerate(timed_lines):
            for wi, tok in enumerate(_tokenize(line.get("text", ""))):
                flat_tokens.append(tok)
                owner.append((li, wi))
        word_times = asr_anchor_word_times(flat_tokens, asr, duration)
        line_windows = windows_from_word_times(
            word_times, owner, len(timed_lines), duration
        )

    return build_forced_schedule(
        timed_lines,
        stem_paths["vocals"],
        device=device,
        onset_lead=onset_lead,
        line_windows=line_windows,
    )


def _whisper_schedule(
    timed_lines: list[dict],
    out_dir: Path,
    stem_paths: dict[str, Path],
    envelopes: dict,
    *,
    model_size: str,
    device: str,
    force: bool,
) -> list[dict]:
    words = _asr_words(
        out_dir, stem_paths, envelopes, model_size=model_size, device=device, force=force
    )
    schedule = build_schedule(timed_lines, words, envelopes=envelopes)
    return refine_word_schedule(schedule, envelopes, vocals_path=stem_paths["vocals"])


def _build_background_cmd(args: argparse.Namespace, audio_path: Path) -> list[str]:
    cmd = [sys.executable, str(Path(__file__).resolve()), str(audio_path)]
    if args.lyrics:
        cmd += ["--lyrics", str(args.lyrics.resolve())]
    if args.artist:
        cmd += ["--artist", args.artist]
    if args.title:
        cmd += ["--title", args.title]
    if args.model != "base.en":
        cmd += ["--model", args.model]
    if args.device != "cpu":
        cmd += ["--device", args.device]
    if args.align != "forced":
        cmd += ["--align", args.align]
    if args.anchor != "whisper":
        cmd += ["--anchor", args.anchor]
    if args.lyric_lead != 0.02:
        cmd += ["--lyric-lead", str(args.lyric_lead)]
    if args.force:
        cmd.append("--force")
    return cmd


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a .analysis sidecar pack for Reel Studio")
    parser.add_argument("audio", type=Path, help="Path to song.mp3 (or other audio)")
    parser.add_argument("--lyrics", type=Path, help="Optional plain .txt or .lrc lyrics (auto-fetched if omitted)")
    parser.add_argument("--artist", help="Track artist for LRCLIB lookup")
    parser.add_argument("--title", help="Track title for LRCLIB lookup")
    parser.add_argument("--model", default="base.en", help="faster-whisper model (whisper/hybrid fallback)")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"], help="Torch/Demucs device")
    parser.add_argument(
        "--align",
        default="forced",
        choices=["forced", "whisper", "hybrid"],
        help="Word-timing strategy (default: forced)",
    )
    parser.add_argument(
        "--lyric-lead",
        type=float,
        default=0.02,
        dest="lyric_lead",
        help="Seconds to nudge forced-aligned onsets (default: 0.02)",
    )
    parser.add_argument(
        "--anchor",
        default="whisper",
        choices=["whisper", "none"],
        help="Forced-align anchoring: 'whisper' windows each line by ASR (robust on long "
        "songs, default); 'none' runs one global pass (best for short clips).",
    )
    parser.add_argument("--force", action="store_true", help="Re-run even if manifest exists")
    parser.add_argument(
        "--background",
        action="store_true",
        help="Run analysis in a detached background process and print the output path",
    )
    args = parser.parse_args()

    audio_path = args.audio.resolve()
    if not audio_path.exists():
        print(f"Audio not found: {audio_path}", file=sys.stderr)
        return 1

    out_dir = sidecar_dir_for(audio_path)

    if args.background:
        out_dir.mkdir(parents=True, exist_ok=True)
        log_path = out_dir / "analysis.log"
        cmd = _build_background_cmd(args, audio_path)
        with log_path.open("w", encoding="utf-8") as log:
            proc = subprocess.Popen(
                cmd,
                cwd=str(Path(__file__).resolve().parent),
                stdout=log,
                stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
            )
        print(json.dumps({"ok": True, "background": True, "pid": proc.pid, "outDir": str(out_dir), "log": str(log_path)}, indent=2))
        return 0

    out_dir.mkdir(parents=True, exist_ok=True)

    if is_cache_valid(out_dir, args.force):
        print(f"Using cached analysis pack: {out_dir}")
        manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
        print(json.dumps({"ok": True, "cached": True, "outDir": str(out_dir), "bpm": manifest.get("bpm")}, indent=2))
        return 0

    duration = _audio_duration(audio_path)

    print("Step 1/4: Demucs htdemucs separation…")
    stem_paths = separate(audio_path, out_dir, device=args.device)

    print("Step 2/4: Stem envelope extraction…")
    envelopes_path = write_envelopes(out_dir, stem_paths)
    envelopes = json.loads(envelopes_path.read_text(encoding="utf-8"))

    lyrics_info: dict[str, object] | None = None
    word_schedule_path = None
    schedule_refined = False
    align_method = None
    try:
        timed_lines, lyrics_info = _resolve_lyrics(
            audio_path,
            lyrics_path=args.lyrics,
            artist=args.artist,
            title=args.title,
            duration=duration,
        )

        schedule: list[dict] | None = None
        if args.align in ("forced", "hybrid"):
            try:
                anchor_note = "whisper-anchored" if args.anchor == "whisper" else "global"
                print(f"Step 3/4: CTC forced alignment (torchaudio MMS_FA, {anchor_note})…")
                schedule = _forced_schedule(
                    timed_lines,
                    stem_paths,
                    envelopes,
                    device=args.device,
                    onset_lead=args.lyric_lead,
                    anchor=args.anchor,
                    duration=duration,
                    model_size=args.model,
                    force=args.force,
                    out_dir=out_dir,
                )
                align_method = "forced"
            except Exception as err:  # noqa: BLE001 - fall back to whisper on any failure
                print(f"  Forced alignment failed ({err}); falling back to whisper.")
                schedule = None

        if schedule is None:
            print("Step 3/4: faster-whisper ASR + DTW lyric alignment…")
            schedule = _whisper_schedule(
                timed_lines,
                out_dir,
                stem_paths,
                envelopes,
                model_size=args.model,
                device=args.device,
                force=args.force,
            )
            align_method = "whisper"

        word_schedule_path = write_word_schedule(out_dir, schedule)
        schedule_refined = True
    except (FileNotFoundError, RuntimeError) as err:
        print(f"Step 3/4: Skipping lyric alignment ({err})")

    print("Step 4/4: Song profile + manifest…")
    profile = analyze_profile(audio_path, envelopes)

    paths = {
        "stems": {
            "vocals": "stems/vocals.wav",
            "drums": "stems/drums.wav",
            "bass": "stems/bass.wav",
            "other": "stems/other.wav",
        },
        "envelopes": "envelopes.json",
    }
    if (out_dir / "transcript.json").exists():
        paths["transcript"] = "transcript.json"
    if word_schedule_path:
        paths["word_schedule"] = "word_schedule.json"

    if lyrics_info is not None and align_method:
        lyrics_info["alignMethod"] = align_method

    manifest = build_manifest(
        source_file=audio_path.name,
        duration=profile["duration"],
        bpm=profile["bpm"],
        profile=profile,
        paths=paths,
        lyrics=lyrics_info,
        schedule_refined=schedule_refined,
    )
    write_manifest(out_dir, manifest)

    print(json.dumps({"ok": True, "cached": False, "outDir": str(out_dir), "bpm": profile["bpm"], "align": align_method}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
