const AuroraPreset = {
  name: "aurora",

  setup(p) {
    this.bands = 5;
    this.noiseScale = 0.003;
  },

  draw(p, audio, theme) {
    const energy = audio.getOverallEnergy();
    const bass = audio.getBassEnergy();
    const w = p.width;
    const h = p.height;
    const time = p.frameCount * 0.008;
    const idleAmp = 0.25 + p.sin(p.frameCount * 0.015) * 0.1;

    p.background(...theme.bg, 35);

    p.blendMode(p.ADD);

    for (let b = 0; b < this.bands; b++) {
      const t = b / (this.bands - 1);
      const r = p.lerp(theme.accent[0], theme.secondary[0], t);
      const g = p.lerp(theme.accent[1], theme.secondary[1], t);
      const bl = p.lerp(theme.accent[2], theme.secondary[2], t);
      const baseY = h * (0.15 + b * 0.14);
      const bandAmp = h * (0.08 + energy * 0.12 + idleAmp * 0.06) * (1 + bass * 0.5);
      const bandPhase = b * 1.7 + time;

      p.noFill();
      p.stroke(r, g, bl, 35 + energy * 45);
      p.strokeWeight(80 + b * 15 + bass * 40);

      p.beginShape();
      for (let x = 0; x <= w; x += 12) {
        const nx = x * this.noiseScale + bandPhase;
        const ny = b * 0.5 + time * 0.3;
        const n = p.noise(nx, ny);
        const n2 = p.noise(nx * 1.5 + 50, ny + 30);
        const wave =
          p.sin(x * 0.004 + bandPhase) * bandAmp * 0.3 +
          (n - 0.5) * bandAmp * 1.4 +
          (n2 - 0.5) * bandAmp * 0.6;
        p.vertex(x, baseY + wave);
      }
      p.endShape();

      p.stroke(r, g, bl, 60 + energy * 80);
      p.strokeWeight(25 + b * 8);
      p.beginShape();
      for (let x = 0; x <= w; x += 12) {
        const nx = x * this.noiseScale + bandPhase + 10;
        const ny = b * 0.5 + time * 0.3;
        const n = p.noise(nx, ny);
        const wave =
          p.sin(x * 0.003 + bandPhase + 1) * bandAmp * 0.25 +
          (n - 0.5) * bandAmp;
        p.vertex(x, baseY + wave + 30);
      }
      p.endShape();
    }

    p.blendMode(p.BLEND);

    p.noStroke();
    p.fill(...theme.glow);
    p.ellipse(w / 2, h * 0.35, w * (0.5 + bass * 0.3), h * 0.15);

    const horizonY = h * 0.72;
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      const r = p.lerp(theme.accent[0], theme.secondary[0], t);
      const g = p.lerp(theme.accent[1], theme.secondary[1], t);
      const bl = p.lerp(theme.accent[2], theme.secondary[2], t);
      p.fill(r, g, bl, 12 + energy * 20);
      p.rect(0, horizonY + i * 40, w, 60);
    }

    for (let i = 0; i < 30; i++) {
      const sx = (i * 137.5 + p.frameCount * 0.2) % w;
      const sy = h * (0.05 + (i * 0.171 % 0.5));
      const twinkle = 0.3 + 0.7 * p.sin(i + p.frameCount * 0.04);
      p.fill(255, 255, 255, twinkle * 120);
      p.ellipse(sx, sy, 2, 2);
    }
  },
};
