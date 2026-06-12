const ParticlesPreset = {
  name: "particles",
  particles: [],

  setup(p) {
    this.particles = [];
    for (let i = 0; i < 80; i++) {
      this.particles.push(this._createParticle(p, true));
    }
  },

  _createParticle(p, randomY) {
    return {
      x: p.random(p.width),
      y: randomY ? p.random(p.height) : p.height + 10,
      vx: p.random(-1, 1),
      vy: p.random(-3, -0.5),
      size: p.random(3, 8),
      life: 1,
      hue: p.random(1),
    };
  },

  draw(p, audio, theme) {
    p.background(...theme.bg, 40);

    const energy = audio.getOverallEnergy();
    const bass = audio.getBassEnergy();
    audio.detectBeat();

    if (audio.lastBeat) {
      for (let i = 0; i < 12; i++) {
        const particle = this._createParticle(p, false);
        particle.x = p.width / 2 + p.random(-100, 100);
        particle.vy = p.random(-8, -3);
        particle.size = p.random(5, 14);
        this.particles.push(particle);
      }
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const pt = this.particles[i];
      pt.x += pt.vx * (1 + energy * 3);
      pt.y += pt.vy * (1 + bass * 2);
      pt.life -= 0.008;

      const t = pt.hue;
      const r = p.lerp(theme.accent[0], theme.secondary[0], t);
      const g = p.lerp(theme.accent[1], theme.secondary[1], t);
      const b = p.lerp(theme.accent[2], theme.secondary[2], t);

      p.noStroke();
      p.fill(r, g, b, pt.life * 200);
      p.ellipse(pt.x, pt.y, pt.size * (1 + bass), pt.size * (1 + bass));

      if (pt.life <= 0 || pt.y < -20) {
        this.particles.splice(i, 1);
      }
    }

    while (this.particles.length < 80) {
      this.particles.push(this._createParticle(p, true));
    }
  },
};
