const BarsPreset = {
  name: "bars",

  setup(p) {
    this.barCount = 64;
  },

  draw(p, audio, theme) {
    const freq = PresetUtils.getFreq(p, audio);
    const w = p.width;
    const h = p.height;
    const barW = w / this.barCount;
    const idle = PresetUtils.idleBass(p, audio);

    p.background(...theme.bg);

    const midY = h / 2;
    const maxH = h * 0.42;

    for (let i = 0; i < this.barCount; i++) {
      const idx = Math.floor((i / this.barCount) * freq.length * 0.7);
      const val = freq[idx] / 255;
      const barH = Math.max(4, val * maxH + idle * 20);

      const t = i / this.barCount;
      const r = p.lerp(theme.accent[0], theme.secondary[0], t);
      const g = p.lerp(theme.accent[1], theme.secondary[1], t);
      const b = p.lerp(theme.accent[2], theme.secondary[2], t);

      p.noStroke();
      p.fill(r, g, b, 200);
      p.rect(i * barW, midY - barH, barW - 2, barH);

      p.fill(r, g, b, 120);
      p.rect(i * barW, midY, barW - 2, barH * 0.6);
    }

    const bass = PresetUtils.idleBass(p, audio);
    if (bass > 0.15) {
      p.noFill();
      p.stroke(...theme.glow);
      p.strokeWeight(2);
      p.ellipse(w / 2, midY, bass * w * 0.8, bass * h * 0.15);
    }
  },
};
