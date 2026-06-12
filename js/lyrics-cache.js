const LyricsCache = {
  LYRICS_KEY: "reelstudio_lyrics_v2",
  SCHEDULE_KEY: "reelstudio_wordmap_v6",
  MAX_LYRICS_ENTRIES: 48,
  MAX_SCHEDULE_ENTRIES: 24,

  trackKey(meta, durationSec, file) {
    const parts = [
      (meta?.artist || "").trim().toLowerCase(),
      (meta?.title || "").trim().toLowerCase(),
      String(Math.round(durationSec || 0)),
      (file?.name || "").toLowerCase(),
      file?.size != null ? String(file.size) : "",
    ];
    return parts.join("|");
  },

  hashText(text) {
    let h = 5381;
    const s = text || "";
    for (let i = 0; i < s.length; i++) {
      h = (h * 33) ^ s.charCodeAt(i);
    }
    return (h >>> 0).toString(36);
  },

  lyricsFingerprint(lyricsManager) {
    if (lyricsManager.mode === "timed" && lyricsManager.timed.length) {
      return this.hashText(
        lyricsManager.timed.map((l) => `${l.time.toFixed(3)}:${l.text}`).join("\n")
      );
    }
    return this.hashText((lyricsManager.lines || []).join("\n"));
  },

  _readStore(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return { v: 2, entries: {} };
      const parsed = JSON.parse(raw);
      if (!parsed?.entries) return { v: 2, entries: {} };
      return parsed;
    } catch {
      return { v: 2, entries: {} };
    }
  },

  _writeStore(key, store, maxEntries) {
    const entries = store.entries || {};
    const keys = Object.keys(entries);
    if (keys.length > maxEntries) {
      keys
        .sort((a, b) => (entries[b].cachedAt || 0) - (entries[a].cachedAt || 0))
        .slice(maxEntries)
        .forEach((k) => delete entries[k]);
    }
    try {
      localStorage.setItem(key, JSON.stringify({ v: 2, entries }));
    } catch (err) {
      console.warn("Lyrics cache write failed:", err);
    }
  },

  getLyrics(trackKey) {
    const store = this._readStore(this.LYRICS_KEY);
    const hit = store.entries[trackKey];
    if (!hit?.syncedLyrics?.trim()) return null;
    return hit;
  },

  setLyrics(trackKey, payload) {
    const store = this._readStore(this.LYRICS_KEY);
    store.entries[trackKey] = {
      syncedLyrics: payload.syncedLyrics,
      plainLyrics: payload.plainLyrics || "",
      source: payload.source || "cache",
      meta: payload.meta || {},
      cachedAt: Date.now(),
    };
    this._writeStore(this.LYRICS_KEY, store, this.MAX_LYRICS_ENTRIES);
  },

  getWordSchedule(trackKey, lyricsHash) {
    const store = this._readStore(this.SCHEDULE_KEY);
    const hit = store.entries[`${trackKey}::${lyricsHash}`];
    if (!hit?.schedule?.length) return null;
    return hit;
  },

  setWordSchedule(trackKey, lyricsHash, schedule, meta = {}) {
    const store = this._readStore(this.SCHEDULE_KEY);
    store.entries[`${trackKey}::${lyricsHash}`] = {
      schedule,
      exact: !!meta.exact,
      alignVersion: meta.alignVersion ?? 0,
      displayLead: meta.displayLead ?? 0,
      lagShift: meta.lagShift ?? 0,
      cachedAt: Date.now(),
    };
    this._writeStore(this.SCHEDULE_KEY, store, this.MAX_SCHEDULE_ENTRIES);
  },
};
