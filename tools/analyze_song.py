#!/usr/bin/env python3
"""Reel Studio offline analysis CLI — thin wrapper over pipeline.run.run_pipeline.

Demucs stems + forced-aligned lyrics + tempo/key/energy/mood/genre insights + animation
blueprint, written to an ``Artist - Title.analysis`` sidecar pack.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from pipeline.manifest import is_cache_valid, sidecar_dir_for
from pipeline.run import run_pipeline


def _build_background_cmd(args, audio_path: Path) -> list[str]:
    cmd = [sys.executable, str(Path(__file__).resolve()), str(audio_path)]
    if args.lyrics:
        cmd += ["--lyrics", str(Path(args.lyrics).resolve())]
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
    if args.anchor != "auto":
        cmd += ["--anchor", args.anchor]
    if args.lyric_lead != 0.02:
        cmd += ["--lyric-lead", str(args.lyric_lead)]
    if args.no_insights:
        cmd += ["--no-insights"]
    if args.force:
        cmd.append("--force")
    return cmd


def main() -> int:
    p = argparse.ArgumentParser(description="Build a .analysis sidecar pack for Reel Studio")
    p.add_argument("audio", type=Path)
    p.add_argument("--lyrics", type=Path, help="Optional .txt/.lrc lyrics (else LRCLIB auto-fetch)")
    p.add_argument("--artist")
    p.add_argument("--title")
    p.add_argument("--model", default="base.en", help="faster-whisper model (whisper/anchor fallback)")
    p.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    p.add_argument("--align", default="forced", choices=["forced", "whisper", "hybrid"])
    p.add_argument("--anchor", default="auto", choices=["auto", "lrc", "whisper", "none"])
    p.add_argument("--lyric-lead", type=float, default=0.02, dest="lyric_lead")
    p.add_argument("--no-insights", action="store_true", help="Skip genre/mood/key + animation blueprint")
    p.add_argument("--force", action="store_true")
    p.add_argument("--background", action="store_true")
    args = p.parse_args()

    audio_path = args.audio.resolve()
    if not audio_path.exists():
        print(f"Audio not found: {audio_path}", file=sys.stderr)
        return 1

    out_dir = sidecar_dir_for(audio_path)

    if args.background:
        out_dir.mkdir(parents=True, exist_ok=True)
        log_path = out_dir / "analysis.log"
        with log_path.open("w", encoding="utf-8") as log:
            proc = subprocess.Popen(
                _build_background_cmd(args, audio_path),
                cwd=str(Path(__file__).resolve().parent), stdout=log, stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
            )
        print(json.dumps({"ok": True, "background": True, "pid": proc.pid, "outDir": str(out_dir), "log": str(log_path)}, indent=2))
        return 0

    if is_cache_valid(out_dir, args.force):
        manifest = json.loads((out_dir / "manifest.json").read_text())
        print(json.dumps({"ok": True, "cached": True, "outDir": str(out_dir), "bpm": manifest.get("bpm")}, indent=2))
        return 0

    def progress(step, frac, msg):
        print(f"[{int(frac*100):3d}%] {step}: {msg}")

    manifest = run_pipeline(
        audio_path, out_dir=out_dir, lyrics_path=args.lyrics, artist=args.artist, title=args.title,
        device=args.device, align=args.align, anchor=args.anchor, model=args.model,
        lyric_lead=args.lyric_lead, with_insights=not args.no_insights, progress=progress,
    )
    print(json.dumps({"ok": True, "outDir": str(out_dir), "bpm": manifest.get("bpm"),
                      "animation": manifest.get("animation", {}).get("prompt")}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
