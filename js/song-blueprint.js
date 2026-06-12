const SongContentAnalyzer = {
  THEMES: {
    love: {
      words: ["love", "heart", "kiss", "baby", "hold", "forever", "yours", "mine"],
      presets: ["typography", "face", "aurora"],
      color: "sunset",
    },
    night: {
      words: ["night", "moon", "dark", "midnight", "stars", "late", "2am", "dream"],
      presets: ["galaxy", "aurora", "face"],
      color: "ocean",
    },
    party: {
      words: ["dance", "party", "club", "turn", "bounce", "rave", "drop", "bass"],
      presets: ["storm", "fireworks", "tunnel", "kaleidoscope"],
      color: "candy",
    },
    fire: {
      words: ["fire", "burn", "flame", "hot", "heat", "blaze"],
      presets: ["fireworks", "storm", "generative"],
      color: "sunset",
    },
    urban: {
      words: ["city", "street", "ride", "money", "cash", "king", "queen", "world"],
      presets: ["typography", "objects3d", "tunnel"],
      color: "mono",
    },
    soul: {
      words: ["soul", "feel", "pain", "cry", "lonely", "miss", "gone", "sorry"],
      presets: ["face", "waveform", "typography", "aurora"],
      color: "sunset",
    },
    cosmic: {
      words: ["sky", "fly", "space", "universe", "float", "light", "shine", "glow"],
      presets: ["galaxy", "generative", "aurora"],
      color: "ocean",
    },
  },

  analyze(title, lyricsLines) {
    const text = `${title || ""} ${(lyricsLines || []).join(" ")}`.toLowerCase();
    const words = text.match(/[a-z']+/g) || [];
    const scores = {};

    for (const [theme, def] of Object.entries(this.THEMES)) {
      scores[theme] = 0;
      for (const w of words) {
        if (def.words.includes(w)) scores[theme]++;
      }
    }

    let topTheme = "balanced";
    let topScore = 0;
    for (const [theme, score] of Object.entries(scores)) {
      if (score > topScore) {
        topScore = score;
        topTheme = theme;
      }
    }

    const titleWords = (title || "")
      .replace(/[_\-.]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .map((w) => w.toUpperCase());

    return {
      dominantTheme: topScore > 0 ? topTheme : null,
      themeScores: scores,
      titleWords: titleWords.slice(0, 6),
      hasLyrics: lyricsLines && lyricsLines.length > 0,
      lyricCount: lyricsLines?.length || 0,
      suggestedColor: topScore > 0 ? this.THEMES[topTheme].color : null,
      presetAffinity: topScore > 0 ? [...this.THEMES[topTheme].presets] : [],
    };
  },
};

const SongSectionDetector = {
  detect(rms, times, duration, dropTimes, avgRms) {
    if (!rms.length) {
      return [{ start: 0, end: duration, type: "full", energy: 0.5 }];
    }

    const smooth = [];
    const win = 5;
    for (let i = 0; i < rms.length; i++) {
      let s = 0;
      let c = 0;
      for (let j = Math.max(0, i - win); j <= Math.min(rms.length - 1, i + win); j++) {
        s += rms[j];
        c++;
      }
      smooth.push(s / c);
    }

    const threshold = avgRms * 1.12;
    const segments = [];
    let segStart = 0;
    let segType = "intro";

    const labelAt = (i) => {
      const e = smooth[i];
      const t = times[i];
      const nearDrop = dropTimes.some((d) => Math.abs(d - t) < 1.5);
      if (nearDrop) return "drop";
      if (e > threshold * 1.25) return "chorus";
      if (e > threshold) return "build";
      if (t < duration * 0.12) return "intro";
      return "verse";
    };

    let currentLabel = labelAt(0);

    for (let i = 1; i < smooth.length; i++) {
      const label = labelAt(i);
      const minLen = 4;

      if (label !== currentLabel && i - segStart >= minLen) {
        const startT = times[segStart];
        const endT = times[i];
        if (endT - startT >= 2) {
          segments.push({
            start: startT,
            end: endT,
            type: currentLabel,
            energy: smooth.slice(segStart, i).reduce((a, b) => a + b, 0) / (i - segStart),
          });
        }
        segStart = i;
        currentLabel = label;
      }
    }

    segments.push({
      start: times[segStart],
      end: duration,
      type: currentLabel,
      energy: smooth.slice(segStart).reduce((a, b) => a + b, 0) / (rms.length - segStart),
    });

    return this._mergeShort(segments, 3);
  },

  _mergeShort(segments, minSec) {
    if (segments.length <= 1) return segments;
    const out = [segments[0]];
    for (let i = 1; i < segments.length; i++) {
      const prev = out[out.length - 1];
      const cur = segments[i];
      if (cur.end - cur.start < minSec) {
        prev.end = cur.end;
        prev.energy = (prev.energy + cur.energy) / 2;
      } else {
        out.push(cur);
      }
    }
    return out;
  },
};

const SongBlueprintBuilder = {
  SECTION_PRESETS: {
    intro: ["aurora", "waveform", "galaxy"],
    verse: ["typography", "face", "generative", "waveform"],
    build: ["tunnel", "objects3d", "kaleidoscope"],
    chorus: ["storm", "fireworks", "typography", "objects3d"],
    drop: ["storm", "tunnel", "fireworks", "generative"],
    full: ["aurora", "galaxy", "typography"],
  },

  MOOD_BASE: {
    aggressive: ["storm", "tunnel", "fireworks", "objects3d", "generative", "kaleidoscope"],
    dance: ["tunnel", "storm", "kaleidoscope", "fireworks", "objects3d"],
    chill: ["aurora", "galaxy", "face", "waveform", "generative"],
    melodic: ["typography", "face", "aurora", "galaxy", "waveform"],
    balanced: ["aurora", "galaxy", "typography", "tunnel", "face", "generative"],
  },

  build(profile, sections, instruments, content, lyricsLines) {
    const scenes = [];
    const usedPresets = new Set();
    let lyricIdx = 0;

    const pickPreset = (sectionType, energy) => {
      const candidates = [];

      if (content.presetAffinity?.length) {
        candidates.push(...content.presetAffinity);
      }

      const sectionPool = this.SECTION_PRESETS[sectionType] || this.SECTION_PRESETS.verse;
      candidates.push(...sectionPool);

      const moodPool = this.MOOD_BASE[profile.mood] || this.MOOD_BASE.balanced;
      candidates.push(...moodPool);

      if (instruments.vocal > 0.55) candidates.push("typography", "face");
      if (instruments.bass > 0.55) candidates.push("tunnel", "storm");
      if (instruments.electronic > 0.5) candidates.push("generative", "storm", "tunnel");
      if (instruments.percussive > 0.5) candidates.push("fireworks", "storm");

      const scored = [];
      const seen = new Set();
      for (const p of candidates) {
        if (seen.has(p)) continue;
        seen.add(p);
        let score = 1;
        if (sectionPool.includes(p)) score += 3;
        if (content.presetAffinity?.includes(p)) score += 4;
        if (moodPool.includes(p)) score += 2;
        if (usedPresets.has(p)) score -= 5;
        if (p === scenes[scenes.length - 1]?.preset) score -= 8;
        scored.push({ p, score });
      }

      scored.sort((a, b) => b.score - a.score);
      const pick = scored[0]?.p || "aurora";
      usedPresets.add(pick);
      return pick;
    };

    for (const sec of sections) {
      const preset = pickPreset(sec.type, sec.energy);
      let lyricLine = null;

      if (preset === "typography" && lyricsLines?.length) {
        lyricLine = lyricsLines[lyricIdx % lyricsLines.length];
        lyricIdx++;
      } else if (content.titleWords?.length && sec.type === "intro") {
        lyricLine = content.titleWords.join(" ");
      }

      scenes.push({
        preset,
        start: sec.start,
        end: sec.end,
        section: sec.type,
        energy: sec.energy,
        lyricLine,
        duration: sec.end - sec.start,
        dominantStem: sec.dominantStem || null,
        stemMix: sec.stemMix || null,
      });
    }

    if (scenes.length < 3 && profile.duration > 30) {
      return this._fallbackEvenSplit(profile, content, lyricsLines, instruments);
    }

    const summary = this._summarize(profile, instruments, content, scenes);

    return {
      scenes,
      summary,
      suggestedTheme: content.suggestedColor,
      sectionCount: sections.length,
      content,
      instruments,
    };
  },

  _fallbackEvenSplit(profile, content, lyricsLines, instruments) {
    const dur = profile.duration || 180;
    const n = Math.min(8, Math.max(4, Math.floor(dur / 25)));
    const sections = [];
    for (let i = 0; i < n; i++) {
      sections.push({
        start: (dur / n) * i,
        end: (dur / n) * (i + 1),
        type: i === 0 ? "intro" : i === n - 1 ? "chorus" : "verse",
        energy: profile.avgEnergy || 0.4,
      });
    }
    return this.build(profile, sections, instruments, content, lyricsLines);
  },

  _summarize(profile, instruments, content, scenes) {
    const parts = [];
    const inst = [];
    if (instruments.vocal > 0.5) inst.push("vocals");
    if (instruments.bass > 0.5) inst.push("bass");
    if (instruments.electronic > 0.45) inst.push("electronic");
    if (instruments.percussive > 0.45) inst.push("beats");
    if (inst.length) parts.push(inst.join(" + "));

    const stems = [...new Set(scenes.map((s) => s.dominantStem).filter(Boolean))];
    if (stems.length) parts.push(`stems: ${stems.map((s) => StemAnalyzer.label(s)).join("/")}`);

    if (content.dominantTheme) parts.push(content.dominantTheme);
    parts.push(`${scenes.length} unique scenes`);
    return parts.join(" · ");
  },
};

const songBlueprint = {
  data: null,

  build(profile, analysisExtras, title, lyricsManager) {
    const lyricsLines = lyricsManager?.getAllLines?.() || [];
    const content = SongContentAnalyzer.analyze(title, lyricsLines);
    const sections =
      analysisExtras.sections ||
      SongSectionDetector.detect(
        analysisExtras.rms,
        analysisExtras.times,
        profile.duration,
        profile.dropTimes,
        analysisExtras.avgRms
      );

    const instruments = analysisExtras.instruments || {
      vocal: 0.4,
      bass: profile.bassWeight || 0.4,
      percussive: profile.transientScore || 0.3,
      electronic: 0.3,
      melodic: 0.4,
    };

    this.data = SongBlueprintBuilder.build(
      profile,
      sections,
      instruments,
      content,
      lyricsLines
    );

    profile.blueprint = this.data;
    profile.sections = sections;
    profile.sectionCount = sections.length;
    profile.instruments = instruments;
    profile.content = content;
    profile.storySummary = this.data.summary;

    return this.data;
  },

  get() {
    return this.data;
  },

  sceneAtTime(t) {
    if (!this.data?.scenes?.length) return null;
    for (const s of this.data.scenes) {
      if (t >= s.start && t < s.end) return s;
    }
    return this.data.scenes[this.data.scenes.length - 1];
  },

  nextSceneAfter(t) {
    if (!this.data?.scenes?.length) return null;
    for (let i = 0; i < this.data.scenes.length; i++) {
      if (t >= this.data.scenes[i].start && t < this.data.scenes[i].end) {
        return this.data.scenes[i + 1] || this.data.scenes[0];
      }
    }
    return this.data.scenes[0];
  },
};
