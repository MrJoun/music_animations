const WhisperAligner = {
  MODEL_ID: "Xenova/whisper-base.en",
  MODEL_REVISION: "output_attentions",
  TARGET_RATE: 16000,
  SCHEDULE_VERSION: 9,
  TIMESTAMP_PAD_SEC: 0.08,
  MIN_WORD_SEC: 0.09,
  INTER_WORD_GAP_SEC: 0.05,
  FILL_RATIO: 0.94,
  MIN_MATCH_SCORE: 1,

  _pipeline: null,
  _loading: null,

  _norm(word) {
    return (word || "").toLowerCase().replace(/[^a-z0-9']/g, "");
  },

  _tokenize(text) {
    return (text || "")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter(Boolean);
  },

  _syllableWeight(word) {
    return LyricsTiming._syllableWeight(word);
  },

  _smoothstep(x) {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
  },

  async _loadPipeline(onProgress) {
    if (this._pipeline) return this._pipeline;
    if (this._loading) return this._loading;

    this._loading = (async () => {
      onProgress?.(0.05, "Loading Whisper model (~75MB, better word timing)…");
      const { pipeline, env } = await import(
        "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2"
      );
      env.allowLocalModels = false;
      env.useBrowserCache = true;

      try {
        const pipe = await pipeline("automatic-speech-recognition", this.MODEL_ID, {
          revision: this.MODEL_REVISION,
          progress_callback: (info) => {
            if (info.status === "progress" && info.progress != null) {
              onProgress?.(0.05 + info.progress * 0.25, "Downloading Whisper model…");
            }
          },
        });
        this._pipeline = pipe;
      } catch (err) {
        console.warn("Whisper base unavailable, falling back to tiny:", err);
        const pipe = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", {
          revision: this.MODEL_REVISION,
        });
        this._pipeline = pipe;
      }

      onProgress?.(0.32, "Whisper model ready");
      return this._pipeline;
    })();

    try {
      return await this._loading;
    } finally {
      this._loading = null;
    }
  },

  resampleTo16k(samples, sampleRate) {
    if (sampleRate === this.TARGET_RATE) {
      return samples instanceof Float32Array ? samples : new Float32Array(samples);
    }
    const outLen = Math.max(1, Math.floor((samples.length / sampleRate) * this.TARGET_RATE));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const src = (i / this.TARGET_RATE) * sampleRate;
      const i0 = Math.floor(src);
      const i1 = Math.min(samples.length - 1, i0 + 1);
      const f = src - i0;
      out[i] = samples[i0] * (1 - f) + samples[i1] * f;
    }
    return out;
  },

  _matchScore(a, b) {
    const na = this._norm(a);
    const nb = this._norm(b);
    if (!na || !nb) return -2;
    if (na === nb) return 4;
    if (na.includes(nb) || nb.includes(na)) return 2;
    if (na.length >= 3 && nb.length >= 3 && na.slice(0, 3) === nb.slice(0, 3)) return 1;
    return -1;
  },

  _alignLineTokens(lineTokens, asrPool) {
    const n = lineTokens.length;
    const m = asrPool.length;
    if (!n) return [];
    if (!m) return lineTokens.map((_, i) => ({ lyricIdx: i, asrIdx: -1 }));

    const GAP = -3;
    const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(-1e9));
    const bt = Array.from({ length: n + 1 }, () => new Int8Array(m + 1).fill(0));

    dp[0][0] = 0;
    for (let i = 1; i <= n; i++) {
      dp[i][0] = dp[i - 1][0] + GAP;
      bt[i][0] = 1;
    }
    for (let j = 1; j <= m; j++) {
      dp[0][j] = dp[0][j - 1] + GAP;
      bt[0][j] = 2;
    }

    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const ms = this._matchScore(lineTokens[i - 1], asrPool[j - 1].word);
        const match =
          ms >= this.MIN_MATCH_SCORE ? dp[i - 1][j - 1] + ms : -1e9;
        const gapL = dp[i - 1][j] + GAP;
        const gapW = dp[i][j - 1] + GAP;
        let best = match;
        let dir = 0;
        if (gapL > best) {
          best = gapL;
          dir = 1;
        }
        if (gapW > best) {
          best = gapW;
          dir = 2;
        }
        dp[i][j] = best;
        bt[i][j] = dir;
      }
    }

    const pairs = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      const dir = bt[i][j];
      if (dir === 0 && i > 0 && j > 0) {
        pairs.push({ lyricIdx: i - 1, asrIdx: j - 1 });
        i--;
        j--;
      } else if (dir === 1 && i > 0) {
        pairs.push({ lyricIdx: i - 1, asrIdx: -1 });
        i--;
      } else if (dir === 2 && j > 0) {
        j--;
      } else if (i > 0) {
        pairs.push({ lyricIdx: i - 1, asrIdx: -1 });
        i--;
      } else {
        j--;
      }
    }
    pairs.reverse();
    return this._sanitizePairs(pairs, lineTokens, asrPool);
  },

  _sanitizePairs(pairs, lineTokens, asrPool) {
    const usedAsr = new Set();
    const out = [];
    for (const pair of pairs) {
      const idx = pair.asrIdx;
      if (idx < 0) {
        out.push(pair);
        continue;
      }
      if (usedAsr.has(idx)) {
        out.push({ lyricIdx: pair.lyricIdx, asrIdx: -1 });
        continue;
      }
      const score = this._matchScore(lineTokens[pair.lyricIdx], asrPool[idx].word);
      if (score < this.MIN_MATCH_SCORE) {
        out.push({ lyricIdx: pair.lyricIdx, asrIdx: -1 });
        continue;
      }
      usedAsr.add(idx);
      out.push(pair);
    }
    return out;
  },

  _normLine(text) {
    return this._tokenize(text)
      .map((w) => this._norm(w))
      .join(" ");
  },

  _isRepeatLine(timedLines, lineIndex) {
    if (lineIndex <= 0) return false;
    const prev = this._normLine(timedLines[lineIndex - 1]?.text || "");
    const curr = this._normLine(timedLines[lineIndex]?.text || "");
    return !!(prev && prev === curr);
  },

  _estimateLineDuration(text) {
    const tokens = this._tokenize(text);
    if (!tokens.length) return 4;
    return tokens.reduce((sum, w) => sum + this._syllableWeight(w), 0) * 0.18 + 0.5;
  },

  _lineWindow(timedLines, lineIndex, asrWords, asrCursor, prevLineEnd = 0) {
    const line = timedLines[lineIndex];
    const hint = line?.time ?? 0;
    const nextHint = timedLines[lineIndex + 1]?.time;
    const estDur = this._estimateLineDuration(line?.text || "");

    let lo = Math.max(0, hint - 2.5, prevLineEnd - 0.25);
    if (this._isRepeatLine(timedLines, lineIndex)) {
      lo = Math.max(lo, prevLineEnd + 0.05);
    }

    let hi =
      nextHint != null
        ? nextHint + 2.5
        : hint + Math.max(estDur + 4, 12);
    hi = Math.min(hi, Math.max(hint, prevLineEnd) + estDur + 8);

    const pool = [];
    for (let i = asrCursor; i < asrWords.length; i++) {
      const w = asrWords[i];
      if (w.start >= lo && w.start < hi) pool.push({ ...w, globalIdx: i });
      if (w.start >= hi && pool.length > 6) break;
    }

    if (pool.length < 2) {
      for (let i = asrCursor; i < asrWords.length && pool.length < 60; i++) {
        const w = asrWords[i];
        if (w.start >= lo - 1.5 && w.start < hi + 4) {
          if (!pool.some((p) => p.globalIdx === i)) pool.push({ ...w, globalIdx: i });
        }
      }
    }

    return pool;
  },

  _spreadByWeight(count, weights, t0, t1) {
    const gap = this.INTER_WORD_GAP_SEC;
    const totalGap = gap * Math.max(0, count - 1);
    const usable = Math.max(this.MIN_WORD_SEC * count, t1 - t0 - totalGap);
    const slots = [];
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let cum = 0;
    let cursor = t0;
    for (let i = 0; i < count; i++) {
      const a = cum / total;
      cum += weights[i];
      const b = cum / total;
      const segStart = t0 + a * usable;
      const segEnd = t0 + b * usable;
      const dur = Math.max(this.MIN_WORD_SEC, segEnd - segStart);
      slots.push({
        start: cursor,
        end: cursor + dur,
      });
      cursor += dur + (i < count - 1 ? gap : 0);
    }
    return slots;
  },

  _enforceWordGaps(words) {
    for (let i = 0; i < words.length; i++) {
      if (i > 0) {
        const minStart = words[i - 1].end + this.INTER_WORD_GAP_SEC;
        if (words[i].start < minStart) words[i].start = minStart;
      }
      if (words[i].end <= words[i].start) {
        words[i].end = words[i].start + this.MIN_WORD_SEC;
      }
      if (i + 1 < words.length) {
        const maxEnd = words[i + 1].start - this.INTER_WORD_GAP_SEC;
        if (words[i].end > maxEnd) {
          words[i].end = Math.max(words[i].start + this.MIN_WORD_SEC, maxEnd);
        }
      }
    }
  },

  _interpolateDirectTimes(tokens, pairs, asrPool, floorTime) {
    const n = tokens.length;
    const times = Array(n).fill(null);
    const weights = tokens.map((w) => Math.max(0.75, this._syllableWeight(w)));

    for (const p of pairs) {
      if (p.asrIdx >= 0) {
        const a = asrPool[p.asrIdx];
        times[p.lyricIdx] = {
          start: a.start + this.TIMESTAMP_PAD_SEC,
          end: a.end + this.TIMESTAMP_PAD_SEC,
        };
      }
    }

    const anchors = [];
    for (let i = 0; i < n; i++) {
      if (times[i]) anchors.push(i);
    }

    if (!anchors.length) {
      const span = weights.reduce((a, b) => a + b, 0) * 0.16;
      const slots = this._spreadByWeight(n, weights, floorTime, floorTime + span);
      return slots.map((s) => ({
        start: s.start,
        end: Math.max(s.start + this.MIN_WORD_SEC, s.end),
      }));
    }

    const first = anchors[0];
    if (first > 0) {
      const t1 = times[first].start - 0.03;
      const t0 = Math.max(floorTime, t1 - weights.slice(0, first).reduce((a, b) => a + b, 0) * 0.15);
      const slots = this._spreadByWeight(first, weights.slice(0, first), t0, t1);
      for (let i = 0; i < first; i++) times[i] = slots[i];
    }

    for (let a = 0; a < anchors.length - 1; a++) {
      const i0 = anchors[a];
      const i1 = anchors[a + 1];
      const gapCount = i1 - i0 - 1;
      if (gapCount <= 0) continue;

      const t0 = times[i0].end + this.INTER_WORD_GAP_SEC;
      const t1 = times[i1].start - this.INTER_WORD_GAP_SEC;
      const gapWeights = weights.slice(i0 + 1, i1);
      const slots = this._spreadByWeight(gapCount, gapWeights, t0, Math.max(t0 + 0.08, t1));
      for (let k = 0; k < gapCount; k++) {
        times[i0 + 1 + k] = slots[k];
      }
    }

    const last = anchors[anchors.length - 1];
    if (last < n - 1) {
      const t0 = times[last].end + this.INTER_WORD_GAP_SEC;
      const tail = weights.slice(last + 1);
      const span = tail.reduce((a, b) => a + b, 0) * 0.16;
      const slots = this._spreadByWeight(n - last - 1, tail, t0, t0 + span);
      for (let k = 0; k < slots.length; k++) {
        times[last + 1 + k] = slots[k];
      }
    }

    return times.map((t) => {
      if (!t) return { start: floorTime, end: floorTime + this.MIN_WORD_SEC };
      return {
        start: t.start,
        end: Math.max(t.start + this.MIN_WORD_SEC, t.end),
      };
    });
  },

  _buildLineSchedule(lineIndex, tokens, pairs, asrPool, prevLineEnd) {
    const floorTime = Math.max(0, (prevLineEnd ?? 0) + 0.06);
    const wordTimes = this._interpolateDirectTimes(tokens, pairs, asrPool, floorTime);

    const words = tokens.map((word, wi) => {
      const wt = wordTimes[wi];
      return {
        lineIndex,
        word,
        wordIndex: wi,
        isLineEnd: wi === tokens.length - 1,
        start: wt.start,
        end: wt.end,
        fillEnd: wt.start + (wt.end - wt.start) * this.FILL_RATIO,
        matched: pairs.some((p) => p.lyricIdx === wi && p.asrIdx >= 0),
        whisper: true,
        direct: true,
      };
    });

    this._enforceWordGaps(words);
    for (const word of words) {
      word.fillEnd = word.start + (word.end - word.start) * this.FILL_RATIO;
    }

    const lastAsrGlobal = pairs.filter((p) => p.asrIdx >= 0).pop();
    return {
      words,
      lastAsrGlobal: lastAsrGlobal ? asrPool[lastAsrGlobal.asrIdx].globalIdx : -1,
    };
  },

  buildSchedule(timedLines, asrWords, _songDuration = 0) {
    const schedule = [];
    let asrCursor = 0;
    let prevLineEnd = 0;

    for (let li = 0; li < timedLines.length; li++) {
      const tokens = this._tokenize(timedLines[li].text);
      if (!tokens.length) continue;

      const pool = this._lineWindow(timedLines, li, asrWords, asrCursor, prevLineEnd);
      const pairs = this._alignLineTokens(tokens, pool);
      const { words, lastAsrGlobal } = this._buildLineSchedule(li, tokens, pairs, pool, prevLineEnd);

      schedule.push(...words);
      prevLineEnd = words[words.length - 1].end;

      if (lastAsrGlobal >= 0) {
        asrCursor = Math.max(asrCursor, lastAsrGlobal + 1);
      }
    }

    return schedule;
  },

  parseWhisperChunks(output) {
    const chunks = output?.chunks || output?.[0]?.chunks || [];
    const words = [];
    for (const c of chunks) {
      const text = (c.text || "").trim();
      if (!text) continue;
      const ts = c.timestamp;
      if (!ts || ts.length < 2) continue;
      const start = ts[0];
      let end = ts[1];
      if (end - start > 2) end = start + 0.7;
      words.push({
        word: text,
        start,
        end: Math.max(end, start + 0.05),
      });
    }

    for (let i = 0; i < words.length - 1; i++) {
      if (words[i].end > words[i + 1].start - 0.01) {
        words[i].end = Math.max(words[i].start + 0.05, words[i + 1].start - 0.01);
      }
    }

    return words;
  },

  async transcribe(waveform, onProgress) {
    const pipe = await this._loadPipeline(onProgress);
    const audio = this.resampleTo16k(waveform.samples, waveform.sampleRate);
    const duration = audio.length / this.TARGET_RATE;

    onProgress?.(0.35, "Whisper transcribing with word timestamps…");

    const useSingleChunk = duration <= 240;
    const chunkLen = useSingleChunk ? Math.ceil(duration) + 2 : 30;
    const strideLen = useSingleChunk ? Math.min(5, Math.floor(duration / 4)) : 5;

    const output = await pipe(audio, {
      return_timestamps: "word",
      chunk_length_s: chunkLen,
      stride_length_s: strideLen,
      language: "english",
      task: "transcribe",
    });

    onProgress?.(0.88, "Placing lyrics on singer timestamps…");
    return this.parseWhisperChunks(output);
  },

  async alignFromTranscript(asrWords, timedLines, onProgress, songDuration) {
    if (!timedLines?.length || !asrWords?.length) {
      return { schedule: [], asrWords: asrWords || [] };
    }
    onProgress?.(0.92, "Aligning lyrics to singer timestamps…");
    const schedule = this.buildSchedule(timedLines, asrWords, songDuration);
    onProgress?.(1, "Whisper sync ready");
    return { schedule, asrWords };
  },

  async alignSong(waveform, timedLines, onProgress, asrWords = null, songDuration = 0) {
    if (!timedLines?.length) return { schedule: [], asrWords: [] };

    let words = asrWords;
    if (!words?.length) {
      words = await this.transcribe(waveform, onProgress);
    }
    if (!words.length) {
      throw new Error("Whisper could not detect words in this track");
    }

    const schedule = this.buildSchedule(timedLines, words, songDuration);
    onProgress?.(1, "Whisper word sync complete");
    return { schedule, asrWords: words };
  },

  wordProgress(entry, t) {
    if (!entry) return 0;
    if (t < entry.start) return 0;
    if (t >= entry.fillEnd) return 1;
    const span = Math.max(this.MIN_WORD_SEC, entry.fillEnd - entry.start);
    return this._smoothstep((t - entry.start) / span);
  },

  wordState(entry, t, nextEntry = null) {
    if (!entry) return "pending";
    if (t < entry.start) return "pending";
    if (t >= entry.start && t <= entry.end) return "active";
    if (nextEntry && t > entry.end && t < nextEntry.start) return "gap";
    return "done";
  },

  lineStartTime(schedule, lineIndex) {
    const words = schedule.filter((w) => w.lineIndex === lineIndex);
    if (!words.length) return null;
    return words[0].start;
  },
};
