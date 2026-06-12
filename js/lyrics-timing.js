const LyricsTiming = {
  LOOKAHEAD_SEC: 0.2,
  GLOBAL_LEAD_SEC: 0.22,

  GLUE_WORDS: new Set([
    "i", "a", "an", "the", "to", "and", "or", "but", "so", "he", "she", "we", "you",
    "me", "my", "your", "his", "her", "it", "is", "in", "on", "at", "of", "for", "if",
    "as", "be", "got", "like", "that", "this", "with", "im", "youre", "dont", "cant",
    "aint", "its", "were", "was", "are", "am", "up", "out", "no", "not", "all", "just",
    "oh", "yeah", "uh", "na", "ya", "yo", "hey", "well", "when", "then", "than", "them",
    "they", "what", "why", "how", "who", "one", "two", "do", "did", "gon", "gonna",
  ]),

  _cleanWord(word) {
    return word.toLowerCase().replace(/[^a-z']/g, "");
  },

  _hasPauseAfter(word) {
    return /[,.!?;:…]$/.test(word);
  },

  _syllableWeight(word) {
    const w = this._cleanWord(word);
    if (!w) return 1;
    const vowelGroups = w.match(/[aeiouy]+/g) || [];
    let syl = vowelGroups.length;
    if (w.endsWith("e") && syl > 1) syl -= 0.45;
    return Math.max(0.8, syl);
  },

  _wordWeight(word) {
    const chars = word.replace(/[^a-zA-Z]/g, "").length;
    return Math.max(0.9, chars * 0.35 + this._syllableWeight(word));
  },

  _isGlue(word) {
    const w = this._cleanWord(word);
    return w.length <= 2 || this.GLUE_WORDS.has(w);
  },

  buildClusters(words) {
    const clusters = [];
    let current = [];

    const flush = () => {
      if (current.length) {
        clusters.push([...current]);
        current = [];
      }
    };

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const glue = this._isGlue(w);
      const pause = this._hasPauseAfter(w);

      if (!current.length) {
        current.push(w);
      } else if (glue && current.length < 5) {
        current.push(w);
      } else if (current.length < 3 && w.length <= 4 && !pause) {
        current.push(w);
      } else {
        flush();
        current.push(w);
      }

      if (pause || current.length >= 5) flush();
    }
    flush();
    return clusters.length ? clusters : [words];
  },

  _vocalOnsets(times, rms, avgRms, start, end) {
    const onsets = [];
    for (let i = 2; i < times.length; i++) {
      const t = times[i];
      if (t < start || t >= end) continue;
      const rising = rms[i] > rms[i - 1] * 1.08 && rms[i] > avgRms * 0.55;
      const peak = rms[i] >= rms[i - 1] && rms[i] >= rms[i + 1] && rms[i] > avgRms * 0.7;
      if (rising || peak) {
        if (!onsets.length || t - onsets[onsets.length - 1] > 0.08) {
          onsets.push(t);
        }
      }
    }
    return onsets;
  },

  _snapMonotonic(starts, minGap) {
    const out = [...starts];
    for (let i = 1; i < out.length; i++) {
      out[i] = Math.max(out[i], out[i - 1] + minGap);
    }
    return out;
  },

  _nearestBeatBefore(t, beats, maxDist = 0.28) {
    let best = null;
    let bestD = maxDist;
    for (const b of beats) {
      const d = t - b;
      if (d >= -0.05 && d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (best != null) return best;
    for (const b of beats) {
      const d = Math.abs(b - t);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return bestD <= maxDist ? best : null;
  },

  _clusterWeight(cluster) {
    let w = 0;
    for (const word of cluster) w += this._wordWeight(word);
    if (cluster.length > 1) {
      const glueRatio =
        cluster.filter((x) => this._isGlue(x)).length / cluster.length;
      if (glueRatio > 0.4) w *= 0.55;
    }
    return Math.max(0.5, w);
  },

  _assignClusterStarts(clusters, lineStart, lineEnd, beatTimes, onsets) {
    const span = Math.max(0.45, lineEnd - lineStart);
    const weights = clusters.map((c) => this._clusterWeight(c));
    const total = weights.reduce((a, b) => a + b, 0) || 1;

    let starts = [];
    let acc = 0;
    for (let i = 0; i < clusters.length; i++) {
      starts.push(lineStart + (acc / total) * span * 0.88);
      acc += weights[i];
    }

    if (onsets.length >= clusters.length) {
      const step = onsets.length / clusters.length;
      starts = clusters.map((_, i) => onsets[Math.min(onsets.length - 1, Math.floor(i * step))]);
    } else if (onsets.length >= 2 && clusters.length >= 2) {
      starts = clusters.map((_, i) => {
        const target = starts[i];
        let best = onsets[0];
        let bestD = Infinity;
        for (const o of onsets) {
          const d = Math.abs(o - target);
          if (d < bestD) {
            bestD = d;
            best = o;
          }
        }
        return bestD < 0.5 ? best : target;
      });
    }

    const beats = (beatTimes || []).filter((b) => b >= lineStart - 0.08 && b < lineEnd);
    if (beats.length >= 2) {
      for (let i = 0; i < starts.length; i++) {
        const snapped = this._nearestBeatBefore(starts[i], beats, 0.3);
        if (snapped != null) starts[i] = snapped - 0.04;
      }
    }

    const minGap = clusters.length > 6 ? 0.05 : 0.07;
    return this._snapMonotonic(starts, minGap);
  },

  buildWordSchedule(words, lineStart, lineEnd, beatTimes = [], extras = null) {
    if (!words.length) return [];

    const clusters = this.buildClusters(words);
    const onsets =
      extras?.times?.length && extras?.rms?.length
        ? this._vocalOnsets(
            extras.times,
            extras.rms,
            extras.avgRms || 0.1,
            lineStart,
            lineEnd
          )
        : [];

    const clusterStarts = this._assignClusterStarts(
      clusters,
      lineStart,
      lineEnd,
      beatTimes,
      onsets
    );

    const schedule = [];
    const lead = this.GLOBAL_LEAD_SEC;

    for (let ci = 0; ci < clusters.length; ci++) {
      const cluster = clusters[ci];
      const cStart = clusterStarts[ci];
      const cEnd =
        ci < clusterStarts.length - 1
          ? clusterStarts[ci + 1]
          : lineEnd;

      const clusterSpan = Math.max(0.06, cEnd - cStart);
      const isRapid = cluster.length > 1 && cluster.filter((w) => this._isGlue(w)).length >= cluster.length * 0.35;
      const rapidFactor = isRapid ? 0.42 : cluster.length > 1 ? 0.62 : 1;
      const usableSpan = clusterSpan * rapidFactor;

      const wordWeights = cluster.map((w) => this._wordWeight(w));
      const wTotal = wordWeights.reduce((a, b) => a + b, 0) || 1;
      let wAcc = 0;

      for (let wi = 0; wi < cluster.length; wi++) {
        const offset =
          cluster.length === 1
            ? 0
            : (wAcc / wTotal) * usableSpan * 0.92;
        wAcc += wordWeights[wi];

        const intraGap = isRapid ? 0.028 : cluster.length > 1 ? 0.045 : 0;
        const wordStart = cStart + offset - lead - (isRapid ? wi * 0.01 : 0);

        schedule.push({
          word: cluster[wi],
          start: Math.max(lineStart - 0.08, wordStart),
          end: cEnd,
          cluster: ci,
          rapid: isRapid,
        });
      }
    }

    for (let i = 0; i < schedule.length - 1; i++) {
      const nextStart = schedule[i + 1].start;
      schedule[i].end = Math.min(schedule[i].end, nextStart + 0.02);
    }

    return schedule;
  },

  getLineWindow(timed, lineIndex, songDuration) {
    const entry = timed[lineIndex];
    if (!entry) return { start: 0, end: 1 };

    const start = Math.max(0, entry.time - 0.12);
    const next = timed[lineIndex + 1];
    let end = next ? next.time - 0.05 : start + Math.max(2, songDuration * 0.03);

    const wordCount = entry.text.split(/\s+/).filter(Boolean).length;
    const clusterCount = this.buildClusters(entry.text.split(/\s+/).filter(Boolean)).length;
    const minSpan = Math.max(0.65, clusterCount * 0.28 + wordCount * 0.06);
    if (end - start < minSpan) end = start + minSpan;

    return { start, end };
  },

  getActiveWordIndex(schedule, t, lookahead = null) {
    if (!schedule.length) return 0;
    const ahead = t + (lookahead ?? this.LOOKAHEAD_SEC);
    let idx = 0;
    for (let i = 0; i < schedule.length; i++) {
      if (ahead >= schedule[i].start) idx = i;
      else break;
    }
    return idx;
  },

  getPhraseWindow(schedule, activeIdx, windowSize = 5) {
    if (!schedule.length) return { words: [], activeLocal: 0 };

    const active = schedule[activeIdx];
    const clusterId = active?.cluster;

    if (clusterId != null) {
      const clusterLen = schedule.filter((s) => s.cluster === clusterId).length;
      const pad = Math.max(1, Math.floor((windowSize - clusterLen) / 2));
      let start = Math.max(0, activeIdx - pad);
      let end = Math.min(schedule.length, start + windowSize);
      start = Math.max(0, end - windowSize);
      const slice = schedule.slice(start, end);
      return {
        words: slice,
        activeLocal: activeIdx - start,
        startIdx: start,
      };
    }

    const half = Math.floor(windowSize / 2);
    let start = Math.max(0, activeIdx - half);
    let end = Math.min(schedule.length, start + windowSize);
    start = Math.max(0, end - windowSize);
    const slice = schedule.slice(start, end);
    return {
      words: slice,
      activeLocal: activeIdx - start,
      startIdx: start,
    };
  },
};
