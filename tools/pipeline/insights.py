"""Musical insights + animation blueprint for a song.

Turns a track (+ its Demucs stems + envelopes + base profile) into the rich, song-specific
metadata the visualizer uses to tailor itself: key, tempo, energy, brightness,
danceability, a valence/arousal mood, genre/mood/instrument tags (PANNs AudioSet), and an
``animation`` blueprint (preset, theme/palette, intensity, motion + a text prompt).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

try:
    import librosa
except ImportError:  # pragma: no cover
    librosa = None

# Krumhansl-Schmuckle key profiles.
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
_NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# AudioSet label groups (PANNs). Curated subsets that matter for visuals.
_GENRE = {
    "Pop music", "Rock music", "Hip hop music", "Rhythm and blues", "Soul music",
    "Reggae", "Funk", "Disco", "Electronic music", "Techno", "House music",
    "Trance music", "Dubstep", "Drum and bass", "Jazz", "Blues", "Classical music",
    "Country", "Folk music", "Heavy metal", "Punk rock", "Ambient music",
    "Dance music", "Trap music", "Gospel music", "Salsa music", "Ska", "Grime music",
    "Electronica", "Electronic dance music", "Progressive rock", "Rock and roll",
    "Psychedelic rock", "New-age music", "Indie rock",
}
_MOOD = {
    "Happy music", "Funny music", "Sad music", "Tender music", "Exciting music",
    "Angry music", "Scary music", "Soothing music",
}
_INSTRUMENT = {
    "Singing", "Male singing", "Female singing", "Rapping", "Guitar",
    "Electric guitar", "Acoustic guitar", "Bass guitar", "Piano", "Keyboard (musical)",
    "Synthesizer", "Drum kit", "Drum machine", "Violin, fiddle", "Trumpet",
    "Saxophone", "Strings", "Organ", "Brass instrument", "Hi-hat", "Snare drum",
}


def _estimate_key(y: np.ndarray, sr: int) -> dict:
    if librosa is None or y.size == 0:
        return {"key": "?", "mode": "?", "confidence": 0.0}
    y_h = librosa.effects.harmonic(y)
    chroma = librosa.feature.chroma_cqt(y=y_h, sr=sr).mean(axis=1)
    if chroma.sum() <= 0:
        return {"key": "?", "mode": "?", "confidence": 0.0}
    chroma = chroma / chroma.sum()
    best = (-1.0, 0, "major")
    for i in range(12):
        maj = float(np.corrcoef(np.roll(_MAJOR, i), chroma)[0, 1])
        minr = float(np.corrcoef(np.roll(_MINOR, i), chroma)[0, 1])
        if maj > best[0]:
            best = (maj, i, "major")
        if minr > best[0]:
            best = (minr, i, "minor")
    return {"key": _NOTES[best[1]], "mode": best[2], "confidence": round(max(0.0, best[0]), 3)}


def _features(y: np.ndarray, sr: int) -> dict:
    if librosa is None or y.size == 0:
        return {"brightness": 0.0, "danceability": 0.0}
    cent = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    brightness = min(1.0, cent / 4000.0)  # 0 dark .. 1 bright
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    # Danceability ~ strength + regularity of the pulse.
    if onset_env.size:
        ac = librosa.autocorrelate(onset_env, max_size=4 * sr // 512)
        ac = ac / (ac[0] + 1e-9)
        danceability = float(np.clip(np.max(ac[10:]) if ac.size > 10 else 0.0, 0, 1))
    else:
        danceability = 0.0
    return {"brightness": round(brightness, 3), "danceability": round(danceability, 3)}


def _instrumentalness(envelopes: dict) -> float:
    """0 = fully instrumental, 1 = very vocal-forward (from the Demucs vocal stem)."""
    voc = np.asarray(envelopes.get("vocals", []), dtype=float)
    others = [np.asarray(envelopes.get(k, []), dtype=float) for k in ("bass", "drums", "melodic")]
    if voc.size == 0:
        return 0.5
    voc_e = float(np.mean(voc))
    other_e = float(np.mean([np.mean(o) if o.size else 0 for o in others])) + 1e-6
    return round(float(np.clip(voc_e / (voc_e + other_e), 0, 1)), 3)


def _tag(tagger, audio_path: Path) -> dict:
    """Top PANNs AudioSet tags grouped into genre / mood / instrument."""
    if tagger is None:
        return {}
    try:
        from panns_inference import labels
        y, _ = librosa.load(str(audio_path), sr=32000, mono=True)
        out = tagger.inference(y[None, :])
        clipwise = np.asarray(out[0][0])
    except Exception:
        return {}
    order = np.argsort(clipwise)[::-1]
    genre, mood, instrument, top = [], [], [], []
    for i in order[:40]:
        name = labels[i]
        score = round(float(clipwise[i]), 3)
        if score < 0.02:
            continue
        if len(top) < 8 and name not in ("Music", "Musical instrument", "Speech"):
            top.append({"tag": name, "score": score})
        if name in _GENRE and len(genre) < 4:
            genre.append({"tag": name, "score": score})
        elif name in _MOOD and len(mood) < 3:
            mood.append({"tag": name, "score": score})
        elif name in _INSTRUMENT and len(instrument) < 5:
            instrument.append({"tag": name, "score": score})
    return {"genre": genre, "moodTags": mood, "instruments": instrument, "top": top}


def _valence_arousal(profile: dict, key_mode: str, brightness: float, danceability: float) -> dict:
    """Valence (negative..positive) / arousal (calm..intense) estimate.

    Arousal deliberately leans on tempo, onset density, danceability and dynamics rather
    than raw RMS, since modern masters saturate loudness and would make every track look
    "aggressive".
    """
    bpm = profile.get("bpm", 100)
    onset = profile.get("onsetDensity", 0.3)
    var = profile.get("energyVariance", 0.2)
    arousal = float(np.clip(
        0.12 + (bpm - 60) / 130 * 0.38 + onset * 0.25 + danceability * 0.15 + var * 0.12,
        0, 1,
    ))
    valence = float(np.clip(
        0.5 + (0.16 if key_mode == "major" else -0.16) + (brightness - 0.5) * 0.45 + (danceability - 0.4) * 0.2,
        0, 1,
    ))
    return {"valence": round(valence, 3), "arousal": round(arousal, 3)}


_THEME_BY_VIBE = {
    "neon": "high-energy / electronic / bright",
    "sunset": "warm / soul / r&b / happy",
    "candy": "playful / pop / upbeat",
    "ocean": "cool / dreamy / melancholy",
    "forest": "organic / folk / mellow",
    "mono": "minimal / moody / dark",
}


def _animation_blueprint(va: dict, brightness: float, dance: float, genre_tags: list[dict]) -> dict:
    genres = " ".join(g["tag"].lower() for g in genre_tags)
    arousal, valence = va["arousal"], va["valence"]
    electronic = any(k in genres for k in ("electronic", "techno", "house", "dubstep", "trance", "drum and bass", "trap", "dance"))

    # Theme/palette from valence + brightness + genre.
    if electronic:
        theme = "neon"
    elif valence >= 0.62 and brightness >= 0.5:
        theme = "candy" if dance >= 0.5 else "sunset"
    elif valence >= 0.55:
        theme = "sunset"
    elif valence <= 0.4 and arousal <= 0.45:
        theme = "mono"
    elif arousal <= 0.45:
        theme = "ocean"
    else:
        theme = "forest" if any(k in genres for k in ("folk", "country", "acoustic")) else "ocean"

    # Preset from arousal + genre (robust to mastering loudness).
    if arousal >= 0.72 or (electronic and arousal >= 0.6):
        preset = "storm"
    elif electronic or (dance >= 0.55 and arousal >= 0.52):
        preset = "generative"
    elif arousal <= 0.34:
        preset = "aurora"
    else:
        preset = "director"  # adaptive auto-cut, the safe default

    motion = "calm" if arousal < 0.4 else "energetic" if arousal > 0.7 else "flowing"
    return {
        "preset": preset,
        "theme": theme,
        "intensity": round(arousal, 3),
        "motion": motion,
        "themeReason": _THEME_BY_VIBE.get(theme, ""),
    }


def _prompt(meta: dict) -> str:
    ins = meta["insights"]
    prof = meta["profile"]
    anim = meta["animation"]
    g = ", ".join(t["tag"] for t in ins.get("genre", [])) or "unclassified"
    key = f"{ins['key']} {ins['mode']}" if ins.get("key") not in (None, "?") else "unknown key"
    val = ins["valence"]
    vibe = "uplifting" if val >= 0.6 else "melancholy" if val <= 0.4 else "neutral"
    energy_word = anim["motion"]
    return (
        f"{g} | {prof['bpm']} BPM, {key} | {vibe}, {energy_word} energy "
        f"({prof['mood']}). Visuals: {anim['preset']} preset, {anim['theme']} palette, "
        f"intensity {int(anim['intensity']*100)}%."
    )


def load_tagger():
    """Load the PANNs AudioSet tagger (CPU). Returns None if unavailable."""
    try:
        from panns_inference import AudioTagging

        return AudioTagging(checkpoint_path=None, device="cpu")
    except Exception:
        return None


def analyze_insights(audio_path, envelopes: dict, profile: dict, *, tagger=None) -> dict:
    if librosa is None:
        raise ImportError("librosa is required for insights")

    y, sr = librosa.load(str(audio_path), mono=True)
    key = _estimate_key(y, sr)
    feats = _features(y, sr)
    va = _valence_arousal(profile, key["mode"], feats["brightness"], feats["danceability"])
    tags = _tag(tagger, Path(audio_path))

    insights = {
        "key": key["key"],
        "mode": key["mode"],
        "keyConfidence": key["confidence"],
        "brightness": feats["brightness"],
        "danceability": feats["danceability"],
        "instrumentalness": _instrumentalness(envelopes),
        "valence": va["valence"],
        "arousal": va["arousal"],
        "genre": tags.get("genre", []),
        "moodTags": tags.get("moodTags", []),
        "instrumentTags": tags.get("instruments", []),
        "topTags": tags.get("top", []),
    }
    animation = _animation_blueprint(va, feats["brightness"], feats["danceability"], insights["genre"])
    meta = {"insights": insights, "profile": profile, "animation": animation}
    animation["prompt"] = _prompt(meta)
    return {"insights": insights, "animation": animation}
