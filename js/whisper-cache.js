const WhisperCache = {
  DB_NAME: "reelstudio_whisper_v2",
  STORE: "data",
  VERSION: 5,

  _dbPromise: null,

  _open() {
    if (!this._dbPromise) {
      this._dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(this.DB_NAME, 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(this.STORE)) {
            db.createObjectStore(this.STORE);
          }
        };
      });
    }
    return this._dbPromise;
  },

  _transcriptKey(trackKey) {
    return `transcript::${trackKey}`;
  },

  _scheduleKey(trackKey, lyricsHash) {
    return `schedule::${trackKey}::${lyricsHash}`;
  },

  async _get(key) {
    try {
      const db = await this._open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE, "readonly");
        const req = tx.objectStore(this.STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  },

  async _set(key, value) {
    try {
      const db = await this._open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE, "readwrite");
        tx.objectStore(this.STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn("Whisper cache write failed:", err);
    }
  },

  async getTranscript(trackKey) {
    const hit = await this._get(this._transcriptKey(trackKey));
    if (!hit?.asrWords?.length || hit.version !== this.VERSION) return null;
    return hit;
  },

  async setTranscript(trackKey, asrWords) {
    await this._set(this._transcriptKey(trackKey), {
      asrWords,
      version: this.VERSION,
      cachedAt: Date.now(),
    });
  },

  async getSchedule(trackKey, lyricsHash) {
    const hit = await this._get(this._scheduleKey(trackKey, lyricsHash));
    if (
      !hit?.schedule?.length ||
      hit.version !== this.VERSION ||
      hit.scheduleVersion !== WhisperAligner.SCHEDULE_VERSION
    ) {
      return null;
    }
    return hit;
  },

  async setSchedule(trackKey, lyricsHash, schedule, asrWords) {
    await this._set(this._scheduleKey(trackKey, lyricsHash), {
      schedule,
      asrWords,
      version: this.VERSION,
      scheduleVersion: WhisperAligner.SCHEDULE_VERSION,
      cachedAt: Date.now(),
    });
  },

  async clearTranscript(trackKey) {
    try {
      const db = await this._open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE, "readwrite");
        tx.objectStore(this.STORE).delete(this._transcriptKey(trackKey));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* ignore */
    }
  },

  async clearAll() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(this.DB_NAME);
      req.onsuccess = () => {
        this._dbPromise = null;
        resolve();
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  },
};
