const GalaxyPreset = {
  name: "galaxy",
  stars: [],

  setup(p) {
    this.stars = [];
    const arms = 4;
    const starsPerArm = 120;

    for (let a = 0; a < arms; a++) {
      const armOffset = (a / arms) * p.TWO_PI;
      for (let i = 0; i < starsPerArm; i++) {
        const t = i / starsPerArm;
        const angle = armOffset + t * p.PI * 2.8;
        const radius = 40 + t * 420 + p.random(-25, 25);
        this.stars.push({
          angle,
          radius,
          size: p.random(1.5, 4.5),
          twinkle: p.random(p.TWO_PI),
          hue: p.random(1),
          drift: p.random(0.8, 1.2),
        });
      }
    }
  },

  draw(p, audio, theme) {
    const bass = audio.getBassEnergy();
    const energy = audio.getOverallEnergy();
    const w = p.width;
    const h = p.height;
    const cx = w / 2;
    const cy = h / 2;
    const idle = p.frameCount * 0.003;
    const spin = idle * 0.4 + energy * 0.015;

    p.background(...theme.bg);

    for (let i = 0; i < 80; i++) {
      const t = i / 80;
      const r = p.lerp(theme.accent[0], theme.secondary[0], t) * 0.15;
      const g = p.lerp(theme.accent[1], theme.secondary[1], t) * 0.15;
      const b = p.lerp(theme.accent[2], theme.secondary[2], t) * 0.15;
      const angle = t * p.TWO_PI + idle;
      const dist = 200 + i * 5;
      p.noStroke();
      p.fill(r, g, b, 8);
      p.ellipse(
        cx + p.cos(angle) * dist,
        cy + p.sin(angle) * dist * 0.35,
        120,
        40
      );
    }

    p.push();
    p.translate(cx, cy);
    p.rotate(spin);

    for (const star of this.stars) {
      const twinkle =
        0.5 +
        0.5 * p.sin(star.twinkle + p.frameCount * 0.05 * star.drift);
      const pulse = 1 + bass * 1.8;
      const x = p.cos(star.angle) * star.radius;
      const y = p.sin(star.angle) * star.radius * 0.55;

      const t = star.hue;
      const r = p.lerp(theme.accent[0], theme.secondary[0], t);
      const g = p.lerp(theme.accent[1], theme.secondary[1], t);
      const b = p.lerp(theme.accent[2], theme.secondary[2], t);
      const alpha = (80 + twinkle * 120 + energy * 55) * pulse;

      p.noStroke();
      p.fill(r, g, b, alpha);
      const sz = star.size * (0.8 + twinkle * 0.6) * pulse;
      p.ellipse(x, y, sz, sz);

      if (twinkle > 0.85 && star.size > 3) {
        p.stroke(r, g, b, alpha * 0.4);
        p.strokeWeight(1);
        p.line(x - sz * 2, y, x + sz * 2, y);
        p.line(x, y - sz * 2, x, y + sz * 2);
      }
    }

    p.pop();

    const coreR = 35 + bass * 70 + p.sin(p.frameCount * 0.06) * 8;
    p.noStroke();
    p.fill(...theme.accent, 100 + energy * 155);
    p.ellipse(cx, cy, coreR * 2, coreR * 2);
    p.fill(...theme.glow);
    p.ellipse(cx, cy, coreR * 4, coreR * 4);
    p.fill(255, 255, 255, 180 + bass * 75);
    p.ellipse(cx, cy, coreR * 0.5, coreR * 0.5);
  },
};
