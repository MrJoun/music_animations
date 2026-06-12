const StemVisualFX = {
  _rings: [],

  reset() {
    this._rings = [];
  },

  _drumRings(p, theme, level, beat) {
    const cx = p.width / 2;
    const cy = p.height * 0.48;
    const w = p.width;

    if (beat) {
      this._rings.push({ r: 40, alpha: 0.55 + level * 0.4 });
      if (this._rings.length > 8) this._rings.shift();
    }

    p.push();
    p.noFill();
    for (let i = this._rings.length - 1; i >= 0; i--) {
      const ring = this._rings[i];
      ring.r += 6 + level * 10;
      ring.alpha *= 0.94;
      if (ring.alpha < 0.02) {
        this._rings.splice(i, 1);
        continue;
      }
      p.stroke(theme.accent[0], theme.accent[1], theme.accent[2], ring.alpha * 180);
      p.strokeWeight(3);
      p.ellipse(cx, cy, ring.r * 2, ring.r * 2);
    }
    p.pop();
  },

  _bassPulse(p, theme, level) {
    const w = p.width;
    const h = p.height;
    const lift = level * h * 0.14;

    p.push();
    const ctx = p.drawingContext;
    const grad = ctx.createLinearGradient(0, h, 0, h - lift - 80);
    grad.addColorStop(0, `rgba(${theme.accent[0]},${theme.accent[1]},${theme.accent[2]},${0.25 + level * 0.35})`);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, h - lift - 80, w, lift + 80);

    p.noStroke();
    for (let i = 0; i < 5; i++) {
      const bw = w * (0.15 + i * 0.05);
      const bh = 8 + level * 40 + i * 6;
      p.fill(theme.secondary[0], theme.secondary[1], theme.secondary[2], 40 + level * 80);
      p.rect(w / 2 - bw / 2, h - bh - i * 14, bw, bh, 4);
    }
    p.pop();
  },

  _vocalHalo(p, theme, level) {
    const cx = p.width / 2;
    const cy = p.height * 0.42;
    const r = p.width * (0.22 + level * 0.12);

    p.push();
    p.noStroke();
    for (let i = 3; i >= 0; i--) {
      const t = i / 3;
      p.fill(
        theme.accent[0],
        theme.accent[1],
        theme.accent[2],
        (0.06 + level * 0.12) * (1 - t)
      );
      p.ellipse(cx, cy, r * (1 + t * 0.35), r * (0.85 + t * 0.2));
    }
    p.pop();
  },

  _melodicRibbons(p, theme, level) {
    const w = p.width;
    const h = p.height;
    const t = p.frameCount * 0.02;

    p.push();
    p.noFill();
    p.strokeWeight(2 + level * 2);
    for (let i = 0; i < 4; i++) {
      const col = PresetUtils.lerpColor(p, theme, i / 3);
      p.stroke(col[0], col[1], col[2], 50 + level * 120);
      p.beginShape();
      for (let x = 0; x <= w; x += 24) {
        const y =
          h * (0.15 + i * 0.06) +
          Math.sin(t + x * 0.008 + i) * (30 + level * 50);
        p.vertex(x, y);
      }
      p.endShape();
    }
    p.pop();
  },

  draw(p, theme, energy, sceneStem, intensity = 0.5) {
    if (!energy || intensity <= 0.05) return;

    const stem = sceneStem || energy.dominantStem || "melodic";
    const scale = 0.45 + intensity * 0.55;

    const levels = {
      vocals: (energy.stemVocals ?? energy.vocal) * scale,
      bass: (energy.stemBass ?? energy.bass) * scale,
      drums: (energy.stemDrums ?? 0.2) * scale,
      melodic: (energy.stemMelodic ?? energy.mids) * scale,
    };

    p.push();
    p.blendMode(p.ADD);

    switch (stem) {
      case "drums":
        this._drumRings(p, theme, levels.drums, energy.lastBeat);
        break;
      case "bass":
        this._bassPulse(p, theme, levels.bass);
        break;
      case "vocals":
        this._vocalHalo(p, theme, levels.vocals);
        break;
      default:
        this._melodicRibbons(p, theme, levels.melodic);
        break;
    }

    p.blendMode(p.BLEND);
    p.pop();

    p.push();
    p.textAlign(p.LEFT, p.TOP);
    p.textSize(18);
    p.fill(255, 255, 255, 45);
    p.text(StemAnalyzer.label(stem).toUpperCase(), 28, 64);
    p.pop();
  },
};
