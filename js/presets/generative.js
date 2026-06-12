const GenerativePreset = {
  name: "generative",
  blobs: [],
  shards: [],
  ripples: [],
  prevBeat: false,
  prevDrop: false,
  prevBass: 0.15,
  noiseZ: 0,

  _bandEnergy(freq, start, end) {
    let sum = 0;
    const hi = Math.min(end, freq.length);
    const n = hi - start;
    if (n <= 0) return 0;
    for (let i = start; i < hi; i++) sum += freq[i];
    return sum / n / 255;
  },

  _readEnergy(p, audio, options = {}) {
    const ea = options.energy;
    const freq = PresetUtils.getFreq(p, audio);
    const bassFallback = PresetUtils.idleBass(p, audio);
    const overallFallback = PresetUtils.idleEnergy(p, audio);

    if (ea) {
      const bass = typeof ea.getBass === "function" ? ea.getBass() : ea.bass ?? bassFallback;
      const mids = typeof ea.getMids === "function" ? ea.getMids() : ea.mids ?? this._bandEnergy(freq, 12, 72);
      const treble =
        typeof ea.getTreble === "function" ? ea.getTreble() : ea.treble ?? this._bandEnergy(freq, 72, 180);
      const vocals =
        typeof ea.getVocals === "function" ? ea.getVocals() : ea.vocals ?? this._bandEnergy(freq, 8, 40);
      const overall =
        typeof ea.getOverall === "function" ? ea.getOverall() : ea.overall ?? overallFallback;
      const beat = typeof ea.detectBeat === "function" ? ea.detectBeat() : audio.detectBeat();
      const drop =
        typeof ea.detectDrop === "function"
          ? ea.detectDrop()
          : bass > 0.38 && overall > 0.28 && bass - this.prevBass > 0.07;
      return { bass, mids, treble, vocals, overall, beat, drop, freq };
    }

    const bass = bassFallback;
    const overall = overallFallback;
    const beat = audio.detectBeat();
    const drop = bass > 0.38 && overall > 0.28 && bass - this.prevBass > 0.07;
    return {
      bass,
      mids: this._bandEnergy(freq, 12, 72),
      treble: this._bandEnergy(freq, 72, 180),
      vocals: this._bandEnergy(freq, 8, 40),
      overall,
      beat,
      drop,
      freq,
    };
  },

  setup(p) {
    this.blobs = [];
    this.shards = [];
    this.ripples = [];
    this.prevBeat = false;
    this.prevDrop = false;
    this.prevBass = 0.15;
    this.noiseZ = p.random(1000);

    const blobCount = 16;
    for (let i = 0; i < blobCount; i++) {
      this.blobs.push({
        x: p.random(p.width * 0.08, p.width * 0.92),
        y: p.random(p.height * 0.1, p.height * 0.9),
        baseR: p.random(55, 130),
        hue: p.random(1),
        seed: p.random(1000),
        drift: p.random(0.4, 1.2),
        phase: p.random(p.TWO_PI),
        flash: 0,
        satellites: [],
      });
    }

    for (let i = 0; i < 38; i++) {
      this.shards.push(this._makeShard(p));
    }
  },

  _makeShard(p) {
    return {
      x: p.random(p.width),
      y: p.random(p.height),
      vx: p.random(-2.5, 2.5),
      vy: p.random(-2.5, 2.5),
      spin: p.random(-0.12, 0.12),
      angle: p.random(p.TWO_PI),
      size: p.random(8, 22),
      hue: p.random(1),
      kind: p.random() < 0.5 ? "tri" : "diamond",
      blink: p.random(1),
      life: 1,
    };
  },

  _spawnSatellite(p, blob) {
    const angle = p.random(p.TWO_PI);
    blob.satellites.push({
      angle,
      dist: blob.baseR * p.random(0.4, 0.9),
      r: p.random(8, 22),
      hue: p.random(1),
      life: 1,
      spin: p.random(-0.08, 0.08),
    });
    if (blob.satellites.length > 12) blob.satellites.shift();
  },

  _drawFluidBg(p, theme, energy, bass, t) {
    const w = p.width;
    const h = p.height;
    p.noStroke();

    for (let layer = 0; layer < 6; layer++) {
      const lt = layer / 5;
      const col = PresetUtils.lerpColor(p, theme, lt + p.sin(t * 0.3 + layer) * 0.15);
      const cx = w * (0.3 + 0.4 * p.noise(layer * 0.7, t * 0.12));
      const cy = h * (0.25 + 0.5 * p.noise(layer * 0.7 + 40, t * 0.1));
      const rw = w * (0.55 + energy * 0.25 + bass * 0.2);
      const rh = h * (0.45 + energy * 0.2);
      p.fill(col[0], col[1], col[2], 10 + layer * 4 + energy * 14);
      p.ellipse(cx, cy, rw, rh);
    }

    p.fill(...theme.bg, 18);
    p.rect(0, 0, w, h);

    for (let i = 0; i < 24; i++) {
      const nx = i * 0.17 + t * 0.08;
      const ny = i * 0.11;
      const px = p.noise(nx, ny) * w;
      const py = p.noise(nx + 30, ny + 20) * h;
      const col = PresetUtils.lerpColor(p, theme, (i / 23 + t * 0.05) % 1);
      p.fill(col[0], col[1], col[2], 6 + energy * 10);
      p.ellipse(px, py, 120 + bass * 80, 90 + energy * 60);
    }
  },

  _drawBlob(p, blob, theme, bass, energy, t, flashAll) {
    const col = PresetUtils.lerpColor(p, theme, blob.hue);
    const pulse = 1 + bass * 0.45 + p.sin(blob.phase + t * 0.8) * 0.08;
    const r = blob.baseR * pulse;
    const flash = Math.max(blob.flash, flashAll ? 0.85 : 0);

    blob.x += p.sin(blob.phase + t * blob.drift) * 0.6;
    blob.y += p.cos(blob.phase * 1.3 + t * blob.drift * 0.7) * 0.5;
    blob.x = p.constrain(blob.x, r, p.width - r);
    blob.y = p.constrain(blob.y, r, p.height - r);
    blob.flash *= 0.88;

    const layers = 14;
    p.noStroke();
    for (let i = 0; i < layers; i++) {
      const lt = i / layers;
      const n = p.noise(blob.seed * 0.01, lt * 2, t * 0.35 + this.noiseZ);
      const n2 = p.noise(blob.seed * 0.02 + 50, lt, t * 0.28);
      const ox = (n - 0.5) * r * 0.9;
      const oy = (n2 - 0.5) * r * 0.9;
      const rr = r * (0.35 + lt * 0.75) * (0.85 + (n - 0.5) * 0.35);
      const alpha = (35 + lt * 55 + energy * 70) * (1 - lt * 0.35);
      if (flash > 0.2) {
        p.fill(255, 255, 255, alpha * flash * 0.9);
      } else {
        p.fill(col[0], col[1], col[2], alpha);
      }
      p.ellipse(blob.x + ox, blob.y + oy, rr * 2, rr * 2 * (0.82 + n2 * 0.28));
    }

    p.noFill();
    p.stroke(col[0], col[1], col[2], 40 + energy * 50);
    p.strokeWeight(1.2);
    const contourSteps = 28;
    p.beginShape();
    for (let i = 0; i <= contourSteps; i++) {
      const ang = (i / contourSteps) * p.TWO_PI;
      const cn = p.noise(blob.seed * 0.03, ang * 0.5, t * 0.4);
      const rad = r * (0.72 + cn * 0.38);
      p.vertex(blob.x + p.cos(ang) * rad, blob.y + p.sin(ang) * rad);
    }
    p.endShape(p.CLOSE);

    for (let s = blob.satellites.length - 1; s >= 0; s--) {
      const sat = blob.satellites[s];
      sat.angle += sat.spin;
      sat.life -= 0.012;
      const sx = blob.x + p.cos(sat.angle) * sat.dist;
      const sy = blob.y + p.sin(sat.angle) * sat.dist;
      const sc = PresetUtils.lerpColor(p, theme, sat.hue);
      p.noStroke();
      p.fill(sc[0], sc[1], sc[2], 120 * sat.life);
      p.ellipse(sx, sy, sat.r * 2, sat.r * 2);
      if (sat.life <= 0) blob.satellites.splice(s, 1);
    }

    return { x: blob.x, y: blob.y, r };
  },

  _drawConnections(p, centers, theme, beatEdge, energy) {
    if (centers.length < 2) return;

    p.stroke(...theme.glow);
    p.strokeWeight(1.2 + energy * 1.5);
    p.noFill();

    for (let i = 0; i < centers.length; i++) {
      for (let j = i + 1; j < centers.length; j++) {
        const a = centers[i];
        const b = centers[j];
        const d = p.dist(a.x, a.y, b.x, b.y);
        if (d > 420) continue;
        const strength = p.map(d, 80, 420, 1, 0.15);
        const alpha = (40 + beatEdge * 160 + energy * 60) * strength;
        const col = PresetUtils.lerpColor(p, theme, (i + j) * 0.07 % 1);
        p.stroke(col[0], col[1], col[2], alpha);
        p.line(a.x, a.y, b.x, b.y);

        const mx = (a.x + b.x) * 0.5;
        const my = (a.y + b.y) * 0.5;
        const nx = mx + p.sin(p.frameCount * 0.1 + i) * 12;
        const ny = my + p.cos(p.frameCount * 0.12 + j) * 12;
        p.stroke(...theme.glow, alpha * 0.5);
        p.line(a.x, a.y, nx, ny);
        p.line(nx, ny, b.x, b.y);
      }
    }
  },

  _drawShard(p, sh, theme, bass, energy, beatEdge) {
    sh.x += sh.vx * (1 + energy * 2.5);
    sh.y += sh.vy * (1 + energy * 2.5);
    sh.angle += sh.spin * (1 + bass * 3);

    if (sh.x < -30 || sh.x > p.width + 30 || sh.y < -30 || sh.y > p.height + 30) {
      Object.assign(sh, this._makeShard(p));
      return;
    }

    if (beatEdge > 0.5) {
      sh.blink = 1;
      sh.vx += p.random(-3, 3);
      sh.vy += p.random(-3, 3);
      sh.spin += p.random(-0.06, 0.06);
    }
    sh.blink *= 0.9;

    const col = PresetUtils.lerpColor(p, theme, sh.hue);
    const alpha = 80 + energy * 140 + sh.blink * 120;
    const sz = sh.size * (1 + bass * 0.5 + sh.blink * 0.4);

    p.push();
    p.translate(sh.x, sh.y);
    p.rotate(sh.angle);
    p.noStroke();
    if (sh.blink > 0.35) {
      p.fill(255, 255, 255, alpha * sh.blink);
    } else {
      p.fill(col[0], col[1], col[2], alpha);
    }

    if (sh.kind === "tri") {
      p.triangle(-sz, sz * 0.6, sz, sz * 0.6, 0, -sz * 0.9);
    } else {
      p.quad(0, -sz, sz * 0.7, 0, 0, sz, -sz * 0.7, 0);
    }
    p.pop();
  },

  draw(p, audio, theme, options = {}) {
    const e = this._readEnergy(p, audio, options);
    const beatEdge = e.beat && !this.prevBeat ? 1 : 0;
    const dropEdge = e.drop && !this.prevDrop ? 1 : 0;
    const t = p.frameCount * 0.016;
    const w = p.width;
    const h = p.height;

    this.noiseZ += 0.012 + e.overall * 0.01;

    p.background(...theme.bg, 28);
    this._drawFluidBg(p, theme, e.overall, e.bass, t);

    if (dropEdge) {
      for (const blob of this.blobs) blob.flash = 1;
    }
    if (beatEdge) {
      for (let i = 0; i < 4; i++) {
        const blob = this.blobs[p.floor(p.random(this.blobs.length))];
        this._spawnSatellite(p, blob);
      }
    }
    if (e.vocals > 0.22 && p.frameCount % 6 === 0) {
      const blob = this.blobs[p.floor(p.random(this.blobs.length))];
      this._spawnSatellite(p, blob);
    }

    const centers = [];
    for (const blob of this.blobs) {
      centers.push(this._drawBlob(p, blob, theme, e.bass, e.overall, t, dropEdge > 0));
    }

    this._drawConnections(p, centers, theme, beatEdge || e.overall * 0.4, e.overall);

    p.blendMode(p.ADD);
    for (const sh of this.shards) {
      this._drawShard(p, sh, theme, e.bass, e.overall, beatEdge);
    }
    p.blendMode(p.BLEND);

    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const rp = this.ripples[i];
      rp.r += 6 + e.bass * 10;
      rp.a -= 5;
      const col = PresetUtils.lerpColor(p, theme, rp.hue);
      p.noFill();
      p.stroke(col[0], col[1], col[2], rp.a);
      p.strokeWeight(2);
      p.ellipse(rp.x, rp.y, rp.r * 2, rp.r * 2);
      if (rp.a <= 0) this.ripples.splice(i, 1);
    }

    if (beatEdge) {
      for (let i = 0; i < 3; i++) {
        this.ripples.push({
          x: p.random(w * 0.1, w * 0.9),
          y: p.random(h * 0.1, h * 0.9),
          r: 20,
          a: 140,
          hue: p.random(1),
        });
      }
    }

    const vig = p.drawingContext.createRadialGradient(w / 2, h * 0.45, h * 0.05, w / 2, h * 0.45, h * 0.92);
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, `rgba(${theme.bg[0]},${theme.bg[1]},${theme.bg[2]},0.55)`);
    p.drawingContext.fillStyle = vig;
    p.drawingContext.fillRect(0, 0, w, h);

    p.noStroke();
    p.fill(...theme.glow);
    p.ellipse(w / 2, h * 0.5, 60 + e.bass * 100, 60 + e.overall * 80);

    this.prevBeat = e.beat;
    this.prevDrop = e.drop;
    this.prevBass = e.bass;
  },
};
