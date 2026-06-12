const TypographyPreset = {
  name: "typography",
  words: [],
  pool: [],
  slamIdx: 0,
  prevBeat: false,
  lastText: "",

  setup(p) {
    this.words = [];
    this.pool = [];
    this.slamIdx = 0;
    this.prevBeat = false;
    this.lastText = "";
    p.textFont("sans-serif");
  },

  _parseWords(options) {
    if (options?.lyrics?.hasLines()) {
      const line = options.lyrics.getCurrentLine();
      if (line) return line.split(/\s+/).filter((w) => w.length > 0);
      const all = options.lyrics.getAllLines();
      if (all.length) return all.join(" ").split(/\s+/).filter(Boolean);
    }
    const raw =
      options && options.customText && options.customText.trim()
        ? options.customText.trim()
        : "FEEL THE BEAT";
    return raw.split(/\s+/).filter((w) => w.length > 0);
  },

  _spawnWord(p, text, slam) {
    const depth = p.random(0.35, 1.4);
    const cx = p.width / 2;
    const cy = p.height * 0.42;
    return {
      text: text.toUpperCase(),
      x: slam ? cx + p.random(-p.width * 0.6, p.width * 0.6) : cx + p.random(-280, 280),
      y: slam ? cy + p.random(-p.height * 0.5, p.height * 0.5) : cy + p.random(-320, 320),
      targetX: cx + p.random(-220, 220),
      targetY: cy + p.random(-280, 280),
      z: depth,
      rot: slam ? p.random(-p.PI, p.PI) : p.random(-0.15, 0.15),
      targetRot: p.random(-0.08, 0.08),
      scale: slam ? p.random(2.5, 4.5) : p.random(0.6, 1.2),
      targetScale: p.map(depth, 0.35, 1.4, 1.35, 0.55),
      glitchX: 0,
      glitchY: 0,
      glitchT: 0,
      hue: p.random(1),
      life: 1,
      slam,
      vx: p.random(-0.4, 0.4),
      vy: p.random(-0.3, 0.3),
      wobble: p.random(p.TWO_PI),
    };
  },

  _refreshPool(p, options) {
    const parsed = this._parseWords(options);
    const key = parsed.join("|");
    if (key !== this.lastText) {
      this.pool = parsed;
      this.slamIdx = 0;
      this.lastText = key;
    }
    if (this.pool.length === 0) this.pool = ["FEEL", "THE", "BEAT"];
  },

  draw(p, audio, theme, options = {}) {
    const bass = PresetUtils.idleBass(p, audio);
    const energy = PresetUtils.idleEnergy(p, audio);
    const beat = audio.detectBeat();
    const w = p.width;
    const h = p.height;
    const cx = w / 2;
    const cy = h * 0.42;
    const idle = p.frameCount * 0.018;

    this._refreshPool(p, options);

    p.background(...theme.bg, 35);

    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      const col = PresetUtils.lerpColor(p, theme, t);
      p.noStroke();
      p.fill(col[0], col[1], col[2], 6 + energy * 12);
      const r = 180 + i * 90 + p.sin(idle + i) * 40;
      p.ellipse(cx, cy, r * 2, r * 1.6);
    }

    if (beat && !this.prevBeat) {
      const word = this.pool[this.slamIdx % this.pool.length];
      this.slamIdx++;
      this.words.push(this._spawnWord(p, word, true));
      if (this.words.length > 14) this.words.shift();
    }
    this.prevBeat = beat;

    if (p.frameCount % 45 === 0 && this.words.length < 10) {
      const word = this.pool[p.floor(p.random(this.pool.length))];
      this.words.push(this._spawnWord(p, word, false));
    }

    this.words.sort((a, b) => a.z - b.z);

    for (let i = this.words.length - 1; i >= 0; i--) {
      const wd = this.words[i];

      if (wd.slam) {
        wd.x = p.lerp(wd.x, wd.targetX, 0.14);
        wd.y = p.lerp(wd.y, wd.targetY, 0.14);
        wd.scale = p.lerp(wd.scale, wd.targetScale, 0.12);
        wd.rot = p.lerp(wd.rot, wd.targetRot, 0.1);
        if (p.abs(wd.scale - wd.targetScale) < 0.05) wd.slam = false;
      } else {
        wd.x += wd.vx + p.sin(wd.wobble + idle) * 0.6;
        wd.y += wd.vy + p.cos(wd.wobble * 1.3 + idle * 0.8) * 0.5;
        wd.z += p.sin(idle + wd.wobble) * 0.002;
        wd.rot += p.sin(idle + i) * 0.004;
        wd.scale = wd.targetScale * (1 + bass * 0.25 + p.sin(wd.wobble + idle) * 0.06);
      }

      if (beat || energy > 0.35) {
        wd.glitchT = 8;
        wd.glitchX = p.random(-18, 18) * (energy + bass);
        wd.glitchY = p.random(-8, 8) * (energy + bass);
      }
      if (wd.glitchT > 0) {
        wd.glitchT--;
        wd.glitchX *= 0.82;
        wd.glitchY *= 0.82;
      }

      const persp = 1 / (wd.z + 0.15);
      const px = wd.x + wd.glitchX;
      const py = wd.y + wd.glitchY;
      const sz = 72 * wd.scale * persp * (1 + bass * 0.15);
      const alpha = p.map(wd.z, 0.35, 1.4, 255, 120) * wd.life;
      const col = PresetUtils.lerpColor(p, theme, wd.hue);

      p.push();
      p.translate(px, py);
      p.rotate(wd.rot);
      p.textAlign(p.CENTER, p.CENTER);
      p.textSize(sz);

      if (wd.glitchT > 0) {
        p.fill(theme.secondary[0], theme.secondary[1], theme.secondary[2], alpha * 0.7);
        p.text(wd.text, 4, -3);
        p.fill(theme.accent[0], theme.accent[1], theme.accent[2], alpha * 0.5);
        p.text(wd.text, -5, 2);
      }

      p.fill(...theme.glow);
      p.text(wd.text, 0, 0);
      p.fill(col[0], col[1], col[2], alpha);
      p.text(wd.text, 0, 0);

      p.stroke(col[0], col[1], col[2], alpha * 0.35);
      p.strokeWeight(1.5 * persp);
      p.noFill();
      p.rect(-sz * wd.text.length * 0.28, -sz * 0.55, sz * wd.text.length * 0.56, sz * 1.1);

      p.pop();

      wd.life -= 0.0015;
      if (wd.life <= 0) this.words.splice(i, 1);
    }

    p.push();
    p.translate(cx, cy);
    p.textAlign(p.CENTER, p.CENTER);
    p.textSize(140 + bass * 40 + p.sin(idle * 2) * 12);
    const hero = this.pool[this.slamIdx % this.pool.length].toUpperCase();
    const heroCol = PresetUtils.lerpColor(p, theme, 0.5);
    p.fill(...theme.glow);
    p.text(hero, 0, h * 0.08);
    p.fill(heroCol[0], heroCol[1], heroCol[2], 180 + energy * 75);
    p.text(hero, 0, h * 0.08);
    p.pop();

    const vig = p.drawingContext.createRadialGradient(cx, cy, h * 0.05, cx, cy, h * 0.75);
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, `rgba(${theme.bg[0]},${theme.bg[1]},${theme.bg[2]},0.55)`);
    p.drawingContext.fillStyle = vig;
    p.drawingContext.fillRect(0, 0, w, h);
  },
};
