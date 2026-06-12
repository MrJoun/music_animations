/**
 * Single-source timing engine for word_schedule karaoke.
 * Uses only schedule timestamps — no LRC line times or vocal onsets.
 */
const KaraokeClock = {
  MIN_WORD_SEC: 0.09,
  INTER_WORD_GAP_SEC: 0.05,

  getSyncTime(audioTime, userOffset = 0) {
    return (audioTime ?? 0) + userOffset;
  },

  _smoothstep(x) {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
  },

  /** Index of word containing t, or -1 when t falls in an inter-word gap. */
  findActiveWordIndex(schedule, t) {
    if (!schedule?.length) return -1;

    let lo = 0;
    let hi = schedule.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const w = schedule[mid];
      if (t < w.start) hi = mid - 1;
      else if (t > w.end) lo = mid + 1;
      else return mid;
    }
    return -1;
  },

  findActiveWord(schedule, t) {
    const idx = this.findActiveWordIndex(schedule, t);
    return idx >= 0 ? schedule[idx] : null;
  },

  findLineIndex(schedule, t) {
    const idx = this.findActiveWordIndex(schedule, t);
    if (idx >= 0) return schedule[idx].lineIndex ?? 0;

    for (let i = schedule.length - 1; i >= 0; i--) {
      if (schedule[i].start <= t) return schedule[i].lineIndex ?? 0;
    }
    return 0;
  },

  isInGap(schedule, t) {
    if (!schedule?.length) return false;
    return this.findActiveWordIndex(schedule, t) === -1 && t >= schedule[0].start;
  },

  wordProgress(entry, t) {
    if (!entry) return 0;
    if (t < entry.start) return 0;
    const fillEnd = entry.fillEnd ?? entry.end;
    if (t >= fillEnd) return 1;
    const span = Math.max(this.MIN_WORD_SEC, fillEnd - entry.start);
    return this._smoothstep((t - entry.start) / span);
  },

  /**
   * pending — before start
   * active — sung window [start, end]
   * gap — after end, before next word (filled, no highlight)
   * done — after next word has started or trailing tail
   */
  wordState(entry, t, nextEntry = null) {
    if (!entry) return "pending";
    if (t < entry.start) return "pending";
    if (t >= entry.start && t <= entry.end) return "active";
    if (nextEntry && t > entry.end && t < nextEntry.start) return "gap";
    return "done";
  },

  /** Group schedule entries by lineIndex for O(1) line word slices. */
  indexByLine(schedule) {
    const byLine = [];
    for (const w of schedule) {
      const li = w.lineIndex ?? 0;
      while (byLine.length <= li) byLine.push([]);
      byLine[li].push(w);
    }
    return byLine;
  },

  buildLinesFromSchedule(schedule) {
    return this.indexByLine(schedule).map((words) =>
      words.map((w) => w.word).join(" ")
    );
  },

  /** Global word index within full schedule for a line-local word index. */
  scheduleOffsetForLine(byLine, lineIndex) {
    let offset = 0;
    for (let i = 0; i < lineIndex && i < byLine.length; i++) {
      offset += byLine[i].length;
    }
    return offset;
  },
};
