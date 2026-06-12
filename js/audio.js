class AudioEngine {
  constructor() {
    this.context = null;
    this.analyser = null;
    this.source = null;
    this.gainNode = null;
    this.streamDestination = null;
    this.audioElement = null;
    this.freqData = new Uint8Array(256);
    this.waveData = new Uint8Array(512);
    this.isPlaying = false;
    this.beatThreshold = 0;
    this.beatDecay = 0.98;
    this.lastBeat = false;
    this.onBeat = null;
    this.hasTrack = false;
  }

  async init() {
    if (!this.context) {
      this.context = new AudioContext();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.75;
      this.gainNode = this.context.createGain();
      this.streamDestination = this.context.createMediaStreamDestination();

      this.gainNode.connect(this.analyser);
      this.analyser.connect(this.context.destination);
      this.analyser.connect(this.streamDestination);

      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      this.waveData = new Uint8Array(this.analyser.fftSize);
    }
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  async loadFile(file) {
    await this.init();
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.audioElement) {
      this.audioElement.pause();
      URL.revokeObjectURL(this.audioElement.src);
    }

    const url = URL.createObjectURL(file);
    this.audioElement = new Audio(url);
    this.audioElement.crossOrigin = "anonymous";
    this.audioElement.preload = "auto";

    await new Promise((resolve, reject) => {
      this.audioElement.addEventListener("canplaythrough", resolve, { once: true });
      this.audioElement.addEventListener("error", reject, { once: true });
    });

    this.source = this.context.createMediaElementSource(this.audioElement);
    this.source.connect(this.gainNode);
    this.isPlaying = false;
    this.hasTrack = true;
    this.beatThreshold = 0;
    this.audioElement.currentTime = 0;
  }

  async play() {
    await this.init();
    if (!this.audioElement) return;
    await this.audioElement.play();
    this.isPlaying = true;
  }

  pause() {
    if (!this.audioElement) return;
    this.audioElement.pause();
    this.isPlaying = false;
  }

  async toggle() {
    if (this.isPlaying) {
      this.pause();
      return false;
    }
    await this.play();
    return true;
  }

  getAudioTrack() {
    if (!this.streamDestination) return null;
    const tracks = this.streamDestination.stream.getAudioTracks();
    return tracks.length > 0 ? tracks[0] : null;
  }

  getFrequencyData() {
    if (!this.analyser) return this.freqData;
    this.analyser.getByteFrequencyData(this.freqData);
    return this.freqData;
  }

  getWaveformData() {
    if (!this.analyser) return this.waveData;
    this.analyser.getByteTimeDomainData(this.waveData);
    return this.waveData;
  }

  getBassEnergy() {
    const data = this.getFrequencyData();
    let sum = 0;
    const bins = Math.min(10, data.length);
    for (let i = 0; i < bins; i++) sum += data[i];
    return sum / bins / 255;
  }

  getOverallEnergy() {
    const data = this.getFrequencyData();
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return sum / data.length / 255;
  }

  detectBeat() {
    const bass = this.getBassEnergy();
    this.beatThreshold = Math.max(bass, this.beatThreshold * this.beatDecay);
    const beat = bass > this.beatThreshold * 1.3 && bass > 0.12;
    if (beat && !this.lastBeat && this.onBeat) {
      this.onBeat(bass);
    }
    this.lastBeat = beat;
    return beat;
  }

  getCurrentTime() {
    return this.audioElement ? this.audioElement.currentTime : 0;
  }

  getDuration() {
    return this.audioElement ? this.audioElement.duration : 0;
  }

  seekTo(seconds) {
    if (this.audioElement) this.audioElement.currentTime = seconds;
  }

  formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  destroy() {
    this.pause();
    if (this.source) this.source.disconnect();
    if (this.audioElement) URL.revokeObjectURL(this.audioElement.src);
    if (this.context) this.context.close();
  }
}

const THEMES = {
  neon: {
    bg: [8, 10, 22],
    accent: [0, 255, 136],
    secondary: [108, 92, 231],
    glow: [0, 255, 136, 80],
  },
  sunset: {
    bg: [30, 12, 24],
    accent: [255, 107, 107],
    secondary: [254, 202, 87],
    glow: [255, 107, 107, 80],
  },
  ocean: {
    bg: [4, 12, 32],
    accent: [72, 219, 251],
    secondary: [29, 209, 161],
    glow: [72, 219, 251, 80],
  },
  mono: {
    bg: [14, 14, 18],
    accent: [255, 255, 255],
    secondary: [136, 136, 160],
    glow: [255, 255, 255, 60],
  },
  candy: {
    bg: [20, 8, 28],
    accent: [255, 105, 180],
    secondary: [138, 43, 226],
    glow: [255, 105, 180, 90],
  },
  forest: {
    bg: [6, 16, 10],
    accent: [46, 213, 115],
    secondary: [255, 211, 42],
    glow: [46, 213, 115, 70],
  },
};
