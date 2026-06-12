/**
 * Single-source timing engine for word_schedule karaoke.
 * Uses only schedule timestamps — no LRC line times or vocal onsets.
 */
const KaraokeClock = {
  MIN_WORD_SEC: 0.09,
  LINGER_SEC: 0.28,

  getSyncTime(audioTime, userOffset = 0) {
    return (audioTime ?? 0) + userOffset;
  },

  _smoothstep(x) {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
  },

  /** Last schedule index whose start <= t (binary search). Clamps at ends. */
  findActiveWordIndex(schedule, t) {
    if (!schedule?.length) return -1;
    if (t <= schedule[0].start) return 0;

    const last = schedule.length - 1;
    if (t >= schedule[last].start) return last;

    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (schedule[mid].start <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  },

  findActiveWord(schedule, t) {
    const idx = this.findActiveWordIndex(schedule, t);
    return idx >= 0 ? schedule[idx] : null;
  },

  findLineIndex(schedule, t) {
    const word = this.findActiveWord(schedule, t);
    if (!word) return 0;
    return word.lineIndex ?? 0;
  },

  wordProgress(entry, t) {
    if (!entry) return 0;
    if (t < entry.start) return 0;
    const fillEnd = entry.fillEnd ?? entry.end;
    if (t >= fillEnd) return 1;
    const span = Math.max(this.MIN_WORD_SEC, fillEnd - entry.start);
    return this._smoothstep((t - entry.start) / span);
  },

  wordState(entry, t) {
    if (!entry) return "future";
    if (t < entry.start) return "future";
    if (t >= entry.end + this.LINGER_SEC) return "past";
    if (t >= entry.end) return "linger";
    return "active";
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
