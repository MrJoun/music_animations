const RevivalEngine = {
  beatPulse: 0,
  dropPulse: 0,
  shakeX: 0,
  shakeY: 0,
  punchZoom: 0,
  glitchAmt: 0,
  flashAmt: 0,
  hueShift: 0,
  phase: 0,
  sceneElapsed: 0,
  lastRevivalBeat: -1,
  revivalMode: 0,

  resetScene() {
    this.sceneElapsed = 0;
    this.phase = 0;
    this.revivalMode = Math.floor(Math.random() * 4);
  },

  _intensityScale(profile) {
    return profile?.intensity ?? 0.5;
  },

  update(p, audio, energy, profile) {
    const full = profile?.revival === true;
    const subtle = profile?.subtleRevival === true;
    const scale = this._intensityScale(profile);

    if (!full && !subtle) {
      this.beatPulse *= 0.9;
      this.dropPulse *= 0.88;
      return this.getState(profile);
    }

    const effectScale = subtle ? scale * 0.4 : scale;
    this.sceneElapsed++;
    const t = audio.getCurrentTime();

    if (energy?.lastBeat) {
      this.beatPulse = effectScale;
      this.punchZoom = 0.6 * effectScale;
      this.glitchAmt = full ? (0.35 + Math.random() * 0.4) * effectScale : 0.1 * effectScale;
      this.phase = (this.phase + 1) % 6;
      this.hueShift = (this.hueShift + 0.1 * effectScale) % 1;
      if (full && t - this.lastRevivalBeat > 0.22) {
        this.revivalMode = (this.revivalMode + 1) % 5;
        this.lastRevivalBeat = t;
      }
    }

    if (energy?.lastDrop && full) {
      this.dropPulse = effectScale;
      this.beatPulse = effectScale;
      this.punchZoom = 1.2 * effectScale;
      this.flashAmt = 0.8 * effectScale;
      this.glitchAmt = 0.9 * effectScale;
      this.shakeX = (Math.random() - 0.5) * 20 * effectScale;
      this.shakeY = (Math.random() - 0.5) * 20 * effectScale;
      this.revivalMode = 4;
    }

    this.beatPulse *= 0.84;
    this.dropPulse *= 0.87;
    this.punchZoom *= 0.8;
    this.glitchAmt *= 0.88;
    this.flashAmt *= 0.82;
    this.shakeX *= 0.76;
    this.shakeY *= 0.76;

    return this.getState(profile);
  },

  getState(profile) {
    const scale = this._intensityScale(profile);
    const beat = this.beatPulse;
    const drop = this.dropPulse;
    return {
      beatPulse: beat,
      dropPulse: drop,
      punchZoom: this.punchZoom,
      glitchAmt: this.glitchAmt,
      flashAmt: this.flashAmt,
      shakeX: this.shakeX,
      shakeY: this.shakeY,
      hueShift: this.hueShift,
      phase: this.phase,
      sceneElapsed: this.sceneElapsed,
      revivalMode: this.revivalMode,
      intensity: Math.max(beat, drop * 1.2) * scale,
      userScale: scale,
    };
  },

  applyToBuffer(gfx, theme, revival) {
    const scale = revival.userScale ?? 1;
    if (revival.intensity < 0.04 * scale) return;

    const w = gfx.width;
    const h = gfx.height;

    if (revival.flashAmt > 0.06) {
      gfx.push();
      gfx.blendMode(gfx.ADD);
      gfx.noStroke();
      gfx.fill(255, 255, 255, revival.flashAmt * 70 * scale);
      gfx.rect(0, 0, w, h);
      gfx.blendMode(gfx.BLEND);
      gfx.pop();
    }

    if (revival.glitchAmt > 0.15 && revival.beatPulse > 0.25) {
      gfx.push();
      gfx.stroke(
        theme.secondary[0],
        theme.accent[1],
        theme.accent[2],
        revival.glitchAmt * 55 * scale
      );
      gfx.strokeWeight(2);
      for (let y = 0; y < h; y += 16) {
        if (Math.random() < revival.glitchAmt * 0.28) {
          const shift = (Math.random() - 0.5) * revival.glitchAmt * 40;
          gfx.line(shift, y, w + shift, y);
        }
      }
      gfx.pop();
    }

    if (revival.beatPulse > 0.35) {
      gfx.push();
      gfx.blendMode(gfx.OVERLAY);
      gfx.noStroke();
      gfx.fill(
        theme.accent[0],
        theme.accent[1],
        theme.accent[2],
        revival.beatPulse * 35 * scale
      );
      gfx.rect(0, 0, w, h);
      gfx.blendMode(gfx.BLEND);
      gfx.pop();
    }
  },

  drawOverlay(p, theme, revival) {
    const scale = revival.userScale ?? 1;
    if (revival.intensity < 0.05 * scale) return;

    const w = p.width;
    const h = p.height;

    if (revival.dropPulse > 0.12) {
      p.push();
      p.noFill();
      p.stroke(255, 255, 255, revival.dropPulse * 80 * scale);
      p.strokeWeight(3 + revival.dropPulse * 6);
      p.ellipse(w / 2, h / 2, w * 0.85 * revival.dropPulse, h * 0.45 * revival.dropPulse);
      p.pop();
    }

    if (revival.beatPulse > 0.25) {
      p.push();
      p.blendMode(p.ADD);
      p.noStroke();
      p.fill(theme.accent[0], theme.accent[1], theme.accent[2], revival.beatPulse * 28 * scale);
      p.rect(0, h * 0.72, w, h * 0.28);
      p.blendMode(p.BLEND);
      p.pop();
    }
  },
};
