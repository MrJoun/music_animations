"""Fetch synced/plain lyrics from LRCLIB — port of js/lyrics-fetcher.js."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

API_BASE = "https://lrclib.net/api"
USER_AGENT = "ReelStudio/1.0 (music-visualizer)"


@dataclass
class TrackMeta:
    artist: str
    title: str
    album: str = ""


@dataclass
class LyricsResult:
    plain_lines: list[str]
    synced_lrc: str | None
    source: str
    meta: TrackMeta
    synced: bool


# YouTube/upload title noise to strip before a lyrics lookup.
_NOISE = re.compile(
    r"[\(\[]\s*[^\)\]]*\b("
    r"official|lyric[s]?|audio|video|visuali[sz]er|music\s*video|mv|hd|hq|4k|8k|"
    r"explicit|clean|remaster(?:ed)?|live|performance|version|edit|color\s*coded"
    r")\b[^\)\]]*[\)\]]",
    re.IGNORECASE,
)


def _clean_title(title: str) -> str:
    cleaned = _NOISE.sub("", title)
    cleaned = re.sub(r"\b(official|lyric[s]?\s*video|audio|visuali[sz]er)\b", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*[-–—|]\s*$", "", cleaned)  # trailing separators
    return re.sub(r"\s{2,}", " ", cleaned).strip(" -–—|") or title.strip()


def parse_filename(name: str) -> TrackMeta:
    base = re.sub(r"\.[^.]+$", "", name).strip()
    artist = ""
    title = base

    for pattern in (
        r"^(.+?)\s*[-–—]\s*(.+)$",
        r"^(.+?)\s+by\s+(.+)$",
        r"^(.+?)_\s*(.+)$",
    ):
        match = re.match(pattern, base, re.IGNORECASE)
        if match:
            artist = match.group(1).strip().replace("_", " ")
            title = match.group(2).strip().replace("_", " ")
            break

    return TrackMeta(artist=artist, title=_clean_title(title.replace("_", " ").strip()))


def read_id3_meta(audio_path: Path) -> TrackMeta | None:
    try:
        from mutagen.easyid3 import EasyID3  # type: ignore
    except ImportError:
        return None

    try:
        tags = EasyID3(str(audio_path))
    except Exception:
        return None

    artist = (tags.get("artist") or [""])[0].strip()
    title = (tags.get("title") or [""])[0].strip()
    album = (tags.get("album") or [""])[0].strip()
    if not artist and not title:
        return None
    return TrackMeta(artist=artist or "Unknown Artist", title=title or audio_path.stem, album=album)


def merge_meta(
    audio_path: Path,
    *,
    artist: str | None = None,
    title: str | None = None,
) -> TrackMeta:
    from_name = parse_filename(audio_path.name)
    id3 = read_id3_meta(audio_path)
    return TrackMeta(
        artist=artist or (id3.artist if id3 else "") or from_name.artist or "Unknown Artist",
        title=title or (id3.title if id3 else "") or from_name.title or audio_path.stem,
        album=(id3.album if id3 else "") or from_name.album,
    )


def _fetch_json(path: str) -> dict | list | None:
    url = f"{API_BASE}{path}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, TimeoutError):
        return None


def _norm_tokens(text: str) -> list[str]:
    return [
        w
        for w in re.sub(r"[^a-z0-9\s]", " ", (text or "").lower()).split()
        if len(w) > 1
    ]


def _title_score(track_name: str, query: str) -> float:
    a = _norm_tokens(track_name)
    b = _norm_tokens(query)
    if not b:
        return 0.0
    hits = sum(1 for w in b if any(t == w or w in t or t in w for t in a))
    return hits / len(b)


def _score_result(row: dict, duration: float, title_query: str) -> float:
    dur_diff = abs((row.get("duration") or 0) - duration) if duration > 0 else 99
    dur_score = max(0.0, 1.0 - dur_diff / 12.0) if duration > 0 else 0.3
    title_score = _title_score(row.get("trackName") or row.get("name") or "", title_query)
    sync_bonus = 0.35 if (row.get("syncedLyrics") or "").strip() else 0.0
    return title_score * 0.55 + dur_score * 0.35 + sync_bonus


def _pick_best_match(results: list[dict], duration: float, title_query: str) -> dict | None:
    if not results:
        return None
    with_sync = [r for r in results if (r.get("syncedLyrics") or "").strip()]
    pool = with_sync or results

    best = pool[0]
    best_score = -1.0
    for row in pool:
        score = _score_result(row, duration, title_query)
        if score > best_score:
            best_score = score
            best = row

    if duration > 0 and best_score < 0.45:
        for row in pool:
            if abs((row.get("duration") or 0) - duration) <= 2 and _title_score(
                row.get("trackName") or "", title_query
            ) >= 0.5:
                return row
        return None
    return best


def _plain_from_lrc(synced: str) -> list[str]:
    lrc_re = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]")
    lines: list[str] = []
    for raw in synced.splitlines():
        line = raw.strip()
        if not line:
            continue
        body = lrc_re.sub("", line).strip()
        if body:
            lines.append(body)
    return lines


def fetch_lyrics(meta: TrackMeta, duration_sec: float) -> LyricsResult | None:
    params = urllib.parse.urlencode(
        {
            "track_name": meta.title,
            "artist_name": meta.artist,
            "album_name": meta.album or "Unknown",
            "duration": str(round(duration_sec)),
        }
    )

    data = _fetch_json(f"/get-cached?{params}")
    if not isinstance(data, dict) or not (data.get("syncedLyrics") or "").strip():
        data = _fetch_json(f"/get?{params}")
    if isinstance(data, dict) and (data.get("syncedLyrics") or "").strip():
        synced = data["syncedLyrics"]
        plain = (data.get("plainLyrics") or "").strip()
        plain_lines = [l for l in plain.splitlines() if l.strip()] if plain else _plain_from_lrc(synced)
        return LyricsResult(
            plain_lines=plain_lines,
            synced_lrc=synced,
            source="lrclib",
            meta=TrackMeta(
                artist=data.get("artistName") or meta.artist,
                title=data.get("trackName") or meta.title,
                album=data.get("albumName") or meta.album,
            ),
            synced=True,
        )

    search_params = urllib.parse.urlencode({"track_name": meta.title})
    if meta.artist and meta.artist != "Unknown Artist":
        search_params = urllib.parse.urlencode(
            {"track_name": meta.title, "artist_name": meta.artist}
        )
    search = _fetch_json(f"/search?{search_params}")
    if not search:
        q = " ".join(x for x in (meta.title, meta.artist) if x and x != "Unknown Artist")
        search = _fetch_json(f"/search?{urllib.parse.urlencode({'q': q})}")

    if not isinstance(search, list):
        return None

    match = _pick_best_match(search, duration_sec, meta.title)
    if not match:
        return None

    synced = (match.get("syncedLyrics") or "").strip()
    plain = (match.get("plainLyrics") or "").strip()
    if synced:
        plain_lines = [l for l in plain.splitlines() if l.strip()] if plain else _plain_from_lrc(synced)
        return LyricsResult(
            plain_lines=plain_lines,
            synced_lrc=synced,
            source="lrclib",
            meta=TrackMeta(
                artist=match.get("artistName") or meta.artist,
                title=match.get("trackName") or meta.title,
                album=match.get("albumName") or meta.album,
            ),
            synced=True,
        )

    if plain:
        lines = [l.strip() for l in plain.splitlines() if l.strip()]
        if lines:
            return LyricsResult(
                plain_lines=lines,
                synced_lrc=None,
                source="lrclib-plain",
                meta=TrackMeta(
                    artist=match.get("artistName") or meta.artist,
                    title=match.get("trackName") or meta.title,
                    album=match.get("albumName") or meta.album,
                ),
                synced=False,
            )

    return None
