const AppCache = {
  LOCAL_PREFIXES: ["reelstudio_lyrics", "reelstudio_wordmap", "reelstudio_sync::"],

  async clearAll() {
    let removed = 0;

    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && this.LOCAL_PREFIXES.some((p) => k.startsWith(p))) keys.push(k);
      }
      keys.forEach((k) => {
        localStorage.removeItem(k);
        removed++;
      });
    } catch (err) {
      console.warn("localStorage clear failed:", err);
    }

    try {
      await WhisperCache.clearAll();
      removed++;
    } catch (err) {
      console.warn("Whisper IDB clear failed:", err);
    }

    return removed;
  },
};
