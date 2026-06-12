const KaleidoscopePreset = {
  name: "kaleidoscope",

  setup(p) {
    this.segments = 10;
    this.rotation = 0;
  },

  draw(p, audio, theme) {
    const freq = audio.getFrequencyData();
    const energy = audio.getOverallEnergy();
    const bass = audio.getBassEnergy();
    const w = p.width;
    const h = p.height;
    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.min(w, h) * 0.46;

    p.background(...theme.bg);

    this.rotation += 0.003 + energy * 0.02;
    const spin = this.rotation + p.sin(p.frameCount * 0.015) * 0.05;

    p.push();
    p.translate(cx, cy);
    p.rotate(spin);

    const sliceAngle = p.TWO_PI / this.segments;

    for (let s = 0; s < this.segments; s++) {
      p.push();
      p.rotate(s * sliceAngle);

      if (s % 2 === 1) {
        p.scale(1, -1);
      }

      const bars = 24;
      for (let i = 0; i < bars; i++) {
        const t = i / bars;
        const idx = Math.floor(t * freq.length * 0.65);
        const val = freq[idx] / 255;
        const idleVal = 0.15 + p.sin(i * 0.4 + p.frameCount * 0.04) * 0.1;
        const barH = (val * 0.85 + idleVal) * maxR;

        const r = p.lerp(theme.accent[0], theme.secondary[0], t);
        const g = p.lerp(theme.accent[1], theme.secondary[1], t);
        const b = p.lerp(theme.accent[2], theme.secondary[2], t);

        const innerR = 30 + bass * 40;
        const angle = t * sliceAngle * 0.9;
        const x1 = p.cos(angle) * innerR;
        const y1 = p.sin(angle) * innerR;
        const x2 = p.cos(angle) * (innerR + barH);
        const y2 = p.sin(angle) * (innerR + barH);

        p.stroke(r, g, b, 160 + val * 95);
        p.strokeWeight(3 + val * 4);
        p.line(x1, y1, x2, y2);
      }

      p.noFill();
      p.stroke(...theme.glow);
      p.strokeWeight(1.5);
      p.arc(0, 0, maxR * 2, maxR * 2, 0, sliceAngle * 0.95);

      p.pop();
    }

    p.pop();

    const coreR = 25 + bass * 55;
    p.noStroke();
    p.fill(...theme.accent, 120 + energy * 135);
    p.ellipse(cx, cy, coreR * 2, coreR * 2);
    p.fill(...theme.glow);
    p.ellipse(cx, cy, coreR * 3, coreR * 3);
  },
};
