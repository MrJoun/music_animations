class SongAnalyzer {
  constructor() {
    this.profile = null;
    this.analyzing = false;
    this.userIntensity = null;
    this._waveform = null;
  }

  get defaultProfile() {
    return this._buildProfile({
      bpm: 120,
      mood: "balanced",
      avgEnergy: 0.35,
      bassWeight: 0.4,
      dropCount: 0,
      dropTimes: [],
      beatTimes: [],
      onsetDensity: 0.4,
      energyVariance: 0.15,
      duration: 0,
      detectedIntensity: 0.5,
    });
  }

  _buildProfile(raw) {
    const tuning = this._tuneForMood(raw.mood, raw.bpm, raw.avgEnergy, raw.onsetDensity);
    return { ...raw, ...tuning };
  }

  setUserIntensity(value0to100) {
    this.userIntensity = Math.max(0, Math.min(100, value0to100));
    if (this.profile) {
      this._applyIntensityToProfile(this.profile);
    }
  }

  getEffectiveIntensity() {
    if (this.userIntensity != null) return this.userIntensity / 100;
    if (this.profile?.detectedIntensity != null) return this.profile.detectedIntensity;
    return 0.5;
  }

  _applyIntensityToProfile(profile) {
    const i = this.getEffectiveIntensity();
    const base = profile._baseMotion || profile.motionIntensity;
    const baseDur = profile._baseSceneDuration || profile.sceneDuration;

    profile.motionIntensity = base * (0.55 + i * 0.9);
    profile.sceneDuration = baseDur * (1.35 - i * 0.45);
    profile.transitionSec = (profile._baseTransitionSec || profile.transitionSec) * (1.2 - i * 0.35);

    profile.revival = i >= 0.55 && (profile.mood === "aggressive" || profile.mood === "dance");
    profile.subtleRevival = i >= 0.35 && i < 0.55 && profile.mood !== "chill";
    profile.intensity = i;
  }

  async decodeForPlayback(audioEngine, file, onProgress) {
    await audioEngine.init();
    onProgress?.(0.05, "Decoding audio…");
    const arrayBuffer = await file.arrayBuffer();
    const buffer = await audioEngine.context.decodeAudioData(arrayBuffer.slice(0));
    const data = buffer.getChannelData(0);
    this._waveform = { samples: data, sampleRate: buffer.sampleRate, duration: buffer.duration };
    onProgress?.(1, "Audio decoded");
    return buffer.duration;
  }

  importAnalysisPack(pack) {
    const manifest = pack.manifest || {};
    const profileData = manifest.profile || {};
    const envelopes = pack.envelopes;

    const stems = envelopes
      ? {
          times: envelopes.times,
          vocals: envelopes.vocals,
          bass: envelopes.bass,
          drums: envelopes.drums,
          melodic: envelopes.melodic,
        }
      : profileData.stems || null;

    const avgVocal = stems?.vocals?.length
      ? stems.vocals.reduce((a, b) => a + b, 0) / stems.vocals.length
      : 0.2;
    const vocalOnsets = stems
      ? this._extractVocalOnsets(stems.vocals, stems.times, avgVocal)
      : [];

    let sections = profileData.sections || [];
    if (stems && sections.length && sections[0].dominantStem == null) {
      sections = StemAnalyzer.tagSections(sections, stems);
    }

    const avgRms =
      profileData.avgRms ??
      (stems?.vocals?.length
        ? stems.vocals.reduce((a, b) => a + b, 0) / stems.vocals.length
        : 0.35);

    this._analysisExtras = {
      rms: profileData.rms?.length ? profileData.rms : stems?.vocals || [],
      times: stems?.times || profileData.times || [],
      avgRms,
      sections,
      instruments: profileData.instruments || {},
      vocalOnsets,
      stems,
    };

    const classified = this._classifyMood({
      bpm: manifest.bpm ?? profileData.bpm ?? 120,
      avgEnergy: profileData.avgEnergy ?? 0.35,
      bassWeight: profileData.bassWeight ?? 0.4,
      dropCount: profileData.dropCount ?? profileData.dropTimes?.length ?? 0,
      onsetDensity: profileData.onsetDensity ?? 0.4,
      energyVariance: profileData.energyVariance ?? 0.15,
      transientScore: profileData.transientScore ?? 0.3,
      duration: manifest.duration ?? profileData.duration ?? 0,
    });

    const mood = profileData.mood || classified.mood;
    const detectedIntensity = profileData.detectedIntensity ?? classified.intensity;

    this.profile = this._buildProfile({
      bpm: manifest.bpm ?? profileData.bpm ?? 120,
      mood,
      avgEnergy: profileData.avgEnergy ?? 0.35,
      bassWeight: profileData.bassWeight ?? 0.4,
      dropCount: profileData.dropCount ?? profileData.dropTimes?.length ?? 0,
      dropTimes: profileData.dropTimes || [],
      beatTimes: profileData.beatTimes || [],
      onsetDensity: profileData.onsetDensity ?? 0.4,
      energyVariance: profileData.energyVariance ?? 0.15,
      transientScore: profileData.transientScore ?? 0.3,
      duration: manifest.duration ?? profileData.duration ?? 0,
      detectedIntensity,
      moodScores: profileData.moodScores || classified.scores,
      instruments: profileData.instruments || {},
      sections,
      stems,
      dominantStem:
        profileData.dominantStem ||
        (stems ? StemAnalyzer.globalDominant(stems) : "melodic"),
    });

    this.profile._baseMotion = this.profile.motionIntensity;
    this.profile._baseSceneDuration = this.profile.sceneDuration;
    this.profile._baseTransitionSec = this.profile.transitionSec;

    this.userIntensity = Math.round(detectedIntensity * 100);
    this._applyIntensityToProfile(this.profile);
    this._packLoaded = true;
    this._fromAnalysisPack = true;
    return this.profile;
  }

  hasLocalPack() {
    return !!this._packLoaded;
  }

  usedAnalysisPack() {
    return !!this._fromAnalysisPack;
  }

  async analyze(audioEngine, file, onProgress) {
    this._packLoaded = false;
    this._fromAnalysisPack = false;
    this.analyzing = true;
    this.profile = null;
    this.userIntensity = null;

    try {
      await audioEngine.init();
      onProgress?.(0.05, "Decoding audio…");

      const arrayBuffer = await file.arrayBuffer();
      const buffer = await audioEngine.context.decodeAudioData(arrayBuffer.slice(0));
      const duration = buffer.duration;
      const data = buffer.getChannelData(0);
      const sampleRate = buffer.sampleRate;
      this._waveform = { samples: data, sampleRate, duration };

      onProgress?.(0.2, "Scanning dynamics…");

      const hop = Math.floor(sampleRate * 0.025);
      const win = Math.floor(sampleRate * 0.05);
      const rms = [];
      const bass = [];
      const times = [];

      for (let i = 0; i + win < data.length; i += hop) {
        let sum = 0;
        let lowSum = 0;
        let highSum = 0;
        const mid = Math.floor(win / 4);

        for (let j = 0; j < win; j++) {
          const s = data[i + j];
          sum += s * s;
          if (j < mid) lowSum += Math.abs(s);
          else highSum += Math.abs(s);
        }

        rms.push(Math.sqrt(sum / win));
        bass.push(lowSum / (lowSum + highSum + 0.0001));
        times.push(i / sampleRate);
      }

      const avgRms = rms.reduce((a, b) => a + b, 0) / rms.length;
      let varSum = 0;
      for (const r of rms) varSum += (r - avgRms) ** 2;
      const energyVariance = Math.min(1, Math.sqrt(varSum / rms.length) / (avgRms + 0.0001));

      onProgress?.(0.45, "Detecting beats…");

      const peaks = [];
      const threshold = avgRms * 1.28;

      for (let i = 3; i < rms.length - 3; i++) {
        if (
          rms[i] > threshold &&
          rms[i] > rms[i - 1] &&
          rms[i] > rms[i - 2] &&
          rms[i] > rms[i - 3] &&
          rms[i] >= rms[i + 1] &&
          rms[i] >= rms[i + 2]
        ) {
          const t = times[i];
          if (peaks.length === 0 || t - peaks[peaks.length - 1] > 0.28) {
            peaks.push(t);
          }
        }
      }

      const intervals = [];
      for (let i = 1; i < peaks.length; i++) {
        const dt = peaks[i] - peaks[i - 1];
        if (dt > 0.28 && dt < 1.4) intervals.push(dt);
      }

      intervals.sort((a, b) => a - b);
      const medianInterval =
        intervals.length > 0
          ? intervals[Math.floor(intervals.length / 2)]
          : 0.55;
      let bpm = Math.round(60 / medianInterval);
      bpm = Math.max(60, Math.min(190, bpm || 100));

      if (bpm > 115 && energyVariance < 0.22 && intervals.length > 4) {
        const slowIntervals = intervals.filter((d) => d > 0.45);
        if (slowIntervals.length >= 2) {
          slowIntervals.sort((a, b) => a - b);
          const slowBpm = Math.round(60 / slowIntervals[Math.floor(slowIntervals.length / 2)]);
          if (slowBpm >= 60 && slowBpm < bpm - 15) bpm = slowBpm;
        }
      }

      onProgress?.(0.65, "Finding drops…");

      const dropTimes = [];
      const windowFrames = Math.floor(0.5 / 0.025);

      for (let i = windowFrames; i < rms.length; i++) {
        const past = rms[i - windowFrames];
        const cur = rms[i];
        if (past > avgRms * 0.55 && cur > past * 1.85 && cur > avgRms * 1.55) {
          const t = times[i];
          if (dropTimes.length === 0 || t - dropTimes[dropTimes.length - 1] > 4) {
            dropTimes.push(t);
          }
        }
      }

      onProgress?.(0.75, "Classifying mood…");

      const avgEnergy = Math.min(1, avgRms * 7);
      const bassWeight = bass.reduce((a, b) => a + b, 0) / Math.max(bass.length, 1);
      const onsetDensity = Math.min(1, peaks.length / Math.max(duration / 3, 1));

      let transientHits = 0;
      for (let i = 2; i < rms.length; i++) {
        if (rms[i] > rms[i - 1] * 1.6 && rms[i] > avgRms * 1.4) transientHits++;
      }
      const transientScore = Math.min(1, transientHits / Math.max(rms.length * 0.02, 1));

      onProgress?.(0.82, "Profiling instruments…");

      let vocalSum = 0;
      let sustainSum = 0;
      for (let i = 1; i < rms.length; i++) {
        const delta = Math.abs(rms[i] - rms[i - 1]);
        const midish = rms[i] * (1 - bass[i] * 0.5);
        vocalSum += midish;
        if (delta < avgRms * 0.15) sustainSum++;
      }
      const vocalPresence = Math.min(1, (vocalSum / rms.length) * 12);
      const sustainRatio = sustainSum / rms.length;
      const percussive = Math.min(1, transientScore * 1.1);
      const electronic = Math.min(
        1,
        bassWeight * 0.5 + transientScore * 0.35 + (1 - sustainRatio) * 0.3
      );
      const melodic = Math.min(1, sustainRatio * 0.6 + vocalPresence * 0.4);

      const instruments = {
        vocal: vocalPresence,
        bass: bassWeight,
        percussive,
        electronic,
        melodic,
      };

      const sections = SongSectionDetector.detect(
        rms,
        times,
        duration,
        dropTimes,
        avgRms
      );

      onProgress?.(0.84, "Separating stems…");
      const stems = StemAnalyzer.decompose(data, sampleRate);
      const vocalOnsets = this._extractVocalOnsets(
        stems.vocals,
        stems.times,
        stems.vocals.reduce((a, b) => a + b, 0) / Math.max(stems.vocals.length, 1)
      );
      const sectionsTagged = StemAnalyzer.tagSections(sections, stems);

      this._analysisExtras = {
        rms,
        times,
        avgRms,
        sections: sectionsTagged,
        instruments,
        vocalOnsets,
        stems,
      };

      const beatTimes = [];
      const beatInterval = 60 / bpm;
      let phase = peaks.length > 0 ? peaks[0] % beatInterval : 0;
      for (let t = phase; t < duration; t += beatInterval) {
        beatTimes.push(t);
      }

      const classified = this._classifyMood({
        bpm,
        avgEnergy,
        bassWeight,
        dropCount: dropTimes.length,
        onsetDensity,
        energyVariance,
        transientScore,
        duration,
      });

      this.profile = this._buildProfile({
        bpm,
        mood: classified.mood,
        avgEnergy,
        bassWeight,
        dropCount: dropTimes.length,
        dropTimes,
        beatTimes,
        onsetDensity,
        energyVariance,
        transientScore,
        duration,
        detectedIntensity: classified.intensity,
        moodScores: classified.scores,
        instruments,
        sections: sectionsTagged,
        stems,
        dominantStem: StemAnalyzer.globalDominant(stems),
      });

      this.profile._baseMotion = this.profile.motionIntensity;
      this.profile._baseSceneDuration = this.profile.sceneDuration;
      this.profile._baseTransitionSec = this.profile.transitionSec;

      this.userIntensity = Math.round(classified.intensity * 100);
      this._applyIntensityToProfile(this.profile);

      onProgress?.(1, "Analysis complete");
      return this.profile;
    } finally {
      this.analyzing = false;
    }
  }

  _classifyMood(m) {
    const scores = { aggressive: 0, dance: 0, chill: 0, melodic: 0, balanced: 0 };

    if (m.bpm >= 65 && m.bpm <= 108) scores.chill += 4;
    if (m.bpm >= 70 && m.bpm <= 115) scores.melodic += 3;
    if (m.avgEnergy < 0.4) scores.chill += 3;
    if (m.avgEnergy < 0.45 && m.bpm < 118) scores.melodic += 2;
    if (m.onsetDensity < 0.42) scores.chill += 3;
    if (m.onsetDensity < 0.5) scores.melodic += 2;
    if (m.dropCount <= 1) scores.chill += 3;
    if (m.dropCount <= 2) scores.melodic += 1;
    if (m.energyVariance < 0.2) scores.chill += 3;
    if (m.energyVariance < 0.28) scores.melodic += 2;
    if (m.transientScore < 0.35) scores.chill += 2;
    if (m.bassWeight > 0.44 && m.bpm < 112) scores.melodic += 3;

    if (m.bpm >= 138) scores.aggressive += 4;
    else if (m.bpm >= 128) scores.aggressive += 2;
    else if (m.bpm >= 120) scores.dance += 2;

    if (m.dropCount >= 3) scores.aggressive += 3;
    else if (m.dropCount >= 2 && m.bpm >= 125) scores.aggressive += 2;

    if (m.energyVariance > 0.32) scores.aggressive += 3;
    else if (m.energyVariance > 0.24) scores.dance += 2;

    if (m.transientScore > 0.55) scores.aggressive += 3;
    else if (m.transientScore > 0.4) scores.dance += 2;

    if (m.onsetDensity > 0.55 && m.bpm >= 125) scores.aggressive += 2;
    if (m.avgEnergy > 0.42 && m.bpm >= 122) scores.dance += 2;

    if (m.bpm >= 128 && m.bassWeight > 0.55 && m.energyVariance > 0.22) {
      scores.aggressive += 2;
    }

    let mood = "balanced";
    let best = scores.balanced;
    for (const [name, score] of Object.entries(scores)) {
      if (score > best) {
        best = score;
        mood = name;
      }
    }

    if (best < 3) mood = "balanced";

    if (mood === "aggressive" && best < 6) mood = "dance";
    if (mood === "dance" && best < 4) mood = "balanced";
    if ((mood === "chill" || mood === "melodic") && m.bpm < 108 && m.dropCount <= 1) {
      mood = m.bpm < 100 && m.avgEnergy < 0.38 ? "chill" : "melodic";
    }

    const intensityMap = {
      chill: 0.22,
      melodic: 0.35,
      balanced: 0.48,
      dance: 0.62,
      aggressive: 0.82,
    };

    let intensity = intensityMap[mood] || 0.48;
    intensity += m.energyVariance * 0.12;
    intensity += Math.min(0.1, m.dropCount * 0.03);
    if (m.bpm < 105) intensity = Math.min(intensity, 0.4);
    if (m.energyVariance < 0.18) intensity = Math.min(intensity, 0.38);

    return { mood, intensity: Math.max(0.15, Math.min(0.95, intensity)), scores };
  }

  _tuneForMood(mood, bpm, avgEnergy, onsetDensity) {
    const tempoFactor = Math.max(0, Math.min(1, (bpm - 70) / 110));

    const presets = {
      aggressive: {
        sceneDuration: 6 + (1 - tempoFactor) * 1.5,
        transitionSec: 0.75,
        motionIntensity: 2.2 + avgEnergy * 0.3,
        energySmoothing: 0.35,
        beatSensitivity: 1.1,
        beatDecay: 0.9,
        analyserSmoothing: 0.42,
        revival: true,
        scenes: ["storm", "tunnel", "fireworks", "objects3d", "generative", "kaleidoscope"],
      },
      dance: {
        sceneDuration: 5.5 + (1 - tempoFactor) * 1.5,
        transitionSec: 1,
        revival: true,
        motionIntensity: 1.7,
        energySmoothing: 0.28,
        beatSensitivity: 1.15,
        beatDecay: 0.93,
        analyserSmoothing: 0.55,
        scenes: ["tunnel", "storm", "objects3d", "fireworks", "kaleidoscope", "typography"],
      },
      chill: {
        sceneDuration: 10,
        transitionSec: 2.8,
        motionIntensity: 0.75,
        energySmoothing: 0.12,
        beatSensitivity: 1.4,
        beatDecay: 0.97,
        analyserSmoothing: 0.82,
        revival: false,
        scenes: ["aurora", "galaxy", "face", "typography", "generative", "waveform"],
      },
      melodic: {
        sceneDuration: 8,
        transitionSec: 2.2,
        motionIntensity: 0.95,
        energySmoothing: 0.16,
        beatSensitivity: 1.3,
        beatDecay: 0.96,
        analyserSmoothing: 0.75,
        revival: false,
        scenes: ["typography", "aurora", "galaxy", "face", "generative", "waveform"],
      },
      balanced: {
        sceneDuration: 6.5,
        transitionSec: 2,
        motionIntensity: 1.15,
        energySmoothing: 0.2,
        beatSensitivity: 1.25,
        beatDecay: 0.95,
        analyserSmoothing: 0.68,
        revival: false,
        scenes: ["aurora", "galaxy", "objects3d", "tunnel", "typography", "face"],
      },
    };

    return { ...(presets[mood] || presets.balanced) };
  }

  getProfile() {
    if (!this.profile) return this.defaultProfile;
    return this.profile;
  }

  _extractVocalOnsets(vocal, times, avgVocal) {
    const flux = [0];
    for (let i = 1; i < vocal.length; i++) {
      flux.push(Math.max(0, vocal[i] - vocal[i - 1]));
    }

    const floor = avgVocal * 0.38;
    const onsets = [];

    for (let i = 2; i < vocal.length - 2; i++) {
      if (vocal[i] < floor) continue;

      const attack = flux[i] > avgVocal * 0.06 && vocal[i] > vocal[i - 1] * 1.08;
      const peak =
        flux[i] >= flux[i - 1] &&
        flux[i] >= flux[i + 1] &&
        flux[i] > avgVocal * 0.04;

      if (!attack && !peak) continue;

      const t = times[i];
      const minGap = vocal[i] > avgVocal * 0.7 ? 0.09 : 0.05;
      if (onsets.length && t - onsets[onsets.length - 1] < minGap) {
        if (flux[i] > flux[i - 1]) onsets[onsets.length - 1] = t;
        continue;
      }
      onsets.push(t);
    }

    return onsets;
  }

  getMoodLabel() {
    const p = this.getProfile();
    const i = Math.round(this.getEffectiveIntensity() * 100);
    const labels = {
      aggressive: "High energy",
      dance: "Upbeat",
      chill: "Chill · Slow flow",
      melodic: "Melodic · R&B soul",
      balanced: "Balanced",
    };
    const base = labels[p.mood] || "Balanced";
    if (p.revival) return `${base} · Beat revivals · ${i}%`;
    if (p.subtleRevival) return `${base} · Soft pulses · ${i}%`;
    return `${base} · ${i}% intensity`;
  }

  isNearDrop(time, window = 0.15) {
    const profile = this.getProfile();
    for (const t of profile.dropTimes) {
      if (Math.abs(time - t) < window) return true;
    }
    return false;
  }

  getAnalysisExtras() {
    return this._analysisExtras || {};
  }

  getWaveform() {
    return this._waveform;
  }
}
