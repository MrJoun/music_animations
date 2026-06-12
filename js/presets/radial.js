const RadialPreset = {
  name: "radial",
  rings: [],

  setup(p) {
    this.rings = [];
  },

  draw(p, audio, theme) {
    const bass = audio.getBassEnergy();
    const energy = audio.getOverallEnergy();
    const beat = audio.detectBeat();

    p.background(...theme.bg);

    const cx = p.width / 2;
    const cy = p.height / 2;
    const maxR = Math.min(p.width, p.height) * 0.45;

    if (beat) {
      this.rings.push({
        r: 10,
        alpha: 255,
        weight: 2 + bass * 6,
      });
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      ring.r += 3 + energy * 8;
      ring.alpha -= 3;

      const progress = ring.r / maxR;
      const r = p.lerp(theme.accent[0], theme.secondary[0], progress);
      const g = p.lerp(theme.accent[1], theme.secondary[1], progress);
      const b = p.lerp(theme.accent[2], theme.secondary[2], progress);

      p.noFill();
      p.stroke(r, g, b, ring.alpha);
      p.strokeWeight(ring.weight);
      p.ellipse(cx, cy, ring.r * 2, ring.r * 2);

      if (ring.alpha <= 0 || ring.r > maxR) {
        this.rings.splice(i, 1);
      }
    }

    const pulseR = 40 + bass * maxR * 0.6;
    p.noFill();
    p.stroke(...theme.glow);
    p.strokeWeight(3);
    p.ellipse(cx, cy, pulseR * 2, pulseR * 2);

    p.fill(...theme.accent, 180 + bass * 75);
    p.noStroke();
    p.ellipse(cx, cy, 20 + bass * 40, 20 + bass * 40);

    const freq = audio.getFrequencyData();
    const segments = 48;
    p.noFill();
    p.stroke(...theme.secondary, 150);
    p.strokeWeight(2);
    p.beginShape();
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * p.TWO_PI - p.HALF_PI;
      const idx = Math.floor((i / segments) * freq.length * 0.5);
      const val = freq[idx] / 255;
      const r = 60 + val * maxR * 0.5;
      const x = cx + p.cos(angle) * r;
      const y = cy + p.sin(angle) * r;
      if (i === 0) p.vertex(x, y);
      else p.vertex(x, y);
    }
    p.endShape(p.CLOSE);
  },
};
