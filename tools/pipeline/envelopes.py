"""RMS envelope extraction per stem (25ms hop, 50ms window)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import soundfile as sf

from .manifest import HOP_SEC


def _rms_envelope(samples: np.ndarray, sample_rate: int) -> tuple[list[float], list[float]]:
    hop = max(1, int(sample_rate * HOP_SEC))
    win = max(1, int(sample_rate * 0.05))
    times: list[float] = []
    values: list[float] = []

    for i in range(0, max(0, len(samples) - win), hop):
        chunk = samples[i : i + win]
        rms = float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2)))
        times.append(i / sample_rate)
        values.append(rms)

    if not values:
        return [0.0], [0.0]

    peak = max(values) or 1.0
    values = [min(1.0, v / peak * 1.15) for v in values]
    return times, values


def extract_stem_envelopes(stem_paths: dict[str, Path]) -> dict[str, list[float] | list[float]]:
    """Return {times, vocals, drums, bass, melodic} matching browser StemAnalyzer shape."""
    envelopes: dict[str, list[float]] = {}
    times: list[float] = []

    for key, path_key in (
        ("vocals", "vocals"),
        ("drums", "drums"),
        ("bass", "bass"),
        ("melodic", "other"),
    ):
        data, sr = sf.read(stem_paths[path_key], always_2d=False)
        if data.ndim > 1:
            data = data.mean(axis=1)
        t, v = _rms_envelope(np.asarray(data, dtype=np.float32), sr)
        if not times:
            times = t
        envelopes[key] = v

    return {
        "times": times,
        "vocals": envelopes["vocals"],
        "drums": envelopes["drums"],
        "bass": envelopes["bass"],
        "melodic": envelopes["melodic"],
    }


def write_envelopes(out_dir: Path, stem_paths: dict[str, Path]) -> Path:
    data = extract_stem_envelopes(stem_paths)
    path = out_dir / "envelopes.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path
