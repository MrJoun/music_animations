const Objects3dPreset = {
  name: "objects3d",
  shapes: [],
  prevBeat: false,

  setup(p) {
    this.shapes = [];
    this.prevBeat = false;
    const types = ["cube", "pyramid", "sphere", "diamond"];
    const count = 18;

    for (let i = 0; i < count; i++) {
      this.shapes.push({
        type: types[i % types.length],
        x: p.random(-1, 1),
        y: p.random(-1, 1),
        z: p.random(0.3, 2.2),
        rx: p.random(p.TWO_PI),
        ry: p.random(p.TWO_PI),
        rz: p.random(p.TWO_PI),
        rsx: p.random(0.008, 0.025),
        rsy: p.random(0.008, 0.025),
        rsz: p.random(0.008, 0.025),
        driftX: p.random(-0.002, 0.002),
        driftY: p.random(-0.002, 0.002),
        driftZ: p.random(-0.001, 0.001),
        size: p.random(0.12, 0.32),
        hue: p.random(1),
        pulse: p.random(p.TWO_PI),
      });
    }
  },

  _rotate3(x, y, z, rx, ry, rz) {
    let cy = y * Math.cos(rx) - z * Math.sin(rx);
    let cz = y * Math.sin(rx) + z * Math.cos(rx);
    y = cy;
    z = cz;

    let cx = x * Math.cos(ry) + z * Math.sin(ry);
    cz = -x * Math.sin(ry) + z * Math.cos(ry);
    x = cx;
    z = cz;

    cx = x * Math.cos(rz) - y * Math.sin(rz);
    cy = x * Math.sin(rz) + y * Math.cos(rz);
    return { x: cx, y: cy, z };
  },

  _projectVerts(p, sh, verts, cx, cy, fov, w, h, parallax) {
    const base = sh.size * fov * 0.22;
    return verts.map(([vx, vy, vz]) => {
      const r = this._rotate3(vx * base, vy * base, vz * base, sh.rx, sh.ry, sh.rz);
      const wx = sh.x * w * 0.34 + r.x + parallax * sh.z * 30;
      const wy = sh.y * h * 0.26 + r.y;
      const wz = Math.max(0.12, sh.z + r.z * 0.06);
      const s = fov / (wz + 0.25);
      return {
        x: cx + (wx / wz) * fov * 0.42,
        y: cy + (wy / wz) * fov * 0.42,
        z: wz,
      };
    });
  },

  _drawEdges(p, projected, edges, col, glow, alpha, weight) {
    p.noFill();
    p.stroke(...glow);
    p.strokeWeight(weight * 1.6);
    for (const [a, b] of edges) {
      p.line(projected[a].x, projected[a].y, projected[b].x, projected[b].y);
    }
    p.stroke(col[0], col[1], col[2], alpha);
    p.strokeWeight(weight);
    for (const [a, b] of edges) {
      p.line(projected[a].x, projected[a].y, projected[b].x, projected[b].y);
    }
  },

  _getMesh(type) {
    if (type === "cube") {
      const h = 0.5;
      return {
        verts: [
          [-h, -h, -h],
          [h, -h, -h],
          [h, h, -h],
          [-h, h, -h],
          [-h, -h, h],
          [h, -h, h],
          [h, h, h],
          [-h, h, h],
        ],
        edges: [
          [0, 1],
          [1, 2],
          [2, 3],
          [3, 0],
          [4, 5],
          [5, 6],
          [6, 7],
          [7, 4],
          [0, 4],
          [1, 5],
          [2, 6],
          [3, 7],
        ],
      };
    }
    if (type === "pyramid") {
      const h = 0.55;
      return {
        verts: [
          [0, -h, 0],
          [-h, h * 0.6, -h],
          [h, h * 0.6, -h],
          [h, h * 0.6, h],
          [-h, h * 0.6, h],
        ],
        edges: [
          [0, 1],
          [0, 2],
          [0, 3],
          [0, 4],
          [1, 2],
          [2, 3],
          [3, 4],
          [4, 1],
        ],
      };
    }
    if (type === "diamond") {
      const h = 0.55;
      return {
        verts: [
          [0, -h, 0],
          [h * 0.5, 0, 0],
          [0, h, 0],
          [-h * 0.5, 0, 0],
          [0, 0, h * 0.5],
          [0, 0, -h * 0.5],
        ],
        edges: [
          [0, 1],
          [0, 2],
          [0, 3],
          [0, 4],
          [0, 5],
          [1, 2],
          [2, 3],
          [3, 1],
          [4, 1],
          [4, 2],
          [4, 3],
          [5, 1],
          [5, 2],
          [5, 3],
        ],
      };
    }
    return null;
  },

  _drawSphere(p, sh, cx, cy, fov, w, h, parallax, col, glow, alpha, weight) {
    const base = sh.size * fov * 0.22;
    const center = this._projectVerts(
      p,
      sh,
      [[0, 0, 0]],
      cx,
      cy,
      fov,
      w,
      h,
      parallax
    )[0];
    const equator = this._projectVerts(
      p,
      sh,
      [[base, 0, 0], [0, 0, 0]],
      cx,
      cy,
      fov,
      w,
      h,
      parallax
    );
    const meridian = this._projectVerts(
      p,
      sh,
      [[0, base, 0], [0, 0, 0]],
      cx,
      cy,
      fov,
      w,
      h,
      parallax
    );
    const rX = p.dist(equator[0].x, equator[0].y, equator[1].x, equator[1].y);
    const rY = p.dist(meridian[0].x, meridian[0].y, meridian[1].x, meridian[1].y);

    p.noFill();
    p.stroke(...glow);
    p.strokeWeight(weight * 1.6);
    p.ellipse(center.x, center.y, rX * 2, rY * 2);
    p.stroke(col[0], col[1], col[2], alpha);
    p.strokeWeight(weight);
    p.ellipse(center.x, center.y, rX * 2, rY * 2);

    for (let i = 1; i <= 3; i++) {
      const t = i / 4;
      const ring = this._projectVerts(
        p,
        sh,
        [[base * p.cos(t * p.PI), base * p.sin(t * p.PI), 0]],
        cx,
        cy,
        fov,
        w,
        h,
        parallax
      )[0];
      const rr = p.dist(center.x, center.y, ring.x, ring.y);
      p.stroke(col[0], col[1], col[2], alpha * 0.65);
      p.ellipse(center.x, center.y, rr * 2, rr * 1.4);
    }
  },

  draw(p, audio, theme, options = {}) {
    const ea = options.energy;
    const bass = ea ? ea.bass : PresetUtils.idleBass(p, audio);
    const energy = ea ? ea.energy : PresetUtils.idleEnergy(p, audio);
    const beat = ea ? ea.lastBeat : audio.detectBeat();
    const drop = ea ? ea.lastDrop : false;
    const motion = ea ? ea.getMotionIntensity() : 1;
    const w = p.width;
    const h = p.height;
    const cx = w / 2;
    const cy = h * 0.48;
    const fov = Math.min(w, h) * 0.42;
    const idle = p.frameCount * 0.016;
    const parallax = p.sin(idle) * 0.015;

    p.background(...theme.bg, 50);

    for (let i = 0; i < 8; i++) {
      const t = i / 7;
      const col = PresetUtils.lerpColor(p, theme, t);
      p.noStroke();
      p.fill(col[0], col[1], col[2], 4 + energy * 8);
      const depth = 0.5 + i * 0.15;
      const s = fov / depth;
      p.ellipse(cx, cy, s * 1.8, s * 1.4);
    }

    for (const sh of this.shapes) {
      sh.rx += sh.rsx + energy * 0.008;
      sh.ry += sh.rsy + bass * 0.006;
      sh.rz += sh.rsz;
      sh.x += sh.driftX + p.sin(sh.pulse + idle) * 0.0015;
      sh.y += sh.driftY + p.cos(sh.pulse * 1.2 + idle) * 0.0015;
      sh.z += sh.driftZ + p.sin(idle * 0.5 + sh.pulse) * 0.0008;

      if (beat && !this.prevBeat) {
        sh.z -= (0.18 + bass * 0.25) * motion;
        sh.rsx += 0.02 * motion;
        sh.rsy += 0.02 * motion;
      }
      if (drop) {
        sh.z -= 0.35;
        sh.size = Math.min(0.5, sh.size * 1.08);
      }

      if (sh.z < 0.15) sh.z += 2.1;
      if (sh.z > 2.4) sh.z -= 2.1;
      if (p.abs(sh.x) > 1.3) sh.driftX *= -1;
      if (p.abs(sh.y) > 1.3) sh.driftY *= -1;
    }
    this.prevBeat = beat;

    const sorted = [...this.shapes].sort((a, b) => b.z - a.z);

    for (const sh of sorted) {
      const col = PresetUtils.lerpColor(p, theme, sh.hue);
      const depthFade = p.map(sh.z, 0.15, 2.2, 255, 90);
      const alpha = depthFade * (0.55 + energy * 0.45);
      const weight = p.map(sh.z, 0.15, 2.2, 3.5, 1);

      if (sh.type === "sphere") {
        this._drawSphere(p, sh, cx, cy, fov, w, h, parallax, col, theme.glow, alpha, weight);
        continue;
      }

      const mesh = this._getMesh(sh.type);
      if (!mesh) continue;

      const projected = this._projectVerts(
        p,
        sh,
        mesh.verts,
        cx,
        cy,
        fov,
        w,
        h,
        parallax
      );
      this._drawEdges(p, projected, mesh.edges, col, theme.glow, alpha, weight);
    }

    p.noStroke();
    p.fill(...theme.glow);
    p.ellipse(cx, cy, 80 + bass * 120, 80 + bass * 120);
    p.fill(...theme.accent, 60 + energy * 80);
    p.ellipse(cx, cy, 30 + energy * 20, 30 + energy * 20);

    const vig = p.drawingContext.createRadialGradient(cx, cy, h * 0.06, cx, cy, h * 0.85);
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, `rgba(${theme.bg[0]},${theme.bg[1]},${theme.bg[2]},0.6)`);
    p.drawingContext.fillStyle = vig;
    p.drawingContext.fillRect(0, 0, w, h);
  },
};
