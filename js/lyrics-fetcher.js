const LyricsFetcher = {
  API_BASE: "https://lrclib.net/api",
  USER_AGENT: "ReelStudio/1.0 (music-visualizer)",

  parseFilename(name) {
    const base = name.replace(/\.[^.]+$/, "").trim();
    let artist = "";
    let title = base;

    const patterns = [
      /^(.+?)\s*[-–—]\s*(.+)$/,
      /^(.+?)\s+by\s+(.+)$/i,
      /^(.+?)_\s*(.+)$/,
    ];

    for (const re of patterns) {
      const m = base.match(re);
      if (m) {
        artist = m[1].trim();
        title = m[2].trim();
        break;
      }
    }

    title = title.replace(/_/g, " ").trim();
    artist = artist.replace(/_/g, " ").trim();

    return { artist, title, album: "" };
  },

  mergeMeta(id3, filename) {
    const fromName = this.parseFilename(filename);
    return {
      artist: id3?.artist || fromName.artist || "Unknown Artist",
      title: id3?.title || fromName.title || filename,
      album: id3?.album || fromName.album || "",
    };
  },

  async _fetchJson(path) {
    try {
      const res = await fetch(`${this.API_BASE}${path}`, {
        headers: { "User-Agent": this.USER_AGENT },
      });
      if (!res.ok) return null;
      return res.json();
    } catch (err) {
      console.warn("LRCLIB fetch failed:", err);
      return null;
    }
  },

  _durationMatch(a, b, tolerance = 2) {
    return Math.abs(a - b) <= tolerance;
  },

  _titleScore(trackName, query) {
    const norm = (s) =>
      (s || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1);
    const a = norm(trackName);
    const b = norm(query);
    if (!b.length) return 0;
    let hits = 0;
    for (const w of b) {
      if (a.some((t) => t === w || t.includes(w) || w.includes(t))) hits++;
    }
    return hits / b.length;
  },

  _scoreResult(r, duration, titleQuery) {
    const durDiff = duration > 0 ? Math.abs((r.duration || 0) - duration) : 99;
    const durScore = duration > 0 ? Math.max(0, 1 - durDiff / 12) : 0.3;
    const titleScore = this._titleScore(r.trackName || r.name, titleQuery);
    const syncBonus = r.syncedLyrics?.trim() ? 0.35 : 0;
    return titleScore * 0.55 + durScore * 0.35 + syncBonus;
  },

  _pickBestMatch(results, duration, titleQuery) {
    if (!results?.length) return null;
    const withSync = results.filter((r) => r.syncedLyrics?.trim());
    const pool = withSync.length ? withSync : results;

    let best = pool[0];
    let bestScore = -1;
    for (const r of pool) {
      const score = this._scoreResult(r, duration, titleQuery);
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }

    if (duration > 0 && bestScore < 0.45) {
      const byDur = pool.find((r) => this._durationMatch(r.duration || 0, duration, 2));
      if (byDur && this._titleScore(byDur.trackName, titleQuery) >= 0.5) return byDur;
      return null;
    }
    return best;
  },

  async fetchSynced(meta, durationSec, file = null) {
    const cacheKey = LyricsCache.trackKey(meta, durationSec, file);
    const cached = LyricsCache.getLyrics(cacheKey);
    if (cached?.syncedLyrics?.trim()) {
      return {
        syncedLyrics: cached.syncedLyrics,
        plainLyrics: cached.plainLyrics,
        source: `${cached.source} (cached)`,
        meta: cached.meta || meta,
        fromCache: true,
      };
    }

    const params = new URLSearchParams({
      track_name: meta.title,
      artist_name: meta.artist,
      album_name: meta.album || "Unknown",
      duration: String(Math.round(durationSec)),
    });

    let data = await this._fetchJson(`/get-cached?${params}`);
    if (!data?.syncedLyrics) {
      data = await this._fetchJson(`/get?${params}`);
    }
    if (data?.syncedLyrics?.trim()) {
      const payload = {
        syncedLyrics: data.syncedLyrics,
        plainLyrics: data.plainLyrics,
        source: "lrclib",
        meta: {
          artist: data.artistName,
          title: data.trackName,
          album: data.albumName,
        },
      };
      LyricsCache.setLyrics(cacheKey, payload);
      return payload;
    }

    const searchParams = new URLSearchParams({ track_name: meta.title });
    if (meta.artist && meta.artist !== "Unknown Artist") {
      searchParams.set("artist_name", meta.artist);
    }
    let search = await this._fetchJson(`/search?${searchParams}`);

    if (!search?.length) {
      const q = [meta.title, meta.artist].filter((s) => s && s !== "Unknown Artist").join(" ");
      search = await this._fetchJson(`/search?${new URLSearchParams({ q })}`);
    }

    const match = this._pickBestMatch(search, durationSec, meta.title);
    if (match?.syncedLyrics?.trim()) {
      const payload = {
        syncedLyrics: match.syncedLyrics,
        plainLyrics: match.plainLyrics,
        source: "lrclib",
        meta: {
          artist: match.artistName,
          title: match.trackName,
          album: match.albumName,
        },
      };
      LyricsCache.setLyrics(cacheKey, payload);
      return payload;
    }

    return null;
  },

  async autoLoad(file, durationSec, analysisExtras, lyricsManager) {
    let id3 = {};
    if (file.name.toLowerCase().endsWith(".mp3")) {
      try {
        id3 = await Id3LyricsReader.readFromFile(file);
      } catch {
        id3 = {};
      }
    }

    const meta = this.mergeMeta(id3, file.name);
    lyricsManager.setTrackCacheKey(LyricsCache.trackKey(meta, durationSec, file));

    if (id3.syncedLyrics) {
      lyricsManager.loadFromLrc(id3.syncedLyrics, "embedded (ID3)");
      return { ok: true, source: "id3-sync", meta, lineCount: lyricsManager.timed.length };
    }

    if (id3.syncedLines?.length) {
      lyricsManager.loadTimed(id3.syncedLines, "embedded (ID3)");
      return { ok: true, source: "id3-sync", meta, lineCount: id3.syncedLines.length };
    }

    const online = await this.fetchSynced(meta, durationSec, file);
    if (online?.syncedLyrics) {
      const label = online.fromCache
        ? `LRCLIB (cached) · ${online.meta.artist}`
        : `LRCLIB · ${online.meta.artist}`;
      lyricsManager.loadFromLrc(online.syncedLyrics, label);
      return {
        ok: true,
        source: online.source,
        meta: online.meta,
        lineCount: lyricsManager.timed.length,
        fromCache: !!online.fromCache,
      };
    }

    const plain = id3.plainLyrics;
    if (plain) {
      lyricsManager.loadFromText(plain, "embedded (ID3)");
      if (analysisExtras?.rms?.length) {
        lyricsManager.alignToVocals(analysisExtras, durationSec);
        return {
          ok: true,
          source: "id3-aligned",
          meta,
          lineCount: lyricsManager.timed.length,
        };
      }
      return { ok: true, source: "id3-plain", meta, lineCount: lyricsManager.lines.length };
    }

    return { ok: false, meta };
  },
};
