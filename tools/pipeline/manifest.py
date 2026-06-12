"""manifest.json v1 schema and writer."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MANIFEST_VERSION = 1
HOP_SEC = 0.025


def sidecar_dir_for(audio_path: Path) -> Path:
    return audio_path.parent / f"{audio_path.stem}.analysis"


def manifest_path_for(audio_path: Path) -> Path:
    return sidecar_dir_for(audio_path) / "manifest.json"


def build_manifest(
    *,
    source_file: str,
    duration: float,
    bpm: int,
    profile: dict[str, Any],
    paths: dict[str, Any],
    lyrics: dict[str, Any] | None = None,
    schedule_refined: bool = False,
) -> dict[str, Any]:
    manifest: dict[str, Any] = {
        "version": MANIFEST_VERSION,
        "sourceFile": source_file,
        "duration": round(duration, 3),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "bpm": bpm,
        "hopSec": HOP_SEC,
        "profile": profile,
        "paths": paths,
    }
    if schedule_refined:
        manifest["scheduleRefined"] = True
    if lyrics:
        manifest["lyrics"] = lyrics
    return manifest


def write_manifest(out_dir: Path, manifest: dict[str, Any]) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return path


def load_manifest(out_dir: Path) -> dict[str, Any] | None:
    path = out_dir / "manifest.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("version") != MANIFEST_VERSION:
        raise ValueError(f"Unsupported manifest version: {data.get('version')}")
    return data


def is_cache_valid(out_dir: Path, force: bool) -> bool:
    if force:
        return False
    try:
        manifest = load_manifest(out_dir)
    except (json.JSONDecodeError, ValueError):
        return False
    if not manifest:
        return False
    stems = out_dir / "stems"
    for stem in ("vocals", "drums", "bass", "other"):
        if not (stems / f"{stem}.wav").exists():
            return False
    if not (out_dir / "envelopes.json").exists():
        return False
    return True
