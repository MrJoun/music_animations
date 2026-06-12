const Id3LyricsReader = {
  _readSynchsafe(bytes, offset) {
    return (
      ((bytes[offset] & 0x7f) << 21) |
      ((bytes[offset + 1] & 0x7f) << 14) |
      ((bytes[offset + 2] & 0x7f) << 7) |
      (bytes[offset + 3] & 0x7f)
    );
  },

  _readInt32(bytes, offset) {
    return (
      (bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]
    ) >>> 0;
  },

  _decodeText(bytes, encoding, start, end) {
    const slice = bytes.subarray(start, end);
    if (encoding === 0) return new TextDecoder("iso-8859-1").decode(slice);
    if (encoding === 3) return new TextDecoder("utf-8").decode(slice);
    if (encoding === 1 || encoding === 2) {
      const bom = encoding === 1 ? slice : slice;
      let off = 0;
      if (bom.length >= 2 && bom[0] === 0xff && bom[1] === 0xfe) off = 2;
      const len = bom.length - off;
      const buf = new ArrayBuffer(len);
      const view = new Uint8Array(buf);
      for (let i = 0; i < len; i++) view[i] = bom[off + i];
      return new TextDecoder("utf-16le").decode(buf);
    }
    return new TextDecoder("utf-8").decode(slice);
  },

  _nullIndex(bytes, start, encoding) {
    if (encoding === 1 || encoding === 2) {
      for (let i = start; i < bytes.length - 1; i += 2) {
        if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
      }
      return bytes.length;
    }
    for (let i = start; i < bytes.length; i++) {
      if (bytes[i] === 0) return i;
    }
    return bytes.length;
  },

  _parseUslt(data) {
    if (data.length < 5) return null;
    const enc = data[0];
    const descEnd = this._nullIndex(data, 4, enc);
    const text = this._decodeText(data, enc, descEnd + (enc === 1 || enc === 2 ? 2 : 1), data.length);
    return text.trim() || null;
  },

  _parseSylt(data) {
    if (data.length < 6) return null;
    const enc = data[0];
    let pos = 4;
    pos = this._nullIndex(data, pos, enc);
    pos += enc === 1 || enc === 2 ? 2 : 1;

    const lines = [];
    while (pos < data.length - 5) {
      const textStart = pos;
      const textEnd = this._nullIndex(data, pos, enc);
      const text = this._decodeText(data, enc, textStart, textEnd).trim();
      pos = textEnd + (enc === 1 || enc === 2 ? 2 : 1);
      if (pos + 4 > data.length) break;
      const ts = this._readInt32(data, pos);
      pos += 4;
      if (text) lines.push({ time: ts / 1000, text });
    }
    return lines.length ? lines : null;
  },

  async readFromFile(file) {
    const buf = await file.arrayBuffer();
    return this.readFromBuffer(new Uint8Array(buf));
  },

  readFromBuffer(bytes) {
    const out = {
      title: null,
      artist: null,
      album: null,
      plainLyrics: null,
      syncedLyrics: null,
      syncedLines: null,
    };

    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
      return out;
    }

    const major = bytes[3];
    const tagSize = this._readSynchsafe(bytes, 6);
    let offset = 10;
    const tagEnd = Math.min(bytes.length, 10 + tagSize);

    while (offset + 10 <= tagEnd) {
      const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
      if (id === "\0\0\0\0" || id.charCodeAt(0) === 0) break;

      let frameSize;
      if (major === 4) {
        frameSize = this._readSynchsafe(bytes, offset + 4);
      } else {
        frameSize = this._readInt32(bytes, offset + 4);
      }

      const dataStart = offset + 10;
      const dataEnd = dataStart + frameSize;
      if (dataEnd > bytes.length) break;

      const data = bytes.subarray(dataStart, dataEnd);

      if (id === "TIT2" && data.length > 1) {
        out.title = this._decodeText(data, data[0], 1, data.length).trim();
      } else if (id === "TPE1" && data.length > 1) {
        out.artist = this._decodeText(data, data[0], 1, data.length).trim();
      } else if (id === "TALB" && data.length > 1) {
        out.album = this._decodeText(data, data[0], 1, data.length).trim();
      } else if (id === "USLT") {
        const text = this._parseUslt(data);
        if (text) out.plainLyrics = text;
      } else if (id === "SYLT") {
        const lines = this._parseSylt(data);
        if (lines) {
          out.syncedLines = lines;
          out.syncedLyrics = lines
            .map((l) => `[${LyricsManager.formatLrcTime(l.time)}]${l.text}`)
            .join("\n");
        }
      }

      offset = dataEnd;
    }

    return out;
  },
};
