const LyricsAligner = {
  ALIGN_VERSION: 4,
  FRAME_LAG_SEC: 0.038,
  DISPLAY_LEAD_SEC: 0.08,
  PAST_LINGER_SEC: 0.38,
  WORD_OVERLAP_SEC: 0.02,
  FILL_COMPLETE_RATIO: 0.68,

  _syllableWeight(word) {
    return LyricsTiming._syllableWeight(word);
  },

  _lineEnd(timed, lineIndex, duration) {
    const next = timed[lineIndex + 1];
    if (next) return next.time;
    const n = timed[lineIndex].text.split(/\s+/).filter(Boolean).length;
    return timed[lineIndex].time + Math.max(1.8, n * 0.3);
  },

  _frameRange(times, lo, hi) {
    let iLo = 0;
    let iHi = times.length - 1;
    for (let i = 0; i < times.length; i++) {
      if (times[i] >= lo) {
        iLo = i;
        break;
      }
    }
    for (let i = times.length - 1; i >= 0; i--) {
      if (times[i] <= hi) {
        iHi = i;
        break;
      }
    }
    return { iLo, iHi };
  },

  _correctTime(t) {
    return t - this.FRAME_LAG_SEC;
  },

  flattenSong(timedLines, duration) {
    const flat = [];
    for (let li = 0; li < timedLines.length; li++) {
      const lineStart = timedLines[li].time;
      const lineEnd = this._lineEnd(timedLines, li, duration);
      const tokens = timedLines[li].text.split(/\s+/).filter(Boolean);
      const weights = tokens.map((w) => Math.max(0.75, this._syllableWeight(w)));
      const total = weights.reduce((a, b) => a + b, 0) || 1;
      let cum = 0;

      for (let wi = 0; wi < tokens.length; wi++) {
        const anchor = lineStart + (cum / total) * (lineEnd - lineStart) * 0.9;
        cum += weights[wi];
        flat.push({
          word: tokens[wi],
          lineIndex: li,
          wordIndex: wi,
          lineStart,
          lineEnd,
          anchor,
          isLineEnd: wi === tokens.length - 1,
        });
      }
    }
    return flat;
  },

  extractGlobalOnsets(times, vocals, avgVocal) {
    if (!times?.length || !vocals?.length) return [];

    const flux = [0];
    for (let i = 1; i < vocals.length; i++) {
      flux.push(Math.max(0, vocals[i] - vocals[i - 1]));
    }

    const floor = Math.max(0.055, avgVocal * 0.26);
    const onsets = [];

    for (let i = 2; i < vocals.length - 2; i++) {
      if (vocals[i] < floor) continue;

      const attack = flux[i] > avgVocal * 0.04 && vocals[i] > vocals[i - 1] * 1.05;
      const peak =
        flux[i] >= flux[i - 1] &&
        flux[i] >= flux[i + 1] &&
        flux[i] > avgVocal * 0.028;

      if (!attack && !peak) continue;

      const t = this._correctTime(times[i]);
      const minGap = vocals[i] > avgVocal * 0.6 ? 0.065 : 0.04;
      if (onsets.length && t - onsets[onsets.length - 1] < minGap) {
        if (flux[i] > flux[i - 1]) onsets[onsets.length - 1] = t;
        continue;
      }
      onsets.push(t);
    }

    return onsets;
  },

  estimateLagShift(timedLines, times, vocals, avgVocal) {
    if (!timedLines?.length || !times?.length || !vocals?.length) return 0;

    const deltas = [];
    const floor = Math.max(0.06, avgVocal * 0.28);

    for (const line of timedLines) {
      const lineTime = line.time;
      const lo = lineTime - 0.42;
      const hi = lineTime + 0.1;
      const { iLo, iHi } = this._frameRange(times, lo, hi);

      let bestT = null;
      let bestFlux = -Infinity;

      for (let i = Math.max(1, iLo); i <= iHi; i++) {
        if (vocals[i] < floor) continue;
        const flux = vocals[i] - vocals[i - 1];
        if (flux > bestFlux) {
          bestFlux = flux;
          bestT = this._correctTime(times[i]);
        }
      }

      if (bestT != null && bestFlux > avgVocal * 0.02) {
        deltas.push(lineTime - bestT);
      }
    }

    if (deltas.length < 2) return 0.1;

    deltas.sort((a, b) => a - b);
    const median = deltas[Math.floor(deltas.length / 2)];
    return Math.max(0, Math.min(0.4, median));
  },

  _onsetCost(onsetT, anchorT) {
    const d = onsetT - anchorT;
    const ideal = -0.05;
    const err = d - ideal;
    let cost = err * err;
    if (d > 0.1) cost *= 2 + Math.min(2.5, d * 3.5);
    return cost;
  },

  globalDTW(flat, onsets) {
    const n = flat.length;
    if (!n) return [];

    if (!onsets.length) {
      return flat.map((f) => ({
        word: f.word,
        lineIndex: f.lineIndex,
        wordIndex: f.wordIndex,
        isLineEnd: f.isLineEnd,
        start: f.anchor - 0.05,
        end: f.anchor + 0.1,
      }));
    }

    const m = onsets.length;
    if (m < n) {
      return flat.map((f, i) => ({
        word: f.word,
        lineIndex: f.lineIndex,
        wordIndex: f.wordIndex,
        isLineEnd: f.isLineEnd,
        start: onsets[Math.min(m - 1, Math.floor((i / n) * m))] - 0.03,
        end: f.isLineEnd ? onsets[Math.min(m - 1, Math.floor((i / n) * m))] + 0.22 : f.lineEnd,
      }));
    }

    const INF = 1e15;
    const dp = Array.from({ length: n }, () => new Float64Array(m).fill(INF));
    const prev = Array.from({ length: n }, () => new Int32Array(m).fill(-1));

    for (let j = 0; j < m; j++) {
      dp[0][j] = this._onsetCost(onsets[j], flat[0].anchor);
    }

    for (let i = 1; i < n; i++) {
      for (let j = i; j < m; j++) {
        const local = this._onsetCost(onsets[j], flat[i].anchor);
        for (let pj = i - 1; pj < j; pj++) {
          const cand = dp[i - 1][pj] + local;
          if (cand < dp[i][j]) {
            dp[i][j] = cand;
            prev[i][j] = pj;
          }
        }
      }
    }

    let bestJ = n - 1;
    let bestCost = INF;
    for (let j = n - 1; j < m; j++) {
      if (dp[n - 1][j] < bestCost) {
        bestCost = dp[n - 1][j];
        bestJ = j;
      }
    }

    const starts = Array(n);
    let i = n - 1;
    let j = bestJ;
    while (i >= 0) {
      starts[i] = onsets[j];
      if (i === 0) break;
      const pj = prev[i][j];
      j = pj >= 0 ? pj : Math.max(0, j - 1);
      i--;
    }

    return flat.map((f, idx) => {
      const start = starts[idx];
      const nextSameLine = idx < n - 1 && flat[idx + 1].lineIndex === f.lineIndex;
      let end;
      if (nextSameLine) {
        end = Math.max(start + 0.035, starts[idx + 1]);
      } else {
        const span = Math.min(0.35, (f.lineEnd - start) * 0.42);
        end = start + Math.max(0.1, span);
      }
      return {
        word: f.word,
        lineIndex: f.lineIndex,
        wordIndex: f.wordIndex,
        isLineEnd: f.isLineEnd,
        start,
        end,
      };
    });
  },

  _findVocalRelease(times, vocals, peakT, searchEnd, peak, floor) {
    let releaseT = searchEnd;
    let below = 0;
    const { iLo, iHi } = this._frameRange(times, peakT, searchEnd + 0.05);

    for (let fi = iLo; fi <= iHi; fi++) {
      const t = this._correctTime(times[fi]);
      if (t < peakT + 0.02) continue;
      if (t > searchEnd + 0.04) break;
      if (vocals[fi] < peak * 0.38) {
        below++;
        if (below >= 2) {
          releaseT = t;
          break;
        }
      } else {
        below = 0;
      }
    }
    return releaseT;
  },

  refineWindows(schedule, times, vocals, avgVocal) {
    if (!schedule.length || !times?.length) return schedule;

    const floor = Math.max(0.065, avgVocal * 0.28);
    const out = [];

    for (let i = 0; i < schedule.length; i++) {
      const coarse = schedule[i];
      const next = schedule[i + 1];
      const nextSameLine = next && next.lineIndex === coarse.lineIndex;
      const nextStart = nextSameLine ? next.start : null;
      const segEnd = nextStart ?? coarse.end;

      const winLo = Math.max(0, coarse.start - 0.12);
      const winHi = Math.min(times[times.length - 1], segEnd + 0.06);
      const { iLo, iHi } = this._frameRange(times, winLo, winHi);

      let attackT = coarse.start;
      let bestFlux = -Infinity;
      const attackHi = coarse.start + 0.09;

      for (let fi = Math.max(1, iLo); fi <= iHi; fi++) {
        const t = this._correctTime(times[fi]);
        if (t > attackHi) break;
        if (vocals[fi] < floor * 0.75) continue;
        const flux = vocals[fi] - vocals[fi - 1];
        if (flux > bestFlux) {
          bestFlux = flux;
          attackT = t;
        }
      }

      let peak = 0;
      let peakT = attackT;
      for (let fi = iLo; fi <= iHi; fi++) {
        const t = this._correctTime(times[fi]);
        if (t < attackT - 0.02) continue;
        if (t > segEnd + 0.03) break;
        if (vocals[fi] > peak) {
          peak = vocals[fi];
          peakT = t;
        }
      }

      const releaseT = this._findVocalRelease(
        times,
        vocals,
        peakT,
        segEnd,
        Math.max(peak, floor),
        floor
      );

      const start = attackT - 0.03;
      let end = Math.max(releaseT, start + 0.04);
      if (nextStart != null) {
        end = Math.min(end, nextStart + this.WORD_OVERLAP_SEC);
      } else if (coarse.isLineEnd) {
        end = Math.min(end, peakT + 0.18);
        end = Math.max(end, start + 0.06);
      }

      const dur = end - start;
      const fillRatio = coarse.isLineEnd ? 0.58 : this.FILL_COMPLETE_RATIO;
      const fillEnd = start + dur * fillRatio;

      out.push({
        word: coarse.word,
        lineIndex: coarse.lineIndex,
        wordIndex: coarse.wordIndex,
        isLineEnd: coarse.isLineEnd,
        start,
        end,
        fillEnd,
        peak: Math.max(peak, floor),
        floor,
      });
    }

    for (let i = 1; i < out.length; i++) {
      if (out[i].start < out[i - 1].start + 0.02) {
        out[i].start = out[i - 1].start + 0.02;
      }
      if (out[i].fillEnd <= out[i].start + 0.03) {
        out[i].fillEnd = out[i].start + 0.05;
      }
      if (out[i].end <= out[i].fillEnd) {
        out[i].end = out[i].fillEnd + 0.04;
      }
    }

    return out;
  },

  applyShift(schedule, shiftSec) {
    if (!shiftSec || !schedule.length) return schedule;
    const shift = (e) => ({
      ...e,
      start: Math.max(0, e.start - shiftSec),
      end: Math.max(0.04, e.end - shiftSec),
      fillEnd: Math.max(0.03, (e.fillEnd ?? e.end) - shiftSec),
    });
    return schedule.map(shift);
  },

  build(timedLines, duration, extras) {
    const times = extras?.times || extras?.stems?.times;
    const vocals = extras?.stems?.vocals;
    if (!timedLines?.length) {
      return { schedule: [], lagShift: 0, displayLead: this.DISPLAY_LEAD_SEC };
    }

    let avgVocal = 0.1;
    if (vocals?.length) {
      avgVocal = vocals.reduce((a, b) => a + b, 0) / vocals.length;
    }

    const flat = this.flattenSong(timedLines, duration);
    const onsets =
      times?.length && vocals?.length
        ? this.extractGlobalOnsets(times, vocals, avgVocal)
        : (extras?.vocalOnsets || []).map((t) => t - this.FRAME_LAG_SEC);

    let schedule = this.globalDTW(flat, onsets);

    if (times?.length && vocals?.length) {
      schedule = this.refineWindows(schedule, times, vocals, avgVocal);
    } else {
      schedule = schedule.map((e) => ({
        ...e,
        fillEnd: e.start + (e.end - e.start) * this.FILL_COMPLETE_RATIO,
      }));
    }

    const lagShift =
      times?.length && vocals?.length
        ? this.estimateLagShift(timedLines, times, vocals, avgVocal)
        : 0.1;

    schedule = this.applyShift(schedule, lagShift);

    return {
      schedule,
      lagShift,
      displayLead: this.DISPLAY_LEAD_SEC,
      alignVersion: this.ALIGN_VERSION,
    };
  },

  interpolateVocal(times, vocals, t) {
    if (!times?.length) return 0;
    if (t <= this._correctTime(times[0])) return vocals[0];
    if (t >= this._correctTime(times[times.length - 1])) return vocals[vocals.length - 1];

    for (let i = 1; i < times.length; i++) {
      const t1 = this._correctTime(times[i]);
      if (t <= t1) {
        const t0 = this._correctTime(times[i - 1]);
        const span = t1 - t0;
        if (span <= 0) return vocals[i];
        const f = (t - t0) / span;
        return vocals[i - 1] + (vocals[i] - vocals[i - 1]) * f;
      }
    }
    return vocals[vocals.length - 1];
  },

  _adjustedTime(entry, t) {
    const posLead = (entry.wordIndex || 0) * 0.022;
    const lineEndBoost = entry.isLineEnd ? 0.045 : 0;
    return t + posLead + lineEndBoost;
  },

  wordProgress(entry, t, liveCtx = null) {
    if (!entry) return 0;

    if (entry.whisper) {
      return WhisperAligner.wordProgress(entry, t);
    }


    const tAdj = this._adjustedTime(entry, t);
    const fillEnd = entry.fillEnd ?? entry.end;
    const start = entry.start;

    if (tAdj < start) {
      if (liveCtx?.times?.length && start - tAdj <= 0.07) {
        const v = this.interpolateVocal(liveCtx.times, liveCtx.vocals, tAdj);
        const floor = entry.floor ?? liveCtx.avgVocal * 0.3;
        const peak = entry.peak || floor * 2;
        if (v > floor) {
          return Math.min(0.5, ((v - floor) / (peak - floor + 0.001)) * 0.55);
        }
      }
      return 0;
    }

    if (tAdj >= fillEnd) return 1;

    const span = Math.max(0.03, fillEnd - start);
    const linear = Math.min(1, (tAdj - start) / span);

    if (!liveCtx?.times?.length || !entry.peak) {
      return linear;
    }

    const v = this.interpolateVocal(liveCtx.times, liveCtx.vocals, tAdj);
    const floor = entry.floor ?? liveCtx.avgVocal * 0.28;
    const range = Math.max(0.06, entry.peak - floor);
    const instant = Math.min(1, Math.max(0, (v - floor) / range));

    const blend = entry.isLineEnd ? 0.35 : 0.25;
    return Math.min(1, linear * (1 - blend) + instant * blend + linear * 0.12);
  },

  wordState(entry, t) {
    if (!entry) return "future";
    const tUse = entry.whisper ? t : this._adjustedTime(entry, t);
    if (tUse < entry.start) return "future";

    const lingerEnd = entry.end + this.PAST_LINGER_SEC;
    if (tUse >= entry.end && tUse < lingerEnd) return "linger";
    if (tUse >= lingerEnd) return "past";
    return "active";
  },
};
