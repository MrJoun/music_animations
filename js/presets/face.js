const FacePreset = {
  name: "face",
  blinkT: 0,
  prevBeat: false,

  setup(p) {
    this.blinkT = 0;
    this.prevBeat = false;
  },

  draw(p, audio, theme) {
    const bass = PresetUtils.idleBass(p, audio);
    const energy = PresetUtils.idleEnergy(p, audio);
    const freq = PresetUtils.getFreq(p, audio);
    const beat = audio.detectBeat();
    const w = p.width;
    const h = p.height;
    const cx = w / 2;
    const cy = h * 0.46;
    const idle = p.frameCount * 0.022;
    const breath = p.sin(idle * 0.7) * 0.04;
    const tilt = p.sin(idle * 0.5) * 0.06 + (beat ? 0.08 : 0) + energy * 0.05;
    const headW = w * 0.52;
    const headH = h * 0.38;

    if (p.frameCount % 120 === 0 || (beat && !this.prevBeat)) {
      this.blinkT = beat ? 6 : 10;
    }
    this.prevBeat = beat;
    if (this.blinkT > 0) this.blinkT--;

    p.background(...theme.bg, 45);

    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      const col = PresetUtils.lerpColor(p, theme, t);
      p.noFill();
      p.stroke(col[0], col[1], col[2], 12 + energy * 20);
      p.strokeWeight(1);
      const r = 120 + i * 70 + p.sin(idle + i * 0.8) * 25;
      p.ellipse(cx, cy, r * 2, r * 2.2);
    }

    p.push();
    p.translate(cx, cy);
    p.rotate(tilt);
    p.scale(1 + breath + bass * 0.08);

    const accent = PresetUtils.lerpColor(p, theme, 0.2);
    const secondary = PresetUtils.lerpColor(p, theme, 0.75);
    const glowAlpha = 80 + energy * 120 + bass * 60;

    p.noFill();
    p.stroke(...theme.glow);
    p.strokeWeight(6 + bass * 8);
    p.ellipse(0, 0, headW * 1.02, headH * 1.02);

    p.stroke(accent[0], accent[1], accent[2], glowAlpha);
    p.strokeWeight(3 + energy * 2);
    p.ellipse(0, 0, headW, headH);

    p.stroke(secondary[0], secondary[1], secondary[2], 100 + energy * 80);
    p.strokeWeight(1.5);
    p.ellipse(0, -headH * 0.08, headW * 0.85, headH * 0.9);

    const eyeY = -headH * 0.12;
    const eyeX = headW * 0.18;
    const eyePulse = 1 + energy * 0.45 + p.sin(idle * 2.5) * 0.08;
    const eyeOpen = this.blinkT > 0 ? 0.12 : 0.55 + p.sin(idle * 1.1) * 0.05;

    for (const side of [-1, 1]) {
      const ex = eyeX * side;
      const ew = headW * 0.14 * eyePulse;
      const eh = headH * 0.11 * eyeOpen * eyePulse;

      p.stroke(...theme.glow);
      p.strokeWeight(5 + bass * 4);
      p.ellipse(ex, eyeY, ew * 1.15, eh * 1.2);

      p.stroke(accent[0], accent[1], accent[2], glowAlpha);
      p.strokeWeight(2.5);
      p.ellipse(ex, eyeY, ew, eh);

      const irisR = ew * 0.35 * (1 + bass * 0.3);
      p.noFill();
      p.stroke(secondary[0], secondary[1], secondary[2], 200);
      p.strokeWeight(2);
      p.ellipse(ex, eyeY, irisR, irisR * 0.9);

      const pupil = irisR * 0.35;
      p.fill(accent[0], accent[1], accent[2], 220);
      p.noStroke();
      p.ellipse(ex + side * 2, eyeY, pupil, pupil);

      const lidStart = eyeY - eh * 0.5;
      p.noFill();
      p.stroke(accent[0], accent[1], accent[2], 160);
      p.strokeWeight(2);
      p.arc(ex, eyeY, ew * 1.1, eh * 1.3, p.PI + 0.2, p.TWO_PI - 0.2);
    }

    const browY = eyeY - headH * 0.1;
    const browLift = energy * 12 + p.sin(idle) * 4;
    p.noFill();
    p.stroke(accent[0], accent[1], accent[2], 140 + energy * 80);
    p.strokeWeight(2.5);
    for (const side of [-1, 1]) {
      p.arc(eyeX * side, browY - browLift, headW * 0.2, headH * 0.08, p.PI, p.TWO_PI);
    }

    const noseY = headH * 0.02;
    p.noFill();
    p.stroke(secondary[0], secondary[1], secondary[2], 90 + energy * 60);
    p.strokeWeight(1.5);
    p.line(0, noseY - 20, 0, noseY + 35);
    p.arc(0, noseY + 30, 28, 18, 0, p.PI);

    const mouthY = headH * 0.22;
    const mouthOpen = p.map(bass, 0, 1, 0.15, 0.85) + p.sin(idle * 1.4) * 0.08;
    const mouthW = headW * 0.28 * (1 + energy * 0.2);
    const mouthH = headH * 0.18 * mouthOpen;

    p.stroke(...theme.glow);
    p.strokeWeight(4 + bass * 10);
    p.noFill();
    p.arc(0, mouthY, mouthW * 1.1, mouthH * 1.2, 0.15, p.PI - 0.15);

    p.stroke(accent[0], accent[1], accent[2], glowAlpha);
    p.strokeWeight(2.5 + bass * 3);
    p.arc(0, mouthY, mouthW, mouthH, 0.2, p.PI - 0.2);

    if (mouthOpen > 0.4) {
      p.stroke(secondary[0], secondary[1], secondary[2], 100);
      p.strokeWeight(1);
      p.line(-mouthW * 0.25, mouthY + mouthH * 0.35, mouthW * 0.25, mouthY + mouthH * 0.35);
    }

    const cheekEnergy = (freq[4] + freq[8] + freq[12]) / (255 * 3);
    for (const side of [-1, 1]) {
      const cheekX = headW * 0.28 * side;
      const cheekY = headH * 0.08;
      p.noFill();
      p.stroke(secondary[0], secondary[1], secondary[2], 40 + cheekEnergy * 120);
      p.strokeWeight(1.5);
      p.arc(cheekX, cheekY, 55 + cheekEnergy * 30, 40, 0, p.TWO_PI);
    }

    p.stroke(accent[0], accent[1], accent[2], 60 + energy * 40);
    p.strokeWeight(1);
    p.line(-headW * 0.35, -headH * 0.35, headW * 0.35, -headH * 0.35);

    p.pop();

    if (beat) {
      p.stroke(...theme.glow);
      p.strokeWeight(2);
      p.noFill();
      p.ellipse(cx, cy, headW * (1.3 + bass), headH * (1.3 + bass));
    }

    const vig = p.drawingContext.createRadialGradient(cx, cy, h * 0.08, cx, cy, h * 0.8);
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, `rgba(${theme.bg[0]},${theme.bg[1]},${theme.bg[2]},0.65)`);
    p.drawingContext.fillStyle = vig;
    p.drawingContext.fillRect(0, 0, w, h);
  },
};
