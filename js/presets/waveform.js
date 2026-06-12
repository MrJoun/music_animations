const WaveformPreset = {
  name: "waveform",

  setup(p) {
    this.layers = 6;
  },

  draw(p, audio, theme) {
    const wave = audio.getWaveformData();
    const energy = audio.getOverallEnergy();
    const bass = audio.getBassEnergy();
    const w = p.width;
    const h = p.height;
    const midY = h / 2;
    const idle = 0.12 + p.sin(p.frameCount * 0.018) * 0.08;
    const amp = h * 0.2 * (0.35 + energy * 0.65 + idle);
    const points = 160;

    p.background(...theme.bg);

    for (let layer = 0; layer < this.layers; layer++) {
      const t = layer / Math.max(this.layers - 1, 1);
      const r = p.lerp(theme.accent[0], theme.secondary[0], t);
      const g = p.lerp(theme.accent[1], theme.secondary[1], t);
      const b = p.lerp(theme.accent[2], theme.secondary[2], t);
      const alpha = 60 + layer * 30;

      p.noFill();
      p.stroke(r, g, b, alpha);
      p.strokeWeight(4 - layer * 0.5);
      p.strokeCap(p.ROUND);
      p.strokeJoin(p.ROUND);

      const layerScale = 1 - layer * 0.1;
      const phase = layer * 0.7 + p.frameCount * 0.025;

      p.beginShape();
      for (let i = 0; i < points; i++) {
        const idx = Math.floor((i / points) * wave.length);
        const val = (wave[idx] - 128) / 128;
        const idleWave = p.sin(i * 0.06 + phase) * idle;
        const x = (i / (points - 1)) * w;
        const y = midY - amp * (val * layerScale + idleWave);
        p.vertex(x, y);
      }
      p.endShape();

      p.beginShape();
      for (let i = 0; i < points; i++) {
        const idx = Math.floor((i / points) * wave.length);
        const val = (wave[idx] - 128) / 128;
        const idleWave = p.sin(i * 0.06 + phase) * idle;
        const x = (i / (points - 1)) * w;
        const y = midY + amp * (val * layerScale + idleWave);
        p.vertex(x, y);
      }
      p.endShape();
    }

    p.noFill();
    p.stroke(...theme.glow);
    p.strokeWeight(2 + bass * 8);
    p.line(0, midY, w, midY);

    const glowW = w * (0.3 + bass * 0.5);
    p.fill(...theme.accent, 30 + bass * 50);
    p.noStroke();
    p.ellipse(w / 2, midY, glowW, h * 0.08);
  },
};
