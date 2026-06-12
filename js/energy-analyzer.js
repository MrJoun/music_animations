class EnergyAnalyzer {
  constructor(audioEngine) {
    this.audio = audioEngine;
    this.profile = null;

    this.bass = 0;
    this.mids = 0;
    this.vocal = 0;
    this.treble = 0;
    this.energy = 0;
    this.stemVocals = 0;
    this.stemBass = 0;
    this.stemDrums = 0;
    this.stemMelodic = 0;
    this.dominantStem = "melodic";

    this.lastBeat = false;
    this.lastDrop = false;

    this.bpm = 120;
    this.smoothing = 0.22;
    this.highEnergyThreshold = 0.45;
    this.beatSensitivity = 1.2;
    this.motionScale = 1.2;
    this.sceneDurationSec = 6;
    this.transitionSec = 1.8;

    this._beatThreshold = 0;
    this._beatDecay = 0.95;
    this._prevBeat = false;
    this._beatIndex = 0;
    this._lastBeatTime = -1;
    this._lastDropCheck = -1;

    this._energyHistory = [];
    this._dropLookback = 2;
    this._dropSpikeRatio = 1.35;
  }

  applyProfile(profile) {
    this.profile = profile;
    this.bpm = profile.bpm || 120;
    this.smoothing = profile.energySmoothing ?? 0.22;
    this.beatSensitivity = profile.beatSensitivity ?? 1.2;
    this._beatDecay = profile.beatDecay ?? 0.95;
    this.motionScale = profile.motionIntensity ?? 1.2;
    this.sceneDurationSec = profile.sceneDuration ?? 6;
    this.transitionSec = profile.transitionSec ?? 1.8;
    this.highEnergyThreshold = 0.35 + (profile.avgEnergy || 0.3) * 0.35;
    this._beatIndex = 0;
    this._lastBeatTime = -1;

    if (this.audio.analyser && profile.analyserSmoothing != null) {
      this.audio.analyser.smoothingTimeConstant = profile.analyserSmoothing;
    }
  }

  update() {
    this.lastBeat = false;
    this.lastDrop = false;

    const data = this.audio.getFrequencyData();
    const rawBass = this._bandEnergy(data, 0, 8);
    const rawMids = this._bandEnergy(data, 8, 40);
    const rawVocal = this._bandEnergy(data, 40, 80);
    const rawTreble = this._bandEnergy(data, 80, data.length);
    const rawEnergy = this._bandEnergy(data, 0, data.length);

    this.bass = this._ema(this.bass, rawBass);
    this.mids = this._ema(this.mids, rawMids);
    this.vocal = this._ema(this.vocal, rawVocal);
    this.treble = this._ema(this.treble, rawTreble);
    this.energy = this._ema(this.energy, rawEnergy);

    this._detectBeatFromGrid();
    this._detectBeatFromBass();
    this._detectDrop();
    StemEnergy.blendInto(this, this.audio);

    const t = this.audio.getCurrentTime();
    if (this.profile?.dropTimes && this.profile.dropTimes.length > 0) {
      const window = this.profile.mood === "aggressive" ? 0.1 : 0.06;
      const cooldown = this.profile.mood === "aggressive" ? 1.2 : 0.5;
      for (const dt of this.profile.dropTimes) {
        if (Math.abs(t - dt) < window && t > this._lastDropCheck + cooldown) {
          this.lastDrop = true;
          this._lastDropCheck = t;
          break;
        }
      }
    }
  }

  _bandEnergy(data, start, end) {
    const lo = Math.max(0, start);
    const hi = Math.min(data.length, end);
    if (hi <= lo) return 0;

    let sum = 0;
    for (let i = lo; i < hi; i++) sum += data[i];
    return sum / (hi - lo) / 255;
  }

  _ema(prev, next) {
    return prev + this.smoothing * (next - prev);
  }

  _detectBeatFromGrid() {
    if (!this.profile?.beatTimes?.length) return;
    if (this.profile.mood === "chill" || this.profile.mood === "melodic") return;

    const t = this.audio.getCurrentTime();
    const beats = this.profile.beatTimes;
    const window = this.profile.mood === "aggressive" ? 0.07 : 0.05;

    while (this._beatIndex < beats.length && beats[this._beatIndex] < t - window) {
      this._beatIndex++;
    }

    if (this._beatIndex < beats.length) {
      const bt = beats[this._beatIndex];
      if (Math.abs(t - bt) < window && bt !== this._lastBeatTime) {
        this.lastBeat = true;
        this._lastBeatTime = bt;
        this._beatIndex++;
      }
    }
  }

  _detectBeatFromBass() {
    if (this.lastBeat) return;

    const bass = this.bass;
    this._beatThreshold = Math.max(bass, this._beatThreshold * this._beatDecay);
    const minBass = this.profile?.mood === "aggressive" ? 0.06 : 0.1;
    const active =
      bass > this._beatThreshold * (1.22 / this.beatSensitivity) && bass > minBass;
    const beat = active && !this._prevBeat;

    this._prevBeat = active;
    if (beat) this.lastBeat = true;
  }

  _detectDrop() {
    this._energyHistory.push(this.energy);
    if (this._energyHistory.length > this._dropLookback + 1) {
      this._energyHistory.shift();
    }

    if (this._energyHistory.length <= this._dropLookback) return;

    const past = this._energyHistory[0];
    const current = this.energy;
    const ratio = this.profile?.mood === "aggressive" ? 1.25 : this._dropSpikeRatio;
    if (past > 0.06 && current >= past * ratio) {
      this.lastDrop = true;
    }
  }

  getTempoFactor() {
    const bpm = this.profile?.bpm || this.bpm;
    const t = (bpm - 70) / 110;
    return Math.max(0.3, Math.min(1.0, 0.3 + t * 0.7));
  }

  getSceneDuration() {
    const base = this.sceneDurationSec;
    if (this.profile?.mood === "aggressive" || this.profile?.mood === "dance") {
      return base;
    }
    const live = this.energy;
    const tempo = this.getTempoFactor();
    return base * (0.85 + tempo * 0.15) - live * 0.8;
  }

  getMotionIntensity() {
    const drive = this.energy * 0.45 + this.bass * 0.4 + this.getTempoFactor() * 0.15;
    const userScale = this.profile?.intensity ?? 1;
    return this.motionScale * (0.5 + Math.min(1, drive) * 0.85) * (0.65 + userScale * 0.7);
  }

  isHighEnergy() {
    return this.energy >= this.highEnergyThreshold;
  }

  isDrop() {
    return this.lastDrop;
  }

  getBass() {
    return this.bass;
  }

  getMids() {
    return this.mids;
  }

  getVocals() {
    return this.vocal;
  }

  getTreble() {
    return this.treble;
  }

  getOverall() {
    return this.energy;
  }

  detectBeat() {
    return this.lastBeat;
  }

  detectDrop() {
    return this.lastDrop;
  }

  getTransitionFrames() {
    const sec = this.transitionSec;
    const live = this.isHighEnergy();
    return Math.floor(30 * sec * (live ? 0.75 : 1));
  }
}
