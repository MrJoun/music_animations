const LyricsOnsetMapper = {
  build(timedLines, vocalOnsets, duration, extras = null) {
    const result = LyricsAligner.build(timedLines, duration, {
      ...extras,
      vocalOnsets,
    });
    return result.schedule;
  },

  wordProgress(entry, t, liveCtx = null) {
    return LyricsAligner.wordProgress(entry, t, liveCtx);
  },

  wordState(entry, t) {
    return LyricsAligner.wordState(entry, t);
  },

  get PAST_LINGER_SEC() {
    return LyricsAligner.PAST_LINGER_SEC;
  },
};
