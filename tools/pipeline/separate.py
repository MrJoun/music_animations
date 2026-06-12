"""Demucs htdemucs 4-stem separation."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path


STEM_NAMES = ("vocals", "drums", "bass", "other")


def separate_stems(audio_path: Path, out_dir: Path, device: str = "cpu", **_kwargs) -> dict[str, Path]:
    """Run htdemucs and copy stems into out_dir/stems/."""
    stems_dir = out_dir / "stems"
    stems_dir.mkdir(parents=True, exist_ok=True)

    expected = {name: stems_dir / f"{name}.wav" for name in STEM_NAMES}
    if all(path.exists() for path in expected.values()):
        return expected

    tmp_out = out_dir / "_demucs_tmp"
    if tmp_out.exists():
        shutil.rmtree(tmp_out, ignore_errors=True)

    cmd = [
        sys.executable,
        "-m",
        "demucs",
        "-n",
        "htdemucs",
        "-d",
        device,
        "-o",
        str(tmp_out),
        str(audio_path),
    ]
    subprocess.run(cmd, check=True)

    src = tmp_out / "htdemucs" / audio_path.stem
    if not src.exists():
        candidates = list((tmp_out / "htdemucs").glob("*"))
        if len(candidates) == 1 and candidates[0].is_dir():
            src = candidates[0]
        else:
            raise FileNotFoundError(f"Demucs output not found under {tmp_out / 'htdemucs'}")

    for name in STEM_NAMES:
        shutil.copy2(src / f"{name}.wav", expected[name])

    shutil.rmtree(tmp_out, ignore_errors=True)
    return expected


# Alias used by analyze_song.py
separate = separate_stems
