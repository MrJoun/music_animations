const FireworksPreset = {
  name: "fireworks",
  bursts: [],
  sparks: [],

  setup(p) {
    this.bursts = [];
    this.sparks = [];
    this.prevBeat = false;
  },

  _spawnBurst(p, x, y, theme, intensity) {
    const count = 60 + Math.floor(intensity * 40);
    for (let i = 0; i < count; i++) {
      const angle = p.random(p.TWO_PI);
      const speed = p.random(2, 8 + intensity * 6);
      const t = p.random(1);
      this.sparks.push({
        x,
        y,
        vx: p.cos(angle) * speed,
        vy: p.sin(angle) * speed,
        life: 1,
        decay: p.random(0.008, 0.018),
        size: p.random(2, 5 + intensity * 3),
        hue: t,
        trail: [],
      });
    }

    this.bursts.push({
      x,
      y,
      r: 5,
      alpha: 255,
      hue: p.random(1),
    });
  },

  draw(p, audio, theme) {
    const energy = audio.getOverallEnergy();
    const bass = audio.getBassEnergy();
    const beat = audio.detectBeat();
    const w = p.width;
    const h = p.height;
    const idle = p.sin(p.frameCount * 0.02) * 0.5 + 0.5;

    p.background(...theme.bg, 50);

    if (beat && !this.prevBeat) {
      const x = p.random(w * 0.15, w * 0.85);
      const y = p.random(h * 0.08, h * 0.45);
      this._spawnBurst(p, x, y, theme, 0.5 + bass + energy);
    }
    this.prevBeat = beat;

    if (p.frameCount % 90 === 0 && energy < 0.12) {
      const x = w * (0.2 + idle * 0.6);
      const y = h * (0.1 + p.sin(p.frameCount * 0.01) * 0.15);
      this._spawnBurst(p, x, y, theme, 0.3);
    }

    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const burst = this.bursts[i];
      burst.r += 4 + bass * 6;
      burst.alpha -= 6;

      const r = p.lerp(theme.accent[0], theme.secondary[0], burst.hue);
      const g = p.lerp(theme.accent[1], theme.secondary[1], burst.hue);
      const b = p.lerp(theme.accent[2], theme.secondary[2], burst.hue);

      p.noFill();
      p.stroke(r, g, b, burst.alpha);
      p.strokeWeight(2);
      p.ellipse(burst.x, burst.y, burst.r * 2, burst.r * 2);

      if (burst.alpha <= 0) {
        this.bursts.splice(i, 1);
      }
    }

    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const sp = this.sparks[i];
      sp.trail.push({ x: sp.x, y: sp.y });
      if (sp.trail.length > 6) sp.trail.shift();

      sp.vx *= 0.98;
      sp.vy *= 0.98;
      sp.vy += 0.04;
      sp.x += sp.vx;
      sp.y += sp.vy;
      sp.life -= sp.decay;

      const r = p.lerp(theme.accent[0], theme.secondary[0], sp.hue);
      const g = p.lerp(theme.accent[1], theme.secondary[1], sp.hue);
      const b = p.lerp(theme.accent[2], theme.secondary[2], sp.hue);
      const alpha = sp.life * 220;

      for (let t = 0; t < sp.trail.length; t++) {
        const tr = sp.trail[t];
        const trailAlpha = (t / sp.trail.length) * alpha * 0.4;
        p.stroke(r, g, b, trailAlpha);
        p.strokeWeight(sp.size * 0.5);
        if (t > 0) {
          p.line(sp.trail[t - 1].x, sp.trail[t - 1].y, tr.x, tr.y);
        }
      }

      p.noStroke();
      p.fill(r, g, b, alpha);
      p.ellipse(sp.x, sp.y, sp.size, sp.size);

      if (sp.life <= 0 || sp.y > h + 20) {
        this.sparks.splice(i, 1);
      }
    }

    const groundY = h * 0.88;
    p.noStroke();
    for (let i = 0; i < 8; i++) {
      const t = i / 7;
      const r = p.lerp(theme.accent[0], theme.secondary[0], t);
      const g = p.lerp(theme.accent[1], theme.secondary[1], t);
      const b = p.lerp(theme.accent[2], theme.secondary[2], t);
      p.fill(r, g, b, 20 + energy * 30);
      p.rect(0, groundY + i * 25, w, 30);
    }

    p.fill(...theme.glow);
    p.ellipse(w / 2, groundY, w * 0.8, 40 + bass * 60);
  },
};
