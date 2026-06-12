const StemAnalyzer = {
  decompose(channelData, sampleRate) {
    const hop = Math.floor(sampleRate * 0.025);
    const win = Math.floor(sampleRate * 0.05);
    const quarter = Math.max(1, Math.floor(win / 4));

    const times = [];
    const vocals = [];
    const bass = [];
    const drums = [];
    const melodic = [];

    let smoothMid = 0;
    let smoothLow = 0;

    for (let i = 0; i + win < channelData.length; i += hop) {
      let sum = 0;
      let low = 0;
      let mid = 0;
      let high = 0;
      let flux = 0;
      let prevAbs = 0;

      for (let j = 0; j < win; j++) {
        const s = channelData[i + j];
        const a = Math.abs(s);
        sum += s * s;
        if (j < quarter) low += a;
        else if (j < quarter * 3) mid += a;
        else high += a;
        if (j > 0) flux += Math.abs(a - prevAbs);
        prevAbs = a;
      }

      const rms = Math.sqrt(sum / win);
      const lowE = low / quarter;
      const midE = mid / (quarter * 2);
      const highE = high / quarter;
      const fluxN = flux / win;

      smoothLow = smoothLow * 0.65 + lowE * 0.35;
      smoothMid = smoothMid * 0.6 + midE * 0.4;

      const drumsE = Math.min(1, fluxN * 4.2 + highE * 0.55 + rms * 1.2);
      const bassE = Math.min(1, smoothLow * 2.4 + lowE * 0.8);
      const vocalE = Math.min(
        1,
        smoothMid * 2.1 * (1 - bassE * 0.3) * (1 - drumsE * 0.2) + rms * 0.5
      );
      const melodicE = Math.min(
        1,
        (midE * 1.4 + highE * 0.7) * (1 - drumsE * 0.35) * (1 - bassE * 0.15)
      );

      times.push(i / sampleRate);
      bass.push(bassE);
      drums.push(drumsE);
      vocals.push(vocalE);
      melodic.push(melodicE);
    }

    return { times, vocals, bass, drums, melodic };
  },

  mixForSection(stems, start, end) {
    const mix = { vocals: 0, bass: 0, drums: 0, melodic: 0 };
    let n = 0;
    for (let i = 0; i < stems.times.length; i++) {
      const t = stems.times[i];
      if (t < start || t >= end) continue;
      mix.vocals += stems.vocals[i];
      mix.bass += stems.bass[i];
      mix.drums += stems.drums[i];
      mix.melodic += stems.melodic[i];
      n++;
    }
    if (n) {
      for (const k of Object.keys(mix)) mix[k] /= n;
    }
    return mix;
  },

  dominantForSection(stems, start, end) {
    const mix = this.mixForSection(stems, start, end);
    let best = "melodic";
    let top = 0;
    for (const [k, v] of Object.entries(mix)) {
      if (v > top) {
        top = v;
        best = k;
      }
    }
    return { stem: best, mix };
  },

  tagSections(sections, stems) {
    return sections.map((sec) => {
      const { stem, mix } = this.dominantForSection(stems, sec.start, sec.end);
      return { ...sec, dominantStem: stem, stemMix: mix };
    });
  },

  globalDominant(stems) {
    if (!stems?.times?.length) return "melodic";
    const end = stems.times[stems.times.length - 1];
    return this.dominantForSection(stems, 0, end).stem;
  },

  label(stem) {
    return (
      {
        vocals: "vocals",
        bass: "bass",
        drums: "drums",
        melodic: "melody",
      }[stem] || stem
    );
  },
};

const StemEnergy = {
  stems: null,

  apply(extras) {
    this.stems = extras?.stems || null;
  },

  _interp(arr, times, t) {
    if (!arr?.length) return 0;
    if (t <= times[0]) return arr[0];
    if (t >= times[times.length - 1]) return arr[arr.length - 1];

    for (let i = 1; i < times.length; i++) {
      if (t < times[i]) {
        const frac = (t - times[i - 1]) / (times[i] - times[i - 1]);
        return arr[i - 1] + (arr[i] - arr[i - 1]) * frac;
      }
    }
    return arr[arr.length - 1];
  },

  atTime(t) {
    if (!this.stems) {
      return { vocals: 0.2, bass: 0.2, drums: 0.2, melodic: 0.2, dominant: "melodic" };
    }

    const { times, vocals, bass, drums, melodic } = this.stems;
    const mix = {
      vocals: this._interp(vocals, times, t),
      bass: this._interp(bass, times, t),
      drums: this._interp(drums, times, t),
      melodic: this._interp(melodic, times, t),
    };

    let dominant = "melodic";
    let top = 0;
    for (const [k, v] of Object.entries(mix)) {
      if (v > top) {
        top = v;
        dominant = k;
      }
    }

    return { ...mix, dominant };
  },

  blendInto(energy, audio) {
    if (!this.stems || !audio) return;

    const t = audio.getCurrentTime();
    const pre = this.atTime(t);

    energy.stemVocals = pre.vocals * 0.72 + energy.vocal * 0.28;
    energy.stemBass = pre.bass * 0.72 + energy.bass * 0.28;
    energy.stemDrums = pre.drums * 0.65 + (energy.lastBeat ? 0.35 : 0.05);
    energy.stemMelodic = pre.melodic * 0.72 + energy.mids * 0.28;
    energy.dominantStem = pre.dominant;
  },
};
