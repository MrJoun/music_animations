#!/usr/bin/env python3

"""Reel Studio offline analysis: Demucs stems + faster-whisper + sidecar manifest."""



from __future__ import annotations



import argparse

import json

import subprocess

import sys

from pathlib import Path



from pipeline.align import build_schedule, parse_lyrics_file, parse_lyrics_text, write_word_schedule

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





def main() -> int:

    parser = argparse.ArgumentParser(description="Build a .analysis sidecar pack for Reel Studio")

    parser.add_argument("audio", type=Path, help="Path to song.mp3 (or other audio)")

    parser.add_argument("--lyrics", type=Path, help="Optional plain .txt or .lrc lyrics (auto-fetched if omitted)")

    parser.add_argument("--artist", help="Track artist for LRCLIB lookup")

    parser.add_argument("--title", help="Track title for LRCLIB lookup")

    parser.add_argument("--model", default="base.en", help="faster-whisper model (default: base.en)")

    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"], help="Torch/Demucs device")

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

        cmd = [sys.executable, str(Path(__file__).resolve()), str(audio_path)]

        if args.lyrics:

            cmd.extend(["--lyrics", str(args.lyrics.resolve())])

        if args.artist:

            cmd.extend(["--artist", args.artist])

        if args.title:

            cmd.extend(["--title", args.title])

        if args.model != "base.en":

            cmd.extend(["--model", args.model])

        if args.device != "cpu":

            cmd.extend(["--device", args.device])

        if args.force:

            cmd.append("--force")

        with log_path.open("w", encoding="utf-8") as log:

            proc = subprocess.Popen(

                cmd,

                cwd=str(Path(__file__).resolve().parent),

                stdout=log,

                stderr=subprocess.STDOUT,

                creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),

            )

        print(

            json.dumps(

                {

                    "ok": True,

                    "background": True,

                    "pid": proc.pid,

                    "outDir": str(out_dir),

                    "log": str(log_path),

                },

                indent=2,

            )

        )

        return 0



    out_dir.mkdir(parents=True, exist_ok=True)



    if is_cache_valid(out_dir, args.force):

        print(f"Using cached analysis pack: {out_dir}")

        manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))

        print(json.dumps({"ok": True, "cached": True, "outDir": str(out_dir), "bpm": manifest.get("bpm")}, indent=2))

        return 0



    duration = _audio_duration(audio_path)



    print("Step 1/5: Demucs htdemucs separation…")

    stem_paths = separate(audio_path, out_dir, device=args.device)



    print("Step 2/5: Stem envelope extraction…")

    envelopes_path = write_envelopes(out_dir, stem_paths)

    envelopes = json.loads(envelopes_path.read_text(encoding="utf-8"))



    print("Step 3/5: faster-whisper on vocal stem…")

    transcript_path = out_dir / "transcript.json"

    if transcript_path.exists() and not args.force:

        transcript = json.loads(transcript_path.read_text(encoding="utf-8"))

        words = transcript.get("words", [])

    else:

        words = transcribe_vocals(

            stem_paths["vocals"],

            model_size=args.model,

            device=args.device,

        )

        write_transcript(out_dir, words)



    words = refine_transcript_words(words, envelopes, vocals_path=stem_paths["vocals"])

    write_transcript(out_dir, words)



    lyrics_info: dict[str, object] | None = None

    word_schedule_path = None

    schedule_refined = False

    try:

        timed_lines, lyrics_info = _resolve_lyrics(

            audio_path,

            lyrics_path=args.lyrics,

            artist=args.artist,

            title=args.title,

            duration=duration,

        )

        print("Step 4/5: DTW lyric alignment…")

        schedule = build_schedule(timed_lines, words, envelopes=envelopes)

        schedule = refine_word_schedule(schedule, envelopes, vocals_path=stem_paths["vocals"])

        word_schedule_path = write_word_schedule(out_dir, schedule)

        schedule_refined = True

    except (FileNotFoundError, RuntimeError) as err:

        print(f"Step 4/5: Skipping lyric alignment ({err})")



    print("Step 5/5: Song profile + manifest…")

    profile = analyze_profile(audio_path, envelopes)



    paths = {

        "stems": {

            "vocals": "stems/vocals.wav",

            "drums": "stems/drums.wav",

            "bass": "stems/bass.wav",

            "other": "stems/other.wav",

        },

        "envelopes": "envelopes.json",

        "transcript": "transcript.json",

    }

    if word_schedule_path:

        paths["word_schedule"] = "word_schedule.json"



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



    print(json.dumps({"ok": True, "cached": False, "outDir": str(out_dir), "bpm": profile["bpm"]}, indent=2))

    return 0





if __name__ == "__main__":

    raise SystemExit(main())

