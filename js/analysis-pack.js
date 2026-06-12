const AnalysisPack = {
  MANIFEST_VERSION: 1,

  getSidecarUrl(fileName) {
    const base = fileName.replace(/\.[^/.]+$/, "");
    return encodeURI(`${base}.analysis/manifest.json`);
  },

  _baseUrl(manifestUrl) {
    return manifestUrl.replace(/manifest\.json$/i, "");
  },

  async load(fileName) {
    try {
      const manifestUrl = this.getSidecarUrl(fileName);
      const manifestRes = await fetch(manifestUrl);
      if (!manifestRes.ok) return null;

      const manifest = await manifestRes.json();
      if (manifest.version !== this.MANIFEST_VERSION) {
        console.warn("Unsupported analysis pack version:", manifest.version);
        return null;
      }

      const baseUrl = this._baseUrl(manifestUrl);
      const pack = { manifest, fileName, baseUrl };

      const envPath = manifest.paths?.envelopes;
      if (envPath) {
        const envRes = await fetch(baseUrl + envPath);
        if (envRes.ok) pack.envelopes = await envRes.json();
      }

      const schedulePath = manifest.paths?.word_schedule;
      if (schedulePath) {
        const wsRes = await fetch(baseUrl + schedulePath);
        if (wsRes.ok) pack.wordSchedule = await wsRes.json();
      }

      return pack;
    } catch (err) {
      console.warn("Analysis pack load failed:", err);
      return null;
    }
  },

  applyPack(pack, songAnalyzer) {
    if (!pack) return null;
    songAnalyzer.importAnalysisPack(pack);
    return pack;
  },

  applyWordSchedule(pack, lyrics) {
    if (!pack?.wordSchedule?.length || !lyrics.hasLines()) return false;
    return lyrics.loadWordScheduleFromPack(pack.wordSchedule);
  },
};
