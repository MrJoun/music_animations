class FadeController {
  constructor() {
    this.fadeInSec = 2;
    this.fadeOutSec = 2;
    this.active = false;
    this.phase = "idle";
    this.phaseStart = 0;
    this.recordFrame = 0;
    this.fadeOutResolve = null;
  }

  get fadeInFrames() {
    return Math.floor(this.fadeInSec * 30);
  }

  get fadeOutFrames() {
    return Math.floor(this.fadeOutSec * 30);
  }

  startRecording() {
    this.active = true;
    this.phase = "recording";
    this.recordFrame = 0;
    this.phaseStart = performance.now();
  }

  beginFadeOut() {
    return new Promise((resolve) => {
      this.phase = "fadeout";
      this.phaseStart = performance.now();
      this.fadeOutResolve = resolve;
    });
  }

  tick() {
    if (!this.active) return;

    if (this.phase === "recording") {
      this.recordFrame++;
      return;
    }

    if (this.phase === "fadeout") {
      const elapsed = (performance.now() - this.phaseStart) / 1000;
      if (elapsed >= this.fadeOutSec && this.fadeOutResolve) {
        const resolve = this.fadeOutResolve;
        this.fadeOutResolve = null;
        this.active = false;
        this.phase = "idle";
        resolve();
      }
    }
  }

  getAudioGain(audio) {
    if (!this.active) return 1;

    if (this.phase === "recording") {
      const t = this.recordFrame / 30;
      if (t < this.fadeInSec) return t / this.fadeInSec;
      return 1;
    }

    if (this.phase === "fadeout") {
      const elapsed = (performance.now() - this.phaseStart) / 1000;
      return Math.max(0, 1 - elapsed / this.fadeOutSec);
    }

    return 1;
  }

  getVideoAlpha() {
    if (!this.active) return 1;

    if (this.phase === "recording") {
      const t = this.recordFrame / 30;
      if (t < this.fadeInSec) return t / this.fadeInSec;
      return 1;
    }

    if (this.phase === "fadeout") {
      const elapsed = (performance.now() - this.phaseStart) / 1000;
      return Math.max(0, 1 - elapsed / this.fadeOutSec);
    }

    return 1;
  }

  applyVisualFade(p) {
    const alpha = this.getVideoAlpha();
    if (alpha >= 0.999) return;

    p.push();
    p.noStroke();
    p.fill(0, 0, 0, 255 * (1 - alpha));
    p.rect(0, 0, p.width, p.height);
    p.pop();
  }

  applyAudioGain(audio) {
    if (!audio.gainNode) return;
    audio.gainNode.gain.value = this.getAudioGain(audio);
  }

  reset(audio) {
    this.active = false;
    this.phase = "idle";
    this.recordFrame = 0;
    if (audio?.gainNode) audio.gainNode.gain.value = 1;
  }
}
