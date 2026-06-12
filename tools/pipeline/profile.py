"""Song profile extraction via librosa — mirrors browser song-analyzer fields."""

from __future__ import annotations

import numpy as np

try:
    import librosa
except ImportError:  # pragma: no cover
    librosa = None


def _classify_mood(m: dict) -> tuple[str, float, dict[str, float]]:
    scores = {"aggressive": 0.0, "dance": 0.0, "chill": 0.0, "melodic": 0.0, "balanced": 0.0}

    bpm = m["bpm"]
    if 65 <= bpm <= 108:
        scores["chill"] += 4
    if 70 <= bpm <= 115:
        scores["melodic"] += 3
    if m["avg_energy"] < 0.4:
        scores["chill"] += 3
    if m["avg_energy"] < 0.45 and bpm < 118:
        scores["melodic"] += 2
    if m["onset_density"] < 0.42:
        scores["chill"] += 3
    if m["onset_density"] < 0.5:
        scores["melodic"] += 2
    if m["drop_count"] <= 1:
        scores["chill"] += 3
    if m["drop_count"] <= 2:
        scores["melodic"] += 1
    if m["energy_variance"] < 0.2:
        scores["chill"] += 3
    if m["energy_variance"] < 0.28:
        scores["melodic"] += 2
    if m["transient_score"] < 0.35:
        scores["chill"] += 2
    if m["bass_weight"] > 0.44 and bpm < 112:
        scores["melodic"] += 3

    if bpm >= 138:
        scores["aggressive"] += 4
    elif bpm >= 128:
        scores["aggressive"] += 2
    elif bpm >= 120:
        scores["dance"] += 2

    if m["drop_count"] >= 3:
        scores["aggressive"] += 3
    elif m["drop_count"] >= 2 and bpm >= 125:
        scores["aggressive"] += 2

    if m["energy_variance"] > 0.32:
        scores["aggressive"] += 3
    elif m["energy_variance"] > 0.24:
        scores["dance"] += 2

    if m["transient_score"] > 0.55:
        scores["aggressive"] += 3
    elif m["transient_score"] > 0.4:
        scores["dance"] += 2

    if m["onset_density"] > 0.55 and bpm >= 125:
        scores["aggressive"] += 2
    if m["avg_energy"] > 0.42 and bpm >= 122:
        scores["dance"] += 2

    if bpm >= 128 and m["bass_weight"] > 0.55 and m["energy_variance"] > 0.22:
        scores["aggressive"] += 2

    mood = "balanced"
    best = scores["balanced"]
    for name, score in scores.items():
        if score > best:
            best = score
            mood = name
    if best < 3:
        mood = "balanced"

    intensity = min(1.0, max(0.15, m["avg_energy"] * 0.55 + m["onset_density"] * 0.25 + m["energy_variance"] * 0.2))
    return mood, intensity, scores


def _detect_sections(times: list[float], rms: list[float], duration: float, drop_times: list[float], avg_rms: float):
    if not rms:
        return [{"start": 0.0, "end": duration, "type": "full", "energy": 0.5}]

    win = 5
    smooth = []
    for i in range(len(rms)):
        lo = max(0, i - win)
        hi = min(len(rms), i + win + 1)
        smooth.append(sum(rms[lo:hi]) / (hi - lo))

    threshold = avg_rms * 1.12
    segments = []
    seg_start = 0
    current = "intro"

    def label_at(i: int) -> str:
        e = smooth[i]
        t = times[i]
        near_drop = any(abs(d - t) < 1.5 for d in drop_times)
        if near_drop:
            return "drop"
        if e > threshold * 1.25:
            return "chorus"
        if e > threshold:
            return "build"
        if t < duration * 0.12:
            return "intro"
        return "verse"

    current = label_at(0)
    for i in range(1, len(smooth)):
        label = label_at(i)
        if label != current and i - seg_start >= 4:
            start_t = times[seg_start]
            end_t = times[i]
            if end_t - start_t >= 2:
                energy = sum(smooth[seg_start:i]) / max(1, i - seg_start)
                segments.append({"start": start_t, "end": end_t, "type": current, "energy": energy})
            seg_start = i
            current = label

    segments.append(
        {
            "start": times[seg_start],
            "end": duration,
            "type": current,
            "energy": sum(smooth[seg_start:]) / max(1, len(smooth) - seg_start),
        }
    )

    if len(segments) <= 1:
        return segments

    out = [segments[0]]
    for seg in segments[1:]:
        prev = out[-1]
        if seg["end"] - seg["start"] < 3:
            prev["end"] = seg["end"]
            prev["energy"] = (prev["energy"] + seg["energy"]) / 2
        else:
            out.append(seg)
    return out


def _dominant_stem(envelopes: dict) -> str:
    keys = ("vocals", "bass", "drums", "melodic")
    totals = {k: sum(envelopes.get(k, [])) for k in keys}
    return max(totals, key=totals.get)


def _tag_sections(sections: list[dict], envelopes: dict) -> list[dict]:
    tagged = []
    times = envelopes.get("times", [])
    for sec in sections:
        mix = {k: 0.0 for k in ("vocals", "bass", "drums", "melodic")}
        n = 0
        for i, t in enumerate(times):
            if t < sec["start"] or t >= sec["end"]:
                continue
            for k in mix:
                arr = envelopes.get(k, [])
                if i < len(arr):
                    mix[k] += arr[i]
            n += 1
        if n:
            for k in mix:
                mix[k] /= n
        dominant = max(mix, key=mix.get)
        tagged.append({**sec, "dominantStem": dominant, "stemMix": mix})
    return tagged


