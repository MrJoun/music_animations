class ReelExporter {
  constructor() {
    this.isRecording = false;
    this.isFadingOut = false;
    this.isProcessing = false;
    this.output = null;
    this.videoSource = null;
    this.frameCount = 0;
    this.mediaRecorder = null;
    this.chunks = [];
    this.mode = null;
    this.mediabunny = null;
    this.mediabunnyReady = false;
    this.startTime = 0;
    this.timerInterval = null;
    this.onStatus = null;
    this.onTimerUpdate = null;
    this.onStop = null;
    this.onFrame = null;
    this.FPS = 30;
    this.W = 1080;
    this.H = 1920;
    this.canvas = null;
  }

  _status(msg) {
    if (this.onStatus) this.onStatus(msg);
  }

  _startTimer() {
    this.startTime = Date.now();
    this.timerInterval = setInterval(() => {
      if (this.onTimerUpdate) {
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
        const secs = String(elapsed % 60).padStart(2, "0");
        this.onTimerUpdate(`${mins}:${secs}`);
      }
    }, 400);
  }

  _stopTimer() {
    clearInterval(this.timerInterval);
  }

  _download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async preload() {
    try {
      await this._loadMediabunny();
      this.mediabunnyReady = true;
    } catch (e) {
      console.warn("Mediabunny preload failed:", e);
    }
  }

  async _loadMediabunny() {
    if (!this.mediabunny) {
      this.mediabunny = await import(
        "https://cdn.jsdelivr.net/npm/mediabunny@1.46.0/+esm"
      );
    }
    return this.mediabunny;
  }

  _buildStream(canvas, audioEngine) {
    const stream = canvas.captureStream(this.FPS);
    const audioTrack = audioEngine?.getAudioTrack?.();
    if (audioTrack) stream.addTrack(audioTrack);
    return stream;
  }

  captureFrame() {
    if ((!this.isRecording && !this.isFadingOut) || this.mode !== "mp4" || !this.videoSource) return;
    const t = this.frameCount / this.FPS;
    this.videoSource.add(t, 1 / this.FPS);
    this.frameCount++;
  }

  async start(canvas, audioEngine) {
    if (this.isRecording || this.isProcessing) return;

    this.canvas = canvas;
    this.frameCount = 0;
    this._status("Preparing MP4 export…");

    try {
      await this._startDirectMp4(canvas, audioEngine);
    } catch (directErr) {
      console.warn("Direct MP4 failed, using recorder + convert:", directErr);
      await this._startWebmRecorder(canvas, audioEngine);
    }

    this.isRecording = true;
    this._startTimer();
    this._status(
      this.mode === "mp4"
        ? "Recording Reel (MP4)…"
        : "Recording… will convert to MP4"
    );
  }

  async _startDirectMp4(canvas, audioEngine) {
    const mb = await this._loadMediabunny();
    const {
      Output,
      Mp4OutputFormat,
      BufferTarget,
      CanvasSource,
      MediaStreamAudioTrackSource,
    } = mb;

    this.output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new BufferTarget(),
    });

    this.videoSource = new CanvasSource(canvas, {
      codec: "avc",
      bitrate: 10_000_000,
      width: this.W,
      height: this.H,
    });
    this.output.addVideoTrack(this.videoSource, { frameRate: this.FPS });

    const audioTrack = audioEngine?.getAudioTrack?.();
    if (audioTrack) {
      const audioSource = new MediaStreamAudioTrackSource(audioTrack, {
        codec: "aac",
        bitrate: 256_000,
      });
      this.output.addAudioTrack(audioSource);
    }

    await this.output.start();
    this.mode = "mp4";
  }

  async _startWebmRecorder(canvas, audioEngine) {
    const stream = this._buildStream(canvas, audioEngine);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
        ? "video/webm;codecs=vp8,opus"
        : "video/webm";

    this.chunks = [];
    this.mediaRecorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 10_000_000,
    });

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };

    this.mediaRecorder.onerror = (e) => {
      console.error("MediaRecorder error:", e);
      this._status("Recording error");
    };

    this.mediaRecorder.start(250);
    this.mode = "webm";
  }

  async stopAfterFade() {
    this._stopTimer();
    this.isFadingOut = false;
    this.isProcessing = true;

    try {
      if (this.mode === "mp4") {
        this._status("Finalizing MP4…");
        await this.output.finalize();
        const buffer = this.output.target.buffer;
        if (!buffer || buffer.byteLength < 1000) {
          throw new Error("MP4 file is empty");
        }
        const blob = new Blob([buffer], { type: "video/mp4" });
        this._download(blob, `reel-${Date.now()}.mp4`);
        this._status("MP4 saved — ready for Instagram!");
      } else {
        await this._stopWebmAndConvert();
      }
    } catch (err) {
      console.error(err);
      this._status("Export failed — use Chrome and retry");
      alert(
        "Could not create MP4. Instagram requires MP4 (not WebM).\n\n" +
          "Try Chrome or Edge, record again, and wait for 'MP4 saved'.\n\n" +
          "If it still fails, convert manually:\n" +
          "ffmpeg -i yourfile.webm -c:v libx264 -pix_fmt yuv420p reel.mp4"
      );
    } finally {
      this.isProcessing = false;
      this.output = null;
      this.videoSource = null;
      this.mediaRecorder = null;
      this.mode = null;
      if (this.onStop) this.onStop();
    }
  }

  async _stopWebmAndConvert() {
    const webmBlob = await new Promise((resolve, reject) => {
      this.mediaRecorder.onstop = () => {
        if (this.chunks.length === 0) {
          reject(new Error("No recording data"));
          return;
        }
        resolve(new Blob(this.chunks, { type: "video/webm" }));
      };
      this.mediaRecorder.stop();
    });

    this._status("Converting to MP4 for Instagram…");

    const mb = await this._loadMediabunny();
    const {
      Input,
      Output,
      Conversion,
      BlobSource,
      Mp4OutputFormat,
      BufferTarget,
      ALL_FORMATS,
    } = mb;

    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(webmBlob),
    });

    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new BufferTarget(),
    });

    const conversion = await Conversion.init({
      input,
      output,
      video: {
        codec: "avc",
        bitrate: 10_000_000,
        width: this.W,
        height: this.H,
        forceTranscode: true,
      },
      audio: {
        codec: "aac",
        bitrate: 256_000,
        forceTranscode: true,
      },
    });

    if (!conversion.isValid) {
      throw new Error("MP4 conversion not supported in this browser");
    }

    conversion.onProgress = (progress) => {
      this._status(`Converting to MP4… ${Math.round(progress * 100)}%`);
    };

    await conversion.execute();

    const mp4Buffer = output.target.buffer;
    if (!mp4Buffer || mp4Buffer.byteLength < 1000) {
      throw new Error("Converted MP4 is empty");
    }

    const mp4 = new Blob([mp4Buffer], { type: "video/mp4" });
    this._download(mp4, `reel-${Date.now()}.mp4`);
    this._status("MP4 saved — ready for Instagram!");
  }
}
