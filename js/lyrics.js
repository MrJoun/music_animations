class LyricsManager {
  constructor() {
    this.lines = [];
    this.timed = [];
    this.mode = "none";
    this.currentIndex = 0;
    this.lastBeatAdvance = 0;
    this.fileName = "";
    this.source = "";
    this._extras = null;
    this._duration = 0;
    this._masterSchedule = [];
    this._onsetMapped = false;
    this._exactWordTiming = false;
    this._trackCacheKey = "";
    this._displayLeadSec = 0;
    this._lagShiftSec = 0;
    this._userSyncOffsetSec = 0;
    this._whisperAligned = false;
    this._fromLocalPack = false;
    this.fullscreen = true;
  }

  _getTimedLinesForWhisper() {
    if (this.mode === "timed" && this.timed.length) return this.timed;
    if (this.lines.length) {
      return this.lines.map((text, i) => ({ time: i * 2, text }));
    }
    return [];
  }

  async alignWithWhisper(waveform, onProgress, opts = {}) {
    const forceTranscribe = !!opts.forceTranscribe;
    const timedLines = this._getTimedLinesForWhisper();
    const trackKey = this._trackCacheKey;
    const lyricsHash = this._lyricsFingerprint();

    if (!timedLines.length || !trackKey) return { ok: false };

    if (!forceTranscribe) {
      const schedHit = await WhisperCache.getSchedule(trackKey, lyricsHash);
      if (schedHit?.schedule?.length) {
        onProgress?.(1, "Whisper sync loaded from cache");
        this._applyWhisperSchedule(schedHit.schedule);
        return { ok: true, fromCache: true };
      }
    }

    let asrWords = null;

    if (!forceTranscribe) {
      const tr = await WhisperCache.getTranscript(trackKey);
      if (tr?.asrWords?.length) {
        onProgress?.(0.85, "Cached transcript — aligning lyrics…");
        asrWords = tr.asrWords;
        const { schedule } = await WhisperAligner.alignFromTranscript(
          asrWords,
          timedLines,
          onProgress,
          this._duration
        );
        if (schedule.length) {
          await WhisperCache.setSchedule(trackKey, lyricsHash, schedule, asrWords);
          this._applyWhisperSchedule(schedule);
          return { ok: true, fromCache: true, realigned: true };
        }
      }
    } else {
      await WhisperCache.clearTranscript(trackKey);
    }

    if (!waveform?.samples) return { ok: false };

    const { schedule, asrWords: words } = await WhisperAligner.alignSong(
      waveform,
      timedLines,
      onProgress,
      asrWords,
      this._duration
    );

    if (!schedule.length) return { ok: false };

    await WhisperCache.setTranscript(trackKey, words);
    await WhisperCache.setSchedule(trackKey, lyricsHash, schedule, words);
    this._applyWhisperSchedule(schedule);
    return { ok: true, fromCache: false };
  }

  _applyWhisperSchedule(schedule) {
    this._masterSchedule = schedule;
    this._whisperAligned = true;
    this._exactWordTiming = true;
    this._onsetMapped = true;
    this._displayLeadSec = 0;

    const cacheKey = this._trackCacheKey;
    if (cacheKey && typeof LyricsCache !== "undefined") {
      LyricsCache.setWordSchedule(cacheKey, this._lyricsFingerprint(), schedule, {
        exact: true,
        alignVersion: typeof LyricsAligner !== "undefined" ? LyricsAligner.ALIGN_VERSION : 0,
        whisper: true,
      });
    }
  }

  loadWordScheduleFromPack(schedule) {
    if (!schedule?.length) return false;
    this._applyWhisperSchedule(schedule);
    this._fromLocalPack = true;
    return true;
  }

  /**
   * Backend-pack karaoke: set lyric lines + the forced-aligned word schedule with no
   * in-browser analysis. `lines` is [{time, text}] from the pack's lyrics.json; if
   * omitted, lines are derived from the schedule.
   */
  loadFromPack(schedule, lines) {
    this.clear();
    this.mode = "timed";
    this.source = "analysis pack";
    this.fileName = "analysis pack";
    const cleaned = (lines || [])
      .map((e) => ({ time: e.time || 0, text: (e.text || "").trim() }))
      .filter((e) => e.text);
    if (cleaned.length) {
      this.timed = cleaned;
    } else if (schedule?.length && typeof KaraokeClock !== "undefined") {
      this.timed = KaraokeClock.buildLinesFromSchedule(schedule).map((text, i) => ({
        time: 0,
        text,
      }));
    }
    this.loadWordScheduleFromPack(schedule);
    return this.hasLines();
  }

  setUserSyncOffset(sec) {
    this._userSyncOffsetSec = sec;
    if (this._trackCacheKey) {
      try {
        localStorage.setItem(`reelstudio_sync::${this._trackCacheKey}`, String(sec));
      } catch {
        /* ignore */
      }
    }
  }

  loadUserSyncOffset() {
    if (!this._trackCacheKey) return;
    try {
      const raw = localStorage.getItem(`reelstudio_sync::${this._trackCacheKey}`);
      if (raw != null) this._userSyncOffsetSec = parseFloat(raw) || 0;
    } catch {
      /* ignore */
    }
  }

  getSyncTime(audioTime) {
    const t = audioTime ?? 0;
    if (this._whisperAligned || this._fromLocalPack) {
      return t + this._userSyncOffsetSec;
    }
    return t + this._displayLeadSec + this._userSyncOffsetSec;
  }

  /** Line index from word_schedule at sync time (binary search on word starts). */
  _lineIndexFromSchedule(t) {
    const sched = this._masterSchedule;
    if (!sched.length) return 0;
    if (t < sched[0].start) return sched[0].lineIndex ?? 0;

    let lo = 0;
    let hi = sched.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (sched[mid].start <= t) lo = mid;
      else hi = mid - 1;
    }
    return sched[lo].lineIndex ?? 0;
  }

  _usesScheduleLineIndex() {
    return (
      this._masterSchedule.length > 0 &&
      (this._whisperAligned || this._fromLocalPack || this._exactWordTiming)
    );
  }

  _whisperLineStart(lineIndex) {
    const words = this._masterSchedule.filter((w) => w.lineIndex === lineIndex);
    if (!words.length) return this.timed[lineIndex]?.time ?? 0;
    return words[0].lineT0 ?? Math.min(...words.map((w) => w.start));
  }

  _liveVocalCtx() {
    const vocals = this._extras?.stems?.vocals;
    const times = this._extras?.stems?.times || this._extras?.times;
    if (!vocals?.length || !times?.length) return null;
    const avgVocal = vocals.reduce((a, b) => a + b, 0) / vocals.length;
    return { vocals, times, avgVocal };
  }

  setTrackCacheKey(key) {
    this._trackCacheKey = key || "";
    this.loadUserSyncOffset();
  }

  static formatLrcTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    const whole = Math.floor(s);
    const cs = Math.round((s - whole) * 100);
    return `${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
  }

  static parseLrcTime(minStr, secStr, fracStr) {
    const min = parseInt(minStr, 10);
    const sec = parseInt(secStr, 10);
    if (!fracStr) return min * 60 + sec;
    if (fracStr.length <= 2) return min * 60 + sec + parseInt(fracStr, 10) / 100;
    return min * 60 + sec + parseInt(fracStr, 10) / 1000;
  }

  setSongContext(extras, profile) {
    this._extras = extras || null;
    this._duration = profile?.duration || 0;
    this._rebuildOnsetMap();
  }

  _getTimedLines() {
    if (this.mode === "timed" && this.timed.length) return this.timed;
    if (this.mode === "plain" && this.lines.length && this._duration > 0) {
      const step = this._duration / this.lines.length;
      return this.lines.map((text, i) => ({ time: step * i, text }));
    }
    return [];
  }

  _lyricsFingerprint() {
    return LyricsCache.lyricsFingerprint(this);
  }

  _rebuildOnsetMap() {
    if (this._whisperAligned && this._masterSchedule.length) {
      this._onsetMapped = true;
      return;
    }

    if (this._exactWordTiming && this._masterSchedule.length) {
      this._onsetMapped = true;
      return;
    }

    this._masterSchedule = [];
    this._onsetMapped = false;
    this._exactWordTiming = false;

    // Backend-only build: in-browser alignment/caches are gone. Word timing always comes
    // from the analysis pack (loadFromPack), so without those modules there's nothing to do.
    if (typeof LyricsCache === "undefined" || typeof LyricsAligner === "undefined") return;

    const timedLines = this._getTimedLines();
    if (!timedLines.length || !this._duration) return;

    const cacheKey = this._trackCacheKey;
    const lyricsHash = this._lyricsFingerprint();
    if (cacheKey) {
      const cached = LyricsCache.getWordSchedule(cacheKey, lyricsHash);
      if (cached?.whisper && cached?.schedule?.length) {
        this._applyWhisperSchedule(cached.schedule);
        return;
      }
      if (
        cached?.schedule?.length &&
        cached.alignVersion === LyricsAligner.ALIGN_VERSION
      ) {
        this._masterSchedule = cached.schedule;
        this._onsetMapped = true;
        this._exactWordTiming = !!cached.exact;
        this._displayLeadSec = cached.displayLead ?? LyricsAligner.DISPLAY_LEAD_SEC;
        this._lagShiftSec = cached.lagShift ?? 0;
        return;
      }
    }

    const onsets = this._extras?.vocalOnsets;
    if (!onsets?.length && !this._extras?.stems?.vocals?.length) return;

    const aligned = LyricsAligner.build(timedLines, this._duration, this._extras);
    this._masterSchedule = aligned.schedule;
    this._displayLeadSec = aligned.displayLead;
    this._lagShiftSec = aligned.lagShift;
    this._onsetMapped = this._masterSchedule.length > 0;

    if (cacheKey && this._onsetMapped) {
      LyricsCache.setWordSchedule(cacheKey, lyricsHash, this._masterSchedule, {
        exact: false,
        alignVersion: LyricsAligner.ALIGN_VERSION,
        displayLead: this._displayLeadSec,
        lagShift: this._lagShiftSec,
      });
    }
  }

  clear() {
    this.lines = [];
    this.timed = [];
    this.mode = "none";
    this.currentIndex = 0;
    this.fileName = "";
    this.source = "";
    this._masterSchedule = [];
    this._onsetMapped = false;
    this._exactWordTiming = false;
    this._whisperAligned = false;
    this._fromLocalPack = false;
  }

  hasLines() {
    return this.lines.length > 0 || this.timed.length > 0;
  }

  loadTimed(entries, source = "timed") {
    this.clear();
    this.mode = "timed";
    this.source = source;
    this.timed = entries
      .map((e) => ({ time: e.time, text: e.text.trim() }))
      .filter((e) => e.text);
    this.timed.sort((a, b) => a.time - b.time);
    this.fileName = source;
    this._rebuildOnsetMap();
  }

  _parseInlineWordTags(text, lineTime, lineEnd) {
    const tagRe = /<(\d{1,2}):(\d{2})[.:](\d{1,3})>/g;
    const tags = [];
    let m;
    while ((m = tagRe.exec(text)) !== null) {
      tags.push({
        time: LyricsManager.parseLrcTime(m[1], m[2], m[3]),
      });
    }
    if (!tags.length) return null;

    const clean = text.replace(tagRe, " ").replace(/\s+/g, " ").trim();
    const words = clean.split(/\s+/).filter(Boolean);
    if (!words.length) return null;

    const schedule = [];
    for (let i = 0; i < words.length; i++) {
      const start = tags[i]?.time ?? lineTime;
      const end = tags[i + 1]?.time ?? lineEnd;
      schedule.push({ word: words[i], start, end: Math.max(end, start + 0.05) });
    }
    return { words: clean, schedule };
  }

  loadFromLrc(text, source = "LRC") {
    this.clear();
    this.fileName = source;
    this.source = source;
    this.mode = "timed";

    const rawLines = [];

    for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
      const m = line.match(/^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]\s*(.*)$/);
      if (!m) continue;
      const txt = m[4].trim();
      if (!txt) continue;
      rawLines.push({
        time: LyricsManager.parseLrcTime(m[1], m[2], m[3]),
        text: txt,
      });
    }

    rawLines.sort((a, b) => a.time - b.time);

    let hasWordTags = false;
    const wordSchedule = [];

    for (let li = 0; li < rawLines.length; li++) {
      const lineTime = rawLines[li].time;
      const lineEnd = rawLines[li + 1]?.time ?? lineTime + 4;
      const parsed = this._parseInlineWordTags(rawLines[li].text, lineTime, lineEnd);

      if (parsed?.schedule?.length) {
        hasWordTags = true;
        this.timed.push({ time: lineTime, text: parsed.words });
        parsed.schedule.forEach((w, wi) => {
          wordSchedule.push({
            lineIndex: li,
            word: w.word,
            start: w.start,
            end: w.end,
            envPts: null,
            wordIndex: wi,
          });
        });
      } else {
        const clean = rawLines[li].text.replace(/<\d{1,2}:\d{2}[.:]\d{1,3}>/g, " ").replace(/\s+/g, " ").trim();
        this.timed.push({ time: lineTime, text: clean });
      }
    }

    if (hasWordTags && wordSchedule.length) {
      this._masterSchedule = wordSchedule;
      this._onsetMapped = true;
      this._exactWordTiming = true;
      const cacheKey = this._trackCacheKey;
      if (cacheKey) {
        LyricsCache.setWordSchedule(cacheKey, this._lyricsFingerprint(), wordSchedule, {
          exact: true,
        });
      }
    } else {
      this._rebuildOnsetMap();
    }
  }

  loadFromText(text, fileName = "lyrics.txt") {
    this.clear();
    this.fileName = fileName;
    this.source = "file";

    const raw = text.replace(/\r\n/g, "\n").trim();
    if (!raw) return;

    const lrcLines = raw.split("\n").filter((l) => /^\[\d{1,2}:\d{2}/.test(l.trim()));
    if (lrcLines.length >= 2) {
      this.loadFromLrc(raw, fileName);
      return;
    }

    this.mode = "plain";
    this.lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    this._rebuildOnsetMap();
  }

  alignToVocals(extras, duration) {
    const plain =
      this.mode === "plain"
        ? this.lines
        : this.lines.length
          ? this.lines
          : null;

    const sourceLines =
      plain ||
      (this.timed.length === 0 && this.lines.length === 0
        ? null
        : this.getAllLines());

    const lines = plain || sourceLines;
    if (!lines?.length || !extras?.rms?.length) return false;

    this._duration = duration;
    const { rms, times, avgRms } = extras;
    const weights = [];

    for (let i = 0; i < rms.length; i++) {
      const delta = i > 0 ? Math.abs(rms[i] - rms[i - 1]) : 0;
      const sustained = delta < avgRms * 0.14;
      const vocalish = rms[i] * (sustained ? 1.35 : 0.75);
      weights.push(Math.max(0, vocalish));
    }

    const smoothWin = 3;
    const smooth = weights.map((_, i) => {
      let s = 0;
      let c = 0;
      for (let j = Math.max(0, i - smoothWin); j <= Math.min(weights.length - 1, i + smoothWin); j++) {
        s += weights[j];
        c++;
      }
      return s / c;
    });

    const total = smooth.reduce((a, b) => a + b, 0) || 1;
    const timed = [];
    let lineIdx = 0;
    let cum = 0;

    timed.push({ time: Math.max(0, times[0] || 0), text: lines[0] });

    for (let i = 1; i < smooth.length && lineIdx < lines.length - 1; i++) {
      cum += smooth[i];
      const target = ((lineIdx + 1) / lines.length) * total;
      if (cum >= target) {
        lineIdx++;
        const t = times[i];
        if (!timed.length || t > timed[timed.length - 1].time + 0.25) {
          timed.push({ time: t, text: lines[lineIdx] });
        }
      }
    }

    if (timed.length < lines.length) {
      const step = duration / lines.length;
      this.loadTimed(
        lines.map((text, i) => ({ time: step * i, text })),
        "vocal-aligned (even)"
      );
    } else {
      this.loadTimed(timed, "vocal-aligned");
    }

    this._extras = extras;
    this._rebuildOnsetMap();
    return true;
  }

  async loadFile(file) {
    const text = await file.text();
    this.loadFromText(text, file.name);
  }

  update(audio) {
    if (!this.hasLines()) return;

    const t = this.getSyncTime(audio.getCurrentTime());

    if (this.mode === "timed") {
      if (this._usesScheduleLineIndex()) {
        this.currentIndex = this._lineIndexFromSchedule(t);
      } else {
        let idx = 0;
        for (let i = 0; i < this.timed.length; i++) {
          if (this.timed[i].time <= t) idx = i;
          else break;
        }
        this.currentIndex = idx;
      }
      return;
    }

    if (this.mode === "plain") {
      const dur = audio.getDuration();
      if (dur > 0 && this.lines.length > 0) {
        this.currentIndex = Math.min(
          this.lines.length - 1,
          Math.floor((t / dur) * this.lines.length)
        );
      }
    }
  }

  getWordSchedule() {
    if (!this._onsetMapped) return [];
    return this._masterSchedule.filter((e) => e.lineIndex === this.currentIndex);
  }

  getActiveWordIndex(audio) {
    const t = this.getSyncTime(audio?.getCurrentTime?.() ?? 0);
    const schedule = this.getWordSchedule();
    if (!schedule.length) return 0;

    for (let i = 0; i < schedule.length; i++) {
      const end = schedule[i].end ?? schedule[i + 1]?.start ?? Infinity;
      if (t >= schedule[i].start && t < end) return i;
    }

    if (t < schedule[0].start) return 0;
    return schedule.length - 1;
  }

  getCurrentLine() {
    if (this.mode === "timed" && this.timed.length > 0) {
      return this.timed[this.currentIndex]?.text || "";
    }
    if (this.lines.length > 0) {
      return this.lines[this.currentIndex] || "";
    }
    return "";
  }

  getNextLine() {
    if (this.mode === "timed" && this.timed.length > 0) {
      return this.timed[this.currentIndex + 1]?.text || "";
    }
    if (this.lines.length > 0) {
      return this.lines[(this.currentIndex + 1) % this.lines.length] || "";
    }
    return "";
  }

  getSourceLabel() {
    if (!this.hasLines()) return "";
    const mapNote = this._fromLocalPack
      ? " · Demucs + Whisper (local)"
      : this._whisperAligned
        ? " · Whisper (singer timestamps)"
        : this._exactWordTiming
        ? " · word-synced"
        : this._onsetMapped
          ? " · vocal-aligned"
          : "";
    if (this.source) return this.source + mapNote;
    if (this.mode === "timed") return "time-synced" + mapNote;
    return (this.fileName || "lyrics") + mapNote;
  }

  getWordsForTypography() {
    return this.getCurrentLine() || null;
  }

  getAllLines() {
    if (this.mode === "timed") return this.timed.map((t) => t.text);
    return this.lines;
  }

  getTotalLines() {
    if (this.mode === "timed") return this.timed.length;
    return this.lines.length;
  }

  draw(p, theme, _energy, audio) {
    const line = this.getCurrentLine();
    if (!line) return;

    LyricsRenderer.draw(p, line, theme, null, {
      wordSchedule: this.getWordSchedule(),
      currentTime: this.getSyncTime(audio?.getCurrentTime?.() ?? 0),
      liveVocalCtx: this._liveVocalCtx(),
      lineIndex: this.currentIndex,
      totalLines: this.getTotalLines(),
      nextLine: this.getNextLine(),
    });
  }
}
