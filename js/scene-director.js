const SceneDirector = {
  name: "director",
  playQueue: [],
  queueIndex: 0,
  sceneStartFrame: 0,
  bufferA: null,
  bufferB: null,
  initialized: false,
  _inTransition: false,
  _blueprintKey: "",
  _timelineMode: true,
  _lastDropCutTime: -99,

  _presetMap() {
    return {
      aurora: AuroraPreset,
      galaxy: GalaxyPreset,
      objects3d: Objects3dPreset,
      typography: TypographyPreset,
      tunnel: TunnelPreset,
      generative: GenerativePreset,
      face: FacePreset,
      storm: StormPreset,
      fireworks: FireworksPreset,
      kaleidoscope: KaleidoscopePreset,
      waveform: WaveformPreset,
    };
  },

  _sceneFromBlueprintEntry(entry) {
    const map = this._presetMap();
    return {
      preset: map[entry.preset] || AuroraPreset,
      key: entry.preset,
      section: entry.section,
      lyricLine: entry.lyricLine,
      start: entry.start,
      end: entry.end,
      dominantStem: entry.dominantStem,
    };
  },

  setup(p, profile) {
    const map = this._presetMap();
    const blueprint = profile?.blueprint;

    if (!this.bufferA) {
      this.bufferA = p.createGraphics(p.width, p.height);
      this.bufferB = p.createGraphics(p.width, p.height);
    }

    if (blueprint?.scenes?.length) {
      this.playQueue = blueprint.scenes.map((e) => this._sceneFromBlueprintEntry(e));
      this._timelineMode = true;
      this._blueprintKey = `${profile.mood}-${blueprint.scenes.length}-${blueprint.summary}`;
    } else {
      let keys = [...(profile?.scenes || ["aurora", "galaxy", "typography"])];
      keys = [...new Set(keys)].filter((k) => map[k]);
      this.playQueue = keys.map((k) => ({ preset: map[k], key: k }));
      this._timelineMode = false;
      this._blueprintKey = profile?.mood || "fallback";
    }

    this.queueIndex = 0;
    this.sceneStartFrame = p.frameCount;
    this.initialized = true;
    this._lastDropCutTime = -99;
    RevivalEngine.resetScene();
    CinematicCamera.reset();

    const seen = new Set();
    for (const scene of this.playQueue) {
      if (!seen.has(scene.key)) {
        seen.add(scene.key);
        if (scene.preset.setup) scene.preset.setup(p);
      }
    }
  },

  _ensureProfile(p, options) {
    const profile = options.profile || options.energy?.profile;
    const key = profile?.blueprint?.summary || profile?.mood || "default";
    if (!this.initialized || key !== this._blueprintKey) {
      this.setup(p, profile);
    }
  },

  _resolveTimelineIndex(currentTime, profile) {
    if (!this._timelineMode) return this.queueIndex;

    for (let i = 0; i < this.playQueue.length; i++) {
      const s = this.playQueue[i];
      if (s.start != null && currentTime >= s.start && currentTime < s.end) {
        if (i !== this.queueIndex) {
          this.queueIndex = i;
          RevivalEngine.resetScene();
        }
        return i;
      }
    }
    return this.queueIndex;
  },

  _currentScene() {
    return this.playQueue[this.queueIndex] || this.playQueue[0];
  },

  _nextScene() {
    const next = (this.queueIndex + 1) % this.playQueue.length;
    return this.playQueue[next];
  },

  _sectionDurationFrames(scene, options) {
    if (this._timelineMode && scene.start != null && scene.end != null) {
      return Math.floor((scene.end - scene.start) * 30);
    }
    if (options.energy) {
      return Math.floor(options.energy.getSceneDuration() * 30);
    }
    return 180;
  },

  _transitionFrames(options, profile) {
    const base = options.energy ? options.energy.getTransitionFrames() : 42;
    if (profile?.revival) return Math.min(base, 30);
    return base;
  },

  _easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  },

  _easeSnap(t) {
    if (t < 0.35) return this._easeInOut(t / 0.35) * 0.15;
    return 0.15 + this._easeInOut((t - 0.35) / 0.65) * 0.85;
  },

  _drawLayer(p, gfx, alpha, scale, blurPx, ox = 0, oy = 0) {
    if (alpha <= 0.01) return;

    const cx = p.width / 2;
    const cy = p.height / 2;

    p.push();
    p.translate(cx + ox, cy + oy);
    p.scale(scale);
    p.translate(-cx, -cy);

    p.tint(255, alpha * 255);
    if (blurPx > 0.3 && p.drawingContext.filter !== undefined) {
      p.drawingContext.filter = `blur(${blurPx}px)`;
    }
    p.image(gfx, 0, 0);
    if (blurPx > 0.3) p.drawingContext.filter = "none";

    p.noTint();
    p.pop();
  },

  draw(p, audio, theme, options) {
    this._ensureProfile(p, options);

    const energy = options.energy;
    const profile = options.profile || energy?.profile;
    const revival = RevivalEngine.update(p, audio, energy, profile);
    const intensity = profile?.intensity ?? 0.5;
    const aggressive = profile?.revival === true;

    const t = audio.getCurrentTime();
    if (this._timelineMode) {
      this._resolveTimelineIndex(t, profile);
      const scene = this._currentScene();
      if (scene?.start != null) {
        const secElapsed = t - scene.start;
        const secDur = scene.end - scene.start;
        const transSec = Math.min(profile.transitionSec || 1.5, secDur * 0.2);
        const holdSec = secDur - transSec;
        const morph = secElapsed > holdSec ? (secElapsed - holdSec) / transSec : 0;
        return this._drawTransition(
          p,
          audio,
          theme,
          options,
          energy,
          profile,
          revival,
          intensity,
          aggressive,
          Math.min(1, Math.max(0, morph))
        );
      }
    }

    let scene = this._currentScene();
    let total = this._sectionDurationFrames(scene, options);
    let transitionFrames = this._transitionFrames(options, profile);
    let elapsed = p.frameCount - this.sceneStartFrame;

    if (elapsed >= total) {
      this.queueIndex = (this.queueIndex + 1) % this.playQueue.length;
      this.sceneStartFrame = p.frameCount;
      scene = this._currentScene();
      elapsed = 0;
      total = this._sectionDurationFrames(scene, options);
      transitionFrames = this._transitionFrames(options, profile);
      RevivalEngine.resetScene();
    }

    let morph = 0;
    const holdEnd = total - transitionFrames;
    if (elapsed >= holdEnd) morph = (elapsed - holdEnd) / transitionFrames;

    this._drawTransition(
      p,
      audio,
      theme,
      options,
      energy,
      profile,
      revival,
      intensity,
      aggressive,
      morph
    );
  },

  _drawTransition(p, audio, theme, options, energy, profile, revival, intensity, aggressive, morph) {
    const eased = aggressive ? this._easeSnap(morph) : this._easeInOut(Math.min(1, morph));
    this._inTransition = eased > 0.02 && eased < 0.98;

    const scene = this._currentScene();
    const nextScene = this._nextScene();

    const sectionText = scene.lyricLine || options.customText;
    const drawOpts = {
      ...options,
      energy,
      profile,
      revival,
      _cinematic: true,
      customText: sectionText,
      section: scene.section,
    };

    this.bufferA.push();
    scene.preset.draw(this.bufferA, audio, theme, drawOpts);
    RevivalEngine.applyToBuffer(this.bufferA, theme, revival);
    this.bufferA.pop();

    if (eased > 0) {
      const nextText = nextScene.lyricLine || options.customText;
      this.bufferB.push();
      nextScene.preset.draw(
        this.bufferB,
        audio,
        theme,
        { ...drawOpts, customText: nextText, section: nextScene.section }
      );
      RevivalEngine.applyToBuffer(this.bufferB, theme, revival);
      this.bufferB.pop();
    }

    PresetUtils.drawDepthBackground(p, theme);

    CinematicCamera.update(p, energy, eased, revival);

    p.push();
    p.translate(revival.shakeX, revival.shakeY);
    CinematicCamera.apply(p);

    const punch = 1 + revival.punchZoom * 0.12;
    const outAlpha = 1 - eased;
    const inAlpha = eased;
    const outScale = punch * (1 + eased * 0.04);
    const inScale = punch * (1.04 - eased * 0.04);

    this._drawLayer(p, this.bufferA, outAlpha, outScale, eased * 2, 0, 0);

    if (eased > 0) {
      this._drawLayer(p, this.bufferB, inAlpha, inScale, (1 - eased) * 2, 0, 0);
    }

    p.pop();

    RevivalEngine.drawOverlay(p, theme, revival);

    if (options.showStemFx) {
      StemVisualFX.draw(p, theme, energy, scene.dominantStem, intensity);
    }

    PresetUtils.drawCinematicGrade(p, theme);

    if (scene.section && eased < 0.1) {
      p.push();
      p.textAlign(p.CENTER, p.TOP);
      p.textSize(22);
      p.fill(255, 255, 255, 50);
      p.text(scene.section.toUpperCase(), p.width / 2, 36);
      p.pop();
    }

    if (options.showSparks && intensity >= 0.5) {
      PresetUtils.drawBeatSparks(p, audio, theme, energy, {
        subtle: intensity < 0.7,
      });
    }

    if (options.lyrics?.hasLines() && scene.key !== "typography") {
      options.lyrics.draw(p, theme, energy, audio);
    }
  },
};
