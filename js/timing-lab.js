const TimingLab = {
  audio: null,
  objectUrl: null,
  schedule: [],
  byLine: [],
  lines: [],
  scheduleSource: "none",
  userOffset: 0,
  trackKey: "",
  renderedLineIndex: -1,
  wordEls: [],
  rafId: 0,
  debugVisible: false,

  els: {},

  init() {
    this.els = {
      audioInput: document.getElementById("audio-input"),
      trackName: document.getElementById("track-name"),
      statusMsg: document.getElementById("status-msg"),
      playBtn: document.getElementById("play-btn"),
      timeCurrent: document.getElementById("time-current"),
      timeDuration: document.getElementById("time-duration"),
      seekSlider: document.getElementById("seek-slider"),
      syncSlider: document.getElementById("sync-slider"),
      syncVal: document.getElementById("sync-val"),
      karaokeLine: document.getElementById("karaoke-line"),
      nextLine: document.getElementById("next-line"),
      debugToggle: document.getElementById("debug-toggle"),
      debugPanel: document.getElementById("debug-panel"),
      dbgCurrent: document.getElementById("dbg-current"),
      dbgSync: document.getElementById("dbg-sync"),
      dbgLine: document.getElementById("dbg-line"),
      dbgWord: document.getElementById("dbg-word"),
      dbgStart: document.getElementById("dbg-start"),
      dbgEnd: document.getElementById("dbg-end"),
      dbgMatched: document.getElementById("dbg-matched"),
      dbgSource: document.getElementById("dbg-source"),
    };

    this.els.audioInput.addEventListener("change", (e) => this.onFile(e.target.files?.[0]));
    this.els.playBtn.addEventListener("click", () => this.togglePlay());
    this.els.seekSlider.addEventListener("input", () => this.onSeek());
    this.els.syncSlider.addEventListener("input", () => this.onSyncChange());
    this.els.debugToggle.addEventListener("change", (e) => {
      this.debugVisible = e.target.checked;
      this.els.debugPanel.classList.toggle("hidden", !this.debugVisible);
    });

    this.setStatus("Load an MP3 — auto-loads .analysis sidecar when present.", "muted");
  },

  setStatus(text, kind = "") {
    this.els.statusMsg.textContent = text;
    this.els.statusMsg.className = kind;
  },

  formatTime(sec) {
    const s = Math.max(0, sec || 0);
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, "0")}`;
  },

  formatOffset(sec) {
    const sign = sec >= 0 ? "+" : "";
    return `${sign}${sec.toFixed(2)}s`;
  },

  parseLrc(text) {
    const timed = [];
    for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
      const m = line.match(/^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]\s*(.*)$/);
      if (!m) continue;
      const txt = m[4].trim();
      if (!txt) continue;
      timed.push({
        time: this.parseLrcTime(m[1], m[2], m[3]),
        text: txt,
      });
    }
    timed.sort((a, b) => a.time - b.time);
    return timed;
  },

  parseLrcTime(minStr, secStr, fracStr) {
    const min = parseInt(minStr, 10);
    const sec = parseInt(secStr, 10);
    if (!fracStr) return min * 60 + sec;
    if (fracStr.length <= 2) return min * 60 + sec + parseInt(fracStr, 10) / 100;
    return min * 60 + sec + parseInt(fracStr, 10) / 1000;
  },

  loadUserSyncOffset() {
    if (!this.trackKey) return;
    try {
      const raw = localStorage.getItem(`reelstudio_sync::${this.trackKey}`);
      if (raw != null) {
        this.userOffset = parseFloat(raw) || 0;
        this.els.syncSlider.value = String(Math.round(this.userOffset * 100));
        this.els.syncVal.textContent = this.formatOffset(this.userOffset);
      }
    } catch {
      /* ignore */
    }
  },

  saveUserSyncOffset() {
    if (!this.trackKey) return;
    try {
      localStorage.setItem(`reelstudio_sync::${this.trackKey}`, String(this.userOffset));
    } catch {
      /* ignore */
    }
  },

  async onFile(file) {
    if (!file) return;
    this.stopLoop();
    this.teardownAudio();

    this.schedule = [];
    this.byLine = [];
    this.lines = [];
    this.scheduleSource = "none";
    this.renderedLineIndex = -1;
    this.clearKaraoke();

    this.els.trackName.textContent = file.name;
    this.setStatus("Loading audio…", "muted");

    const url = URL.createObjectURL(file);
    this.objectUrl = url;
    this.audio = new Audio(url);
    this.audio.preload = "auto";

    await new Promise((resolve, reject) => {
      this.audio.addEventListener("loadedmetadata", resolve, { once: true });
      this.audio.addEventListener("error", reject, { once: true });
    });

    const duration = this.audio.duration || 0;
    this.els.timeDuration.textContent = this.formatTime(duration);
    this.els.seekSlider.max = String(Math.max(0.1, duration));
    this.els.seekSlider.value = "0";
    this.els.seekSlider.disabled = false;
    this.els.playBtn.disabled = false;
    this.els.syncSlider.disabled = false;

    const meta = LyricsFetcher.mergeMeta({}, file.name);
    this.trackKey = LyricsCache.trackKey(meta, duration, file);
    this.loadUserSyncOffset();

    const pack = await AnalysisPack.load(file.name);
    if (pack?.wordSchedule?.length) {
      this.applySchedule(pack.wordSchedule, "local .analysis pack");
      this.setStatus(
        `Loaded word_schedule (${pack.wordSchedule.length} words) from ${file.name.replace(/\.[^/.]+$/, "")}.analysis`,
        "ok"
      );
    } else {
      this.setStatus("No word_schedule in sidecar — fetching lyrics…", "muted");
      await this.fetchLyricsFallback(file, duration, meta);
    }

    this.audio.addEventListener("play", () => {
      this.els.playBtn.textContent = "Pause";
      this.startLoop();
    });
    this.audio.addEventListener("pause", () => {
      this.els.playBtn.textContent = "Play";
      this.stopLoop();
      this.tick();
    });
    this.audio.addEventListener("ended", () => {
      this.els.playBtn.textContent = "Play";
      this.stopLoop();
      this.tick();
    });

    this.tick();
  },

  applySchedule(schedule, source) {
    this.schedule = schedule;
    this.byLine = KaraokeClock.indexByLine(schedule);
    this.lines = KaraokeClock.buildLinesFromSchedule(schedule);
    this.scheduleSource = source;
    this.renderedLineIndex = -1;
    this.els.dbgSource.textContent = source;
  },

  async fetchLyricsFallback(file, duration, meta) {
    let id3 = {};
    if (file.name.toLowerCase().endsWith(".mp3")) {
      try {
        id3 = await Id3LyricsReader.readFromFile(file);
      } catch {
        id3 = {};
      }
    }

    const merged = LyricsFetcher.mergeMeta(id3, file.name);
    const online = await LyricsFetcher.fetchSynced(merged, duration, file);

    if (online?.syncedLyrics) {
      const timed = this.parseLrc(online.syncedLyrics);
      this.lines = timed.map((l) => l.text);
      this.setStatus(
        "Lyrics loaded (line text only). Run Python analyze_song.py first for word-perfect karaoke timing.",
        ""
      );
      return;
    }

    if (id3.plainLyrics) {
      this.lines = id3.plainLyrics
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      this.setStatus(
        "Plain lyrics only. Run Python analyze_song.py first for word-perfect karaoke timing.",
        ""
      );
      return;
    }

    this.setStatus(
      "No word_schedule and no synced lyrics found. Run: python tools/analyze_song.py \"Your Song.mp3\"",
      ""
    );
  },

  teardownAudio() {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  },

  togglePlay() {
    if (!this.audio) return;
    if (this.audio.paused) {
      this.audio.play().catch((err) => console.warn("Play failed:", err));
    } else {
      this.audio.pause();
    }
  },

  onSeek() {
    if (!this.audio) return;
    this.audio.currentTime = parseFloat(this.els.seekSlider.value) || 0;
    this.tick();
  },

  onSyncChange() {
    this.userOffset = parseInt(this.els.syncSlider.value, 10) / 100;
    this.els.syncVal.textContent = this.formatOffset(this.userOffset);
    this.saveUserSyncOffset();
    this.tick();
  },

  startLoop() {
    if (this.rafId) return;
    const loop = () => {
      this.rafId = requestAnimationFrame(loop);
      this.tick();
    };
    this.rafId = requestAnimationFrame(loop);
  },

  stopLoop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  },

  clearKaraoke() {
    this.els.karaokeLine.innerHTML = "";
    this.els.nextLine.textContent = "";
    this.wordEls = [];
  },

  renderLine(lineIndex) {
    this.clearKaraoke();
    const text = this.lines[lineIndex] || "";
    if (!text) return;

    const lineWords = this.byLine[lineIndex] || [];
    const tokens = lineWords.length
      ? lineWords.map((w) => w.word)
      : text.split(/\s+/).filter(Boolean);

    this.wordEls = tokens.map((word, wi) => {
      const span = document.createElement("span");
      span.className = "word future";
      span.dataset.idx = String(wi);

      const base = document.createElement("span");
      base.className = "word-base";
      base.textContent = word;

      const fill = document.createElement("span");
      fill.className = "word-fill";
      fill.textContent = word;
      fill.style.setProperty("--p", "0");

      span.appendChild(fill);
      span.appendChild(base);
      this.els.karaokeLine.appendChild(span);
      return { el: span, fill, scheduleEntry: lineWords[wi] || null };
    });

    const next = this.lines[lineIndex + 1];
    this.els.nextLine.textContent = next || "";
    this.renderedLineIndex = lineIndex;
  },

  tick() {
    const audio = this.audio;
    const currentTime = audio?.currentTime ?? 0;
    const duration = audio?.duration ?? 0;
    const syncTime = KaraokeClock.getSyncTime(currentTime, this.userOffset);

    this.els.timeCurrent.textContent = this.formatTime(currentTime);
    if (duration > 0 && !this.els.seekSlider.matches(":active")) {
      this.els.seekSlider.value = String(currentTime);
    }

    if (!this.lines.length) {
      this.updateDebug(currentTime, syncTime, -1, null);
      return;
    }

    let lineIndex = 0;
    let activeWord = null;
    let globalWordIdx = -1;

    if (this.schedule.length) {
      globalWordIdx = KaraokeClock.findActiveWordIndex(this.schedule, syncTime);
      activeWord = this.schedule[globalWordIdx] || null;
      lineIndex = activeWord?.lineIndex ?? 0;
      lineIndex = Math.min(lineIndex, this.lines.length - 1);
    } else {
      lineIndex = 0;
    }

    if (lineIndex !== this.renderedLineIndex) {
      this.renderLine(lineIndex);
    }

    if (this.schedule.length && this.wordEls.length) {
      const lineWords = this.byLine[lineIndex] || [];
      for (let wi = 0; wi < this.wordEls.length; wi++) {
        const entry = lineWords[wi];
        const { el, fill } = this.wordEls[wi];
        if (!entry) {
          el.className = "word future";
          fill.style.setProperty("--p", "0");
          continue;
        }

        const state = KaraokeClock.wordState(entry, syncTime);
        const progress = KaraokeClock.wordProgress(entry, syncTime);
        el.className = `word ${state}`;
        fill.style.setProperty("--p", String(progress));
      }

      if (!activeWord && globalWordIdx >= 0) {
        activeWord = this.schedule[globalWordIdx];
      }
    }

    this.updateDebug(currentTime, syncTime, lineIndex, activeWord);
  },

  updateDebug(currentTime, syncTime, lineIndex, activeWord) {
    if (!this.debugVisible) return;
    this.els.dbgCurrent.textContent = currentTime.toFixed(3);
    this.els.dbgSync.textContent = syncTime.toFixed(3);
    this.els.dbgLine.textContent = lineIndex >= 0 ? String(lineIndex) : "—";
    this.els.dbgWord.textContent = activeWord?.word ?? "—";
    this.els.dbgStart.textContent =
      activeWord?.start != null ? activeWord.start.toFixed(3) : "—";
    this.els.dbgEnd.textContent =
      activeWord?.end != null ? activeWord.end.toFixed(3) : "—";
    this.els.dbgMatched.textContent =
      activeWord?.matched != null ? String(activeWord.matched) : "—";
    this.els.dbgSource.textContent = this.scheduleSource;
  },
};

document.addEventListener("DOMContentLoaded", () => TimingLab.init());
