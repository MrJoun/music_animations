const StormPreset = {
  name: "storm",
  objects: [],
  textShards: [],
  prevBeat: false,
  prevDrop: false,
  prevBass: 0.15,

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

  _parseWords(options) {
    const raw =
      options && options.customText && options.customText.trim()
        ? options.customText.trim()
        : "STORM";
    return raw.split(/\s+/).filter(Boolean);
  },

  setup(p) {
    this.objects = [];
    this.textShards = [];
    this.prevBeat = false;
    this.prevDrop = false;
    this.prevBass = 0.15;

    const types = ["cube", "sphere", "star", "lightning"];
    for (let i = 0; i < 58; i++) {
      this.objects.push(this._makeObject(p, types[i % types.length]));
    }
  },

  _makeObject(p, type) {
    const kinds = ["cube", "sphere", "star", "lightning"];
    return {
      type: type || kinds[p.floor(p.random(kinds.length))],
      x: p.random(-0.95, 0.95),
      y: p.random(-0.95, 0.95),
      z: p.random(0.2, 2.4),
      vx: p.random(-0.004, 0.004),
      vy: p.random(-0.004, 0.004),
      vz: p.random(-0.003, 0.003),
      rx: p.random(p.TWO_PI),
      ry: p.random(p.TWO_PI),
      rz: p.random(p.TWO_PI),
      spin: p.random(0.01, 0.04),
      size: p.random(0.14, 0.38),
      hue: p.random(1),
      pulse: p.random(p.TWO_PI),
      alphaPulse: 0,
      flyDir: p.random() < 0.5 ? -1 : 1,
    };
  },

  _spawnBurst(p, count, towardCamera) {
    const types = ["cube", "sphere", "star", "lightning"];
    for (let i = 0; i < count; i++) {
      const obj = this._makeObject(p, types[p.floor(p.random(types.length))]);
      obj.x = p.random(-0.6, 0.6);
      obj.y = p.random(-0.6, 0.6);
      obj.z = towardCamera ? p.random(1.8, 2.6) : p.random(0.15, 0.5);
      obj.vz = towardCamera ? -0.12 - p.random(0.08) : 0.08 + p.random(0.06);
      obj.alphaPulse = 1;
      obj.size = p.random(0.18, 0.45);
      this.objects.push(obj);
    }
    while (this.objects.length > 95) this.objects.shift();
  },

  _spawnTextShard(p, options, theme) {
    const words = this._parseWords(options);
    const word = words[p.floor(p.random(words.length))];
    const chars = word.split("");
    const ch = chars[p.floor(p.random(chars.length))];
    this.textShards.push({
      char: ch,
      x: p.random(p.width * 0.1, p.width * 0.9),
      y: p.random(p.height * 0.15, p.height * 0.85),
      vx: p.random(-4, 4),
      vy: p.random(-5, 2),
      rot: p.random(-0.2, 0.2),
      spin: p.random(-0.15, 0.15),
      size: p.random(22, 48),
      hue: p.random(1),
      life: 1,
    });
    if (this.textShards.length > 40) this.textShards.shift();
  },

  _project(p, obj, cx, cy, fov, w, h) {
    const depth = Math.max(0.12, obj.z);
    const scale = fov / (depth + 0.2);
    const px = cx + (obj.x * w * 0.38 + p.sin(obj.pulse) * 8) * scale * 0.42;
    const py = cy + (obj.y * h * 0.34 + p.cos(obj.pulse * 1.2) * 6) * scale * 0.42;
    const sz = obj.size * scale * 0.22;
    return { x: px, y: py, sz, depth };
  },

  _drawCube(p, x, y, sz, col, glow, alpha, weight) {
    const h = sz * 0.5;
    const verts = [
      [-h, -h],
      [h, -h],
      [h, h],
      [-h, h],
    ];
    p.noFill();
    p.stroke(...glow);
    p.strokeWeight(weight * 1.8);
    for (let i = 0; i < 4; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % 4];
      p.line(x + a[0], y + a[1], x + b[0], y + b[1]);
    }
    p.stroke(col[0], col[1], col[2], alpha);
    p.strokeWeight(weight);
    for (let i = 0; i < 4; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % 4];
      p.line(x + a[0], y + a[1], x + b[0], y + b[1]);
    }
    p.line(x - h, y - h, x + h, y + h);
    p.line(x + h, y - h, x - h, y + h);
  },

  _drawSphere(p, x, y, sz, col, glow, alpha, weight) {
    p.noFill();
    p.stroke(...glow);
    p.strokeWeight(weight * 1.6);
    p.ellipse(x, y, sz * 2, sz * 2);
    p.stroke(col[0], col[1], col[2], alpha);
    p.strokeWeight(weight);
    p.ellipse(x, y, sz * 2, sz * 2);
    p.ellipse(x, y, sz * 1.4, sz * 0.9);
    p.ellipse(x, y, sz * 0.9, sz * 1.4);
  },

  _drawStar(p, x, y, sz, rot, col, alpha) {
    p.push();
    p.translate(x, y);
    p.rotate(rot);
    p.noStroke();
    p.fill(col[0], col[1], col[2], alpha);
    p.beginShape();
    for (let i = 0; i < 10; i++) {
      const ang = (i / 10) * p.TWO_PI - p.HALF_PI;
      const rad = i % 2 === 0 ? sz : sz * 0.42;
      p.vertex(p.cos(ang) * rad, p.sin(ang) * rad);
    }
    p.endShape(p.CLOSE);
    p.pop();
  },

  _drawLightning(p, x, y, sz, col, glow, alpha, weight) {
    const pts = [
      [0, -sz],
      [sz * 0.25, -sz * 0.2],
      [sz * 0.05, -sz * 0.15],
      [sz * 0.35, sz * 0.55],
      [sz * 0.08, sz * 0.1],
      [sz * 0.22, sz],
      [-sz * 0.12, sz * 0.15],
      [-sz * 0.02, -sz * 0.05],
      [-sz * 0.28, -sz * 0.55],
    ];
    p.noFill();
    p.stroke(...glow);
    p.strokeWeight(weight * 2);
    p.beginShape();
    for (const pt of pts) p.vertex(x + pt[0], y + pt[1]);
    p.endShape();
    p.stroke(col[0], col[1], col[2], alpha);
    p.strokeWeight(weight);
    p.beginShape();
    for (const pt of pts) p.vertex(x + pt[0], y + pt[1]);
    p.endShape();
  },

  draw(p, audio, theme, options = {}) {
    const e = this._readEnergy(p, audio, options);
    const beatEdge = e.beat && !this.prevBeat ? 1 : 0;
    const dropEdge = e.drop && !this.prevDrop ? 1 : 0;
    const w = p.width;
    const h = p.height;
    const cx = w / 2;
    const cy = h * 0.48;
    const fov = Math.min(w, h) * 0.42;
    const idle = p.frameCount * 0.016;

    p.background(...theme.bg, 42);

    for (let i = 0; i < 10; i++) {
      const t = i / 9;
      const col = PresetUtils.lerpColor(p, theme, t + p.sin(idle * 0.4 + i) * 0.1);
      p.noStroke();
      p.fill(col[0], col[1], col[2], 5 + e.overall * 10);
      const depth = 0.4 + i * 0.12;
      const s = fov / depth;
      p.ellipse(cx, cy, s * 1.6, s * 1.3);
    }

    if (beatEdge) this._spawnBurst(p, 15, false);
    if (dropEdge) this._spawnBurst(p, 30, true);
    if (e.vocals > 0.2 && p.frameCount % 5 === 0) {
      this._spawnTextShard(p, options, theme);
    }
    if (beatEdge && e.vocals > 0.15) {
      this._spawnTextShard(p, options, theme);
    }

    for (const obj of this.objects) {
      const flySpeed = 0.004 + e.mids * 0.025;
      obj.z += obj.vz * (1 + e.mids * 2.5) + obj.flyDir * flySpeed;
      obj.x += obj.vx + p.sin(obj.pulse + idle) * 0.0012;
      obj.y += obj.vy + p.cos(obj.pulse * 1.1 + idle) * 0.0012;
      obj.rx += obj.spin * (1 + e.treble * 4);
      obj.ry += obj.spin * 0.7 * (1 + e.treble * 3);
      obj.rz += obj.spin * 0.5;
      obj.alphaPulse *= 0.9;

      if (beatEdge) {
        obj.alphaPulse = 1;
        obj.vz += obj.flyDir * 0.04;
      }
      if (dropEdge) obj.alphaPulse = 1;

      if (obj.z < 0.12) {
        obj.z = 2.3 + p.random(0.3);
        obj.x = p.random(-0.9, 0.9);
        obj.y = p.random(-0.9, 0.9);
      }
      if (obj.z > 2.6) {
        obj.z = 0.15 + p.random(0.1);
      }
    }

    const sorted = [...this.objects].sort((a, b) => b.z - a.z);

    for (const obj of sorted) {
      const col = PresetUtils.lerpColor(p, theme, obj.hue);
      const proj = this._project(p, obj, cx, cy, fov, w, h);
      const depthFade = p.map(obj.z, 0.12, 2.4, 255, 70);
      const pulse = 1 + e.bass * 0.55 + obj.alphaPulse * 0.35;
      const sz = proj.sz * pulse;
      const alpha = depthFade * (0.5 + e.overall * 0.5 + obj.alphaPulse * 0.4);
      const weight = p.map(obj.z, 0.12, 2.4, 3.2, 1);

      if (obj.type === "cube") {
        this._drawCube(p, proj.x, proj.y, sz, col, theme.glow, alpha, weight);
      } else if (obj.type === "sphere") {
        this._drawSphere(p, proj.x, proj.y, sz, col, theme.glow, alpha, weight);
      } else if (obj.type === "star") {
        this._drawStar(p, proj.x, proj.y, sz, obj.rz, col, alpha);
      } else {
        this._drawLightning(p, proj.x, proj.y, sz, col, theme.glow, alpha, weight);
      }
    }

    p.textAlign(p.CENTER, p.CENTER);
    for (let i = this.textShards.length - 1; i >= 0; i--) {
      const ts = this.textShards[i];
      ts.x += ts.vx * (1 + e.mids * 2);
      ts.y += ts.vy * (1 + e.mids * 1.5);
      ts.vy += 0.06;
      ts.rot += ts.spin * (1 + e.treble * 2);
      ts.life -= 0.014;

      const col = PresetUtils.lerpColor(p, theme, ts.hue);
      const alpha = ts.life * 220;
      p.noStroke();
      p.fill(col[0], col[1], col[2], alpha);
      p.textSize(ts.size * (1 + e.bass * 0.3));
      p.push();
      p.translate(ts.x, ts.y);
      p.rotate(ts.rot);
      p.text(ts.char, 0, 0);
      p.pop();

      if (ts.life <= 0 || ts.y > h + 40) this.textShards.splice(i, 1);
    }

    p.blendMode(p.ADD);
    p.noStroke();
    p.fill(...theme.glow);
    p.ellipse(cx, cy, 90 + e.bass * 140, 90 + e.bass * 140);
    p.fill(...theme.accent, 50 + e.overall * 90);
    p.ellipse(cx, cy, 40 + e.overall * 30, 40 + e.overall * 30);
    p.blendMode(p.BLEND);

    for (let i = 0; i < 35; i++) {
      const sx = (i * 97 + p.frameCount * 1.8) % w;
      const sy = (i * 53 + p.frameCount * 0.6) % h;
      const tw = 0.3 + 0.7 * p.sin(i * 1.7 + idle * 3);
      p.fill(255, 255, 255, tw * (40 + e.treble * 80));
      p.ellipse(sx, sy, 2 + e.treble * 3, 2 + e.treble * 3);
    }

    const vig = p.drawingContext.createRadialGradient(cx, cy, h * 0.06, cx, cy, h * 0.88);
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, `rgba(${theme.bg[0]},${theme.bg[1]},${theme.bg[2]},0.65)`);
    p.drawingContext.fillStyle = vig;
    p.drawingContext.fillRect(0, 0, w, h);

    this.prevBeat = e.beat;
    this.prevDrop = e.drop;
    this.prevBass = e.bass;
  },
};