def analyze_profile(audio_path, envelopes: dict) -> dict:
    if librosa is None:
        raise ImportError("librosa is required for profile analysis")

    y, sr = librosa.load(str(audio_path), mono=True, duration=None)
    duration = float(librosa.get_duration(y=y, sr=sr))

    hop = max(1, int(sr * 0.025))
    win = max(1, int(sr * 0.05))
    rms = []
    bass_ratio = []
    times = []

    for i in range(0, max(0, len(y) - win), hop):
        chunk = y[i : i + win]
        rms_val = float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2)))
        quarter = max(1, win // 4)
        low = float(np.mean(np.abs(chunk[:quarter])))
        high = float(np.mean(np.abs(chunk[quarter:])))
        rms.append(rms_val)
        bass_ratio.append(low / (low + high + 1e-6))
        times.append(i / sr)

    avg_rms = sum(rms) / max(len(rms), 1)
    var_sum = sum((r - avg_rms) ** 2 for r in rms)
    energy_variance = min(1.0, (var_sum / max(len(rms), 1)) ** 0.5 / (avg_rms + 1e-6))

    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=hop)
    tempo_val = float(np.asarray(tempo).flat[0]) if np.ndim(tempo) else float(tempo)
    bpm = int(round(tempo_val))
    bpm = max(60, min(190, bpm or 100))
    beat_times = [float(t) for t in librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop)]

    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    peaks = librosa.util.peak_pick(onset_env, pre_max=3, post_max=3, pre_avg=3, post_avg=3, delta=0.5, wait=5)
    onset_density = min(1.0, len(peaks) / max(duration / 3, 1))

    drop_times = []
    window_frames = max(1, int(0.5 / 0.025))
    for i in range(window_frames, len(rms)):
        past = rms[i - window_frames]
        cur = rms[i]
        if past > avg_rms * 0.55 and cur > past * 1.85 and cur > avg_rms * 1.55:
            t = times[i]
            if not drop_times or t - drop_times[-1] > 4:
                drop_times.append(t)

    transient_hits = 0
    for i in range(2, len(rms)):
        if rms[i] > rms[i - 1] * 1.6 and rms[i] > avg_rms * 1.4:
            transient_hits += 1
    transient_score = min(1.0, transient_hits / max(len(rms) * 0.02, 1))

    avg_energy = min(1.0, avg_rms * 7)
    bass_weight = sum(bass_ratio) / max(len(bass_ratio), 1)

    vocal_sum = sustain_sum = 0
    for i in range(1, len(rms)):
        delta = abs(rms[i] - rms[i - 1])
        midish = rms[i] * (1 - bass_ratio[i] * 0.5)
        vocal_sum += midish
        if delta < avg_rms * 0.15:
            sustain_sum += 1
    vocal_presence = min(1.0, (vocal_sum / max(len(rms), 1)) * 12)
    sustain_ratio = sustain_sum / max(len(rms), 1)
    percussive = min(1.0, transient_score * 1.1)
    electronic = min(1.0, bass_weight * 0.5 + transient_score * 0.35 + (1 - sustain_ratio) * 0.3)
    melodic_inst = min(1.0, sustain_ratio * 0.6 + vocal_presence * 0.4)

    instruments = {
        "vocal": vocal_presence,
        "bass": bass_weight,
        "percussive": percussive,
        "electronic": electronic,
        "melodic": melodic_inst,
    }

    sections = _detect_sections(times, rms, duration, drop_times, avg_rms)
    sections = _tag_sections(sections, envelopes)

    mood, detected_intensity, mood_scores = _classify_mood(
        {
            "bpm": bpm,
            "avg_energy": avg_energy,
            "bass_weight": bass_weight,
            "drop_count": len(drop_times),
            "onset_density": onset_density,
            "energy_variance": energy_variance,
            "transient_score": transient_score,
        }
    )

    if not beat_times:
        beat_interval = 60 / bpm
        beat_times = [t for t in np.arange(0, duration, beat_interval)]

    return {
        "bpm": bpm,
        "mood": mood,
        "avgEnergy": round(avg_energy, 4),
        "bassWeight": round(bass_weight, 4),
        "dropCount": len(drop_times),
        "dropTimes": [round(t, 3) for t in drop_times],
        "beatTimes": [round(t, 3) for t in beat_times],
        "onsetDensity": round(onset_density, 4),
        "energyVariance": round(energy_variance, 4),
        "transientScore": round(transient_score, 4),
        "duration": round(duration, 3),
        "detectedIntensity": round(detected_intensity, 4),
        "moodScores": {k: round(v, 2) for k, v in mood_scores.items()},
        "instruments": {k: round(v, 4) for k, v in instruments.items()},
        "sections": sections,
        "rms": [round(v, 5) for v in rms],
        "times": [round(t, 3) for t in times],
        "avgRms": round(avg_rms, 5),
        "dominantStem": _dominant_stem(envelopes),
        "sectionCount": len(sections),
    }
