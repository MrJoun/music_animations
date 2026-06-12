const TunnelPreset = {
  name: "tunnel",
  rings: [],

  setup(p) {
    this.rings = [];
    const count = 28;
    for (let i = 0; i < count; i++) {
      this.rings.push({ z: i / count });
    }
  },

  draw(p, audio, theme) {
    const freq = audio.getFrequencyData();
    const energy = audio.getOverallEnergy();
    const bass = audio.getBassEnergy();
    const w = p.width;
    const h = p.height;
    const cx = w / 2;
    const cy = h / 2;
    const fov = 1.8;
    const speed = 0.012 + energy * 0.025 + p.sin(p.frameCount * 0.02) * 0.003;

    p.background(...theme.bg);

    for (const ring of this.rings) {
      ring.z += speed;
      if (ring.z > 1) ring.z -= 1;
    }

    this.rings.sort((a, b) => b.z - a.z);

    for (const ring of this.rings) {
      const depth = ring.z;
      if (depth < 0.02) continue;

      const scale = fov / depth;
      const radius = Math.min(w, h) * 0.38 * scale;
      const alpha = p.map(depth, 0, 1, 255, 40);
      const t = depth;
      const r = p.lerp(theme.accent[0], theme.secondary[0], t);
      const g = p.lerp(theme.accent[1], theme.secondary[1], t);
      const b = p.lerp(theme.accent[2], theme.secondary[2], t);

      const segments = 48;
      const wobble =
        bass * 30 * scale +
        p.sin(depth * 12 + p.frameCount * 0.05) * 8 * (1 - depth);

      p.noFill();
      p.stroke(r, g, b, alpha);
      p.strokeWeight(p.map(depth, 0, 1, 6, 1.5));

      p.beginShape();
      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * p.TWO_PI;
        const idx = Math.floor((i / segments) * freq.length * 0.5);
        const val = freq[idx] / 255;
        const idle = 0.08 + p.sin(i * 0.3 + p.frameCount * 0.03) * 0.05;
        const rDist = radius + (val * 0.25 + idle) * radius * 0.35 + wobble;
        const x = cx + p.cos(angle) * rDist;
        const y = cy + p.sin(angle) * rDist * 0.72;
        p.vertex(x, y);
      }
      p.endShape(p.CLOSE);

      if (depth < 0.15) {
        p.stroke(...theme.glow);
        p.strokeWeight(3 + bass * 5);
        p.ellipse(cx, cy, radius * 2.1, radius * 1.5);
      }
    }

    const vignette = p.drawingContext.createRadialGradient(
      cx, cy, h * 0.1,
      cx, cy, h * 0.7
    );
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, `rgba(${theme.bg[0]},${theme.bg[1]},${theme.bg[2]},0.6)`);
    p.drawingContext.fillStyle = vignette;
    p.drawingContext.fillRect(0, 0, w, h);
  },
};
