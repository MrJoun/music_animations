const LyricsRenderer = {
  _lineKey: "",
  _fadeT: 1,

  _fitPhraseFont(p, words, maxW, maxH) {
    const text = words.join(" ");
    for (let fs = 100; fs >= 42; fs -= 3) {
      p.textStyle(p.BOLD);
      p.textSize(fs);
      if (p.textWidth(text.toUpperCase()) <= maxW && fs <= maxH) {
        return fs;
      }
    }
    return 42;
  },

  _wrapRow(p, words, maxW, fontSize) {
    p.textStyle(p.BOLD);
    p.textSize(fontSize);
    const rows = [];
    let row = [];
    for (const word of words) {
      const trial = [...row, word];
      if (p.textWidth(trial.join(" ").toUpperCase()) > maxW && row.length) {
        rows.push(row);
        row = [word];
      } else {
        row = trial;
      }
    }
    if (row.length) rows.push(row);
    return rows;
  },

  _drawKaraokeWord(p, word, cx, y, ww, fontSize, theme, progress, state, fade) {
    p.textStyle(p.BOLD);
    p.textSize(fontSize);
    p.textAlign(p.CENTER, p.CENTER);

    const left = cx - ww / 2;
    const h = fontSize * 1.25;
    const top = y - h / 2;

    const dim = [155, 160, 170];
    p.fill(dim[0], dim[1], dim[2], 115 * fade);
    p.text(word, cx, y);

    let fillAmt = 0;
    if (state === "active") fillAmt = progress;
    else if (state === "gap" || state === "done" || state === "linger" || state === "past")
      fillAmt = 1;

    if (fillAmt <= 0.002) return;

    const bright =
      state === "gap" || state === "done"
        ? [235, 238, 245]
        : state === "linger" || state === "past"
          ? [235, 238, 245]
          : [theme.accent[0], theme.accent[1], theme.accent[2]];

    const alpha =
      state === "gap" || state === "done"
        ? 175 * fade
        : state === "linger"
          ? 255 * fade
          : state === "past"
            ? 175 * fade
            : 255 * fade;
    const ctx = p.drawingContext;

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, Math.max(1, ww * fillAmt), h);
    ctx.clip();
    p.fill(bright[0], bright[1], bright[2], alpha);
    p.text(word, cx, y);
    ctx.restore();
  },

  drawFullscreen(p, line, theme, opts = {}) {
    if (!line?.trim()) return;

    const w = p.width;
    const h = p.height;
    const schedule = opts.wordSchedule || [];
    const currentTime = opts.currentTime ?? 0;
    const liveVocalCtx = opts.liveVocalCtx || null;
    const cx = w / 2;
    const cy = h * 0.46;
    const pad = w * 0.07;
    const maxW = w - pad * 2;

    const lineKey = `${opts.lineIndex ?? 0}:${line}`;
    if (lineKey !== this._lineKey) {
      this._lineKey = lineKey;
      this._fadeT = 0.35;
    }
    this._fadeT = Math.min(1, this._fadeT + 0.06);

    const words = schedule.length
      ? schedule.map((s) => s.word)
      : line.split(/\s+/).filter(Boolean);

    const fontSize = this._fitPhraseFont(p, words, maxW, h * 0.4);
    const rows = this._wrapRow(p, words, maxW, fontSize);
    const lineH = fontSize * 1.36;
    const topY = cy - ((rows.length - 1) * lineH) / 2;
    const fade = this._fadeT;

    p.textFont("sans-serif");

    let globalIdx = 0;

    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      p.textStyle(p.BOLD);
      p.textSize(fontSize);
      const rowW = p.textWidth(row.join(" ").toUpperCase());
      let x = cx - rowW / 2;
      const y = topY + ri * lineH;

      for (let wi = 0; wi < row.length; wi++) {
        const word = row[wi].toUpperCase();
        const ww = p.textWidth(word + " ");
        const entry = schedule[globalIdx];
        const nextEntry = schedule[globalIdx + 1];

        const state = entry
          ? entry.whisper
            ? WhisperAligner.wordState(entry, currentTime, nextEntry)
            : LyricsOnsetMapper.wordState(entry, currentTime, nextEntry)
          : "future";
        const progress = entry
          ? entry.whisper
            ? WhisperAligner.wordProgress(entry, currentTime)
            : LyricsOnsetMapper.wordProgress(entry, currentTime, liveVocalCtx)
          : 0;

        this._drawKaraokeWord(
          p,
          word,
          x + ww / 2,
          y,
          ww,
          fontSize,
          theme,
          progress,
          state,
          fade
        );

        globalIdx++;
        x += ww;
      }
    }

    const nextLine = opts.nextLine;
    if (nextLine) {
      p.push();
      p.textAlign(p.CENTER, p.BOTTOM);
      p.textStyle(p.NORMAL);
      p.textSize(24);
      p.fill(255, 255, 255, 42 * fade);
      const preview =
        nextLine.length > 44 ? `${nextLine.slice(0, 42).trim()}…` : nextLine;
      p.text(preview.toUpperCase(), cx, h * 0.9);
      p.pop();
    }

    p.textStyle(p.NORMAL);
  },

  draw(p, line, theme, _energy, opts = {}) {
    this.drawFullscreen(p, line, theme, opts);
  },
};
