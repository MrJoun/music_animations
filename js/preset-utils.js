const PresetUtils = {
  idleBass(p, audio) {
    const live = audio.getBassEnergy();
    if (audio.isPlaying && live > 0.02) return live;
    return 0.15 + Math.sin(p.frameCount * 0.03) * 0.08;
  },

  idleEnergy(p, audio) {
    const live = audio.getOverallEnergy();
    if (audio.isPlaying && live > 0.02) return live;
    return 0.12 + Math.sin(p.frameCount * 0.02) * 0.06;
  },

  getFreq(p, audio) {
    const freq = audio.getFrequencyData();
    if (audio.isPlaying && audio.getOverallEnergy() > 0.02) return freq;

    for (let i = 0; i < freq.length; i++) {
      const wave =
        Math.sin(p.frameCount * 0.03 + i * 0.1) * 0.4 +
        Math.sin(p.frameCount * 0.015 + i * 0.03) * 0.25 +
        0.45;
      freq[i] = Math.floor(wave * 120);
    }
    return freq;
  },

  getWave(p, audio) {
    const wave = audio.getWaveformData();
    if (audio.isPlaying && audio.getOverallEnergy() > 0.02) return wave;

    for (let i = 0; i < wave.length; i++) {
      const v = Math.sin(p.frameCount * 0.04 + i * 0.06) * 0.25;
      wave[i] = Math.floor(128 + v * 70);
    }
    return wave;
  },

  lerpColor(p, theme, t) {
    return [
      p.lerp(theme.accent[0], theme.secondary[0], t),
      p.lerp(theme.accent[1], theme.secondary[1], t),
      p.lerp(theme.accent[2], theme.secondary[2], t),
    ];
  },

  drawDepthBackground(p, theme) {
    const cx = p.width / 2;
    const cy = p.height * 0.45;
    const ctx = p.drawingContext;

    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, p.height * 0.85);
    const r = theme.bg[0] + 14;
    const g = theme.bg[1] + 14;
    const b = theme.bg[2] + 22;
    bg.addColorStop(0, `rgb(${r},${g},${b})`);
    bg.addColorStop(0.45, `rgb(${theme.bg[0]},${theme.bg[1]},${theme.bg[2]})`);
    bg.addColorStop(1, `rgb(${Math.max(0, theme.bg[0] - 8)},${Math.max(0, theme.bg[1] - 8)},${Math.max(0, theme.bg[2] - 4)})`);

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, p.width, p.height);

    const lift = ctx.createLinearGradient(0, 0, 0, p.height);
    lift.addColorStop(0, `rgba(${theme.accent[0]},${theme.accent[1]},${theme.accent[2]},0.04)`);
    lift.addColorStop(0.35, "rgba(0,0,0,0)");
    lift.addColorStop(1, `rgba(${theme.secondary[0]},${theme.secondary[1]},${theme.secondary[2]},0.06)`);
    ctx.fillStyle = lift;
    ctx.fillRect(0, 0, p.width, p.height);
  },

  drawCinematicGrade(p, theme) {
    const cx = p.width / 2;
    const cy = p.height / 2;
    const ctx = p.drawingContext;

    const vig = ctx.createRadialGradient(cx, cy, p.height * 0.15, cx, cy, p.height * 0.72);
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, `rgba(0,0,0,${0.55})`);
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, p.width, p.height);

    const top = ctx.createLinearGradient(0, 0, 0, p.height * 0.2);
    top.addColorStop(0, "rgba(255,255,255,0.03)");
    top.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, p.width, p.height * 0.2);
  },

  beatSparks: [],

  initSparks(p, count = 18) {
    this.beatSparks = [];
    for (let i = 0; i < count; i++) {
      this.beatSparks.push({
        x: p.random(p.width),
        y: p.random(p.height),
        vx: p.random(-0.6, 0.6),
        vy: p.random(-0.6, 0.6),
        size: p.random(2, 6),
        rot: p.random(p.TWO_PI),
        spin: p.random(-0.02, 0.02),
        hue: p.random(1),
        flash: 0,
        shape: Math.floor(p.random(3)),
      });
    }
  },

  drawBeatSparks(p, audio, theme, energy, opts = {}) {
    const subtle = opts.subtle === true;
    const count = subtle ? 12 : 18;
    if (this.beatSparks.length === 0) this.initSparks(p, count);

    const bass = energy ? energy.bass : this.idleBass(p, audio);
    const beat = energy ? energy.lastBeat : false;

    p.push();
    if (!subtle) p.blendMode(p.ADD);

    for (const s of this.beatSparks) {
      if (beat) s.flash = subtle ? 0.5 : 1;

      s.x += s.vx;
      s.y += s.vy;
      s.rot += s.spin;
      s.flash *= 0.92;

      if (s.x < -20) s.x = p.width + 20;
      if (s.x > p.width + 20) s.x = -20;
      if (s.y < -20) s.y = p.height + 20;
      if (s.y > p.height + 20) s.y = -20;

      const col = this.lerpColor(p, theme, s.hue);
      const alpha = subtle
        ? 25 + s.flash * 60 + bass * 30
        : 50 + s.flash * 100 + bass * 60;
      const sz = s.size * (0.8 + bass * 0.3 + s.flash * 0.2);

      p.push();
      p.translate(s.x, s.y);
      p.rotate(s.rot);
      p.noStroke();
      p.fill(col[0], col[1], col[2], alpha);
      p.ellipse(0, 0, sz, sz);
      p.pop();
    }

    if (!subtle) p.blendMode(p.BLEND);
    p.pop();
  },

  applyCamera(p, audio, energy) {
    CinematicCamera.update(p, energy || { bass: this.idleBass(p, audio), energy: this.idleEnergy(p, audio) }, 0);
    CinematicCamera.apply(p);
  },
};
