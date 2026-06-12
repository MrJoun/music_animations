# Reel Studio — Beat-Reactive Music Visuals

Cinematic, never-empty music visuals with **lyrics support**, **energy-synced scene cuts**, and **MP4 export** for Instagram.

## Quick Start

```bash
npx serve .
```

Open in **Chrome** → load song → **wait for analysis** → optional **lyrics .txt** → **Director** mode → Export MP4.

## Timing Lab (lyrics sync first)

Use **Timing Lab** when you want to nail karaoke timing before adding visuals. It is a lightweight page with **no p5, presets, stems, or export** — only audio transport and word-by-word highlight.

```bash
npx serve .
```

Open **`timing-lab.html`** (or click **Open Timing Lab** in the main app sidebar).

### Workflow

1. Run the Python pipeline once so the sidecar includes `word_schedule.json`:
   ```bash
   python tools/analyze_song.py "../Artist - Title.mp3" --device cpu
   ```
2. In Timing Lab, load the **same MP3 filename** — the app auto-fetches `Artist - Title.analysis/manifest.json` and `word_schedule.json`.
3. Play the track and adjust the **sync slider** (−1.5s … +0.5s). Offset is saved per track in `localStorage`.
4. Toggle **Show debug panel** to inspect `currentTime`, `syncTime`, `lineIndex`, active word timestamps, and `matched` flags.
5. When timing feels right, return to Reel Studio for visuals.

Without a local `.analysis` pack, Timing Lab can still fetch **LRCLIB** line text, but word karaoke requires `word_schedule.json` from `analyze_song.py`.

## Local analysis pack (Python — recommended for lyrics + stems)

For studio-grade **Demucs stems**, **faster-whisper on vocals**, and **cached karaoke timing**, run the offline pipeline once per song. Reel Studio auto-loads the sidecar when the MP3 is served from the same folder.

### One-time setup

```bash
cd tools
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

pip install -r requirements.txt
```

**GPU (optional, much faster):** install CUDA-enabled PyTorch first, then `pip install -r requirements.txt`. Use `--device cuda` below.

### Analyze a song

```bash
# Automatic — lyrics fetched from LRCLIB, no manual .txt needed:
python analyze_song.py "../Artist - Title.mp3" --device cpu

# Or run in background (prints output folder + log path):
python analyze_song.py "../Artist - Title.mp3" --background
# Windows shortcut:
# .\run_analysis.ps1 "..\Artist - Title.mp3" -Force

# Manual lyrics file still supported:
python analyze_song.py "../Artist - Title.mp3" --lyrics "../why_me_lyrics.txt" --device cpu
# optional: --artist "Name" --title "Song" --model small.en --device cuda --force
```

### Alignment strategy (`--align`)

Word timing is the heart of karaoke sync. Pick how lyric words are placed on the audio:

| `--align` | How it works | When to use |
|-----------|--------------|-------------|
| `forced` *(default)* | **CTC forced alignment** (torchaudio `MMS_FA`) of the *known* lyrics to the Demucs vocal stem, then a bounded vocal-energy onset snap. Does **not** depend on ASR recognizing the words. | Best word-level accuracy; recommended whenever you have the lyrics. |
| `whisper` | faster-whisper ASR word timestamps + DTW lyric match + envelope refinement (original pipeline). | No lyrics, or as a fallback. |
| `hybrid` | Forced alignment, automatically falling back to `whisper` on failure. | Mixed catalogs. |

```bash
python analyze_song.py "../Artist - Title.mp3" --lyrics "../lyrics.txt" --align forced
# nudge all forced onsets a touch earlier/later (seconds): --lyric-lead 0.0
```

**Anchoring (`--anchor`, default `auto`).** A single global forced-alignment pass drifts
on long songs (repeated choruses, fast rap, fades). Each lyric line is instead aligned
within its own short audio window. The window comes from:
- `auto` (default): **human LRC line timestamps** when the lyrics are synced (`.lrc` or
  LRCLIB) — the most accurate anchor — otherwise whisper.
- `lrc`: force LRC line times.
- `whisper`: faster-whisper + a global monotonic, repeat-safe word match (for plain lyrics).
- `none`: one global pass (best for short, clean clips like the validation fixture).

Words are then refined onto the actual vocal-energy onsets inside each window, so line
*and* word timing track the singer. `tools/eval_lrc_lines.py` reports real-audio
line-onset error against the human LRC timestamps.

Forced alignment writes the same `word_schedule.json` shape the browser already renders, so no UI change is needed. The chosen method is recorded in `manifest.json` under `lyrics.alignMethod`.

### Validating alignment accuracy

`tools/` ships a reproducible accuracy harness. It synthesizes a vocal track from any
lyrics file with **exact known word times**, runs the pipeline, and measures onset error
(positive = late, negative = early):

```bash
python tools/make_ground_truth.py yebba_far_away_lyrics.txt --out tools/fixtures/yebba
# synthetic TTS is adversarial for ASR, so isolate the aligner with a global pass:
python tools/analyze_song.py tools/fixtures/yebba.mp3 --lyrics yebba_far_away_lyrics.txt \
       --anchor none
python tools/eval_alignment.py tools/fixtures/yebba.analysis/word_schedule.json \
       tools/fixtures/yebba.ground_truth.json
```

On this fixture (375 words) forced alignment reaches **~17 ms median** onset error
(>90% of words within 80 ms). Add `--hard` to `make_ground_truth.py` for a realistic
stress test (reverb on the vocals + a louder, denser backing mix that bleeds through
Demucs); it still holds **~19 ms median, 87% within 80 ms, 97% within 150 ms** — well
under the ~80–100 ms perceptual threshold, so highlights are neither delayed nor ahead.
On real recordings (e.g. the included `Yebba - Far Away.mp3`) use the default
`--anchor whisper`; verify visually with
`tools/plot_alignment.py "Yebba - Far Away.analysis/stems/vocals.wav" \
"Yebba - Far Away.analysis/word_schedule.json" --start 0 --end 22 --out check.png`.

For sharper word boundaries on the `whisper` path, try `--model small.en` (slower than `base.en`, better syllable edges).

This writes a sidecar folder next to the MP3:

```
Artist - Title.analysis/
  manifest.json       # v1 schema — profile, paths, lyrics metadata
  stems/              # vocals, drums, bass, other (.wav)
  envelopes.json      # real stem energy curves (25 ms hop)
  word_schedule.json  # karaoke word timings (if --lyrics)
  transcript.json     # raw Whisper words on vocal stem
```

**Word timing:** after Whisper + lyric alignment, the pipeline refines each word using the **vocal stem RMS envelope** — extending ends to capture sung tails, tightening onsets, and placing repeated words (e.g. chorus *away*) on envelope peaks instead of even gaps. Inter-word **silence gaps** (~50 ms) are preserved so karaoke highlight rests between words. Sidecars include `"scheduleRefined": true` in `manifest.json`. Re-run with `--force` to regenerate schedules after pipeline updates.

**Caching:** if `manifest.json` already exists, the script skips work unless you pass `--force`.

### Use in the app

```bash
cd ..
npx serve .
```

Load the **same MP3 filename** in Reel Studio. The app fetches `Artist - Title.analysis/manifest.json` and shows **Loaded local analysis pack** in the analysis panel. Browser stem guessing and in-browser Whisper are skipped when the pack includes lyrics + `word_schedule.json`.

| | Browser analysis | Local `.analysis` pack |
|--|------------------|-------------------------|
| Stems | Frequency guesses | **Demucs htdemucs** |
| Word sync | Whisper on full mix | **faster-whisper on vocals** |
| Karaoke cache | IndexedDB | **JSON sidecar** (shareable) |

## Song analysis (automatic)

When you load a track, the app **scans the full song** before you play or record:

- **BPM** and beat grid (synced hits, not guesswork)
- **Drop detection** (scene cuts align to drops)
- **Mood profile** — uses BPM, dynamics variance, transients, and drops together (not just BPM)
- **Melodic · R&B soul** — smooth, low-variance tracks stay calm (no beat revivals)
- **Visual intensity slider** — auto-set from analysis; drag to override (0% chill → 100% chaos)
- **Personalized timing** — scene length, transition speed, motion intensity

**Dubstep / high-energy EDM** → ~6s scenes with **beat revivals** (glitch, flash, punch inside each scene), snap transitions at section boundaries.

**Chill tracks** → longer sections, slow aurora/galaxy flow.

## Song-aware Director (blueprint)

**Director** mode builds a **unique timeline** per song instead of rotating the same presets:

- **Sections** — intro, verse, build, chorus, drop (from RMS envelope + drop times)
- **Lyrics & title** — keyword themes (love, night, party, soul, etc.) pick matching visuals
- **Instruments** — vocal presence → typography/face; bass/beats → tunnel/storm; electronic → generative
- **No immediate repeats** — each section gets a different preset; typography scenes use lyric lines
- **Reload lyrics** after the track loads to rebuild the blueprint without re-analyzing audio

The analysis panel shows a story summary like `vocals + bass · night · 6 unique scenes`.

## Lyrics (auto-sync)

**MP3 files rarely contain lyrics inside the audio itself** — unless they were embedded as ID3 tags when the file was created. Reel Studio tries these sources in order:

1. **ID3 SYLT / USLT** — synced or plain lyrics embedded in the MP3
2. **[LRCLIB](https://lrclib.net)** — free online database of **timestamped LRC** lyrics (needs internet; works best with `Artist - Title.mp3` filenames)
3. **Vocal alignment** — plain text (from ID3 or your `.txt`) is mapped to vocal energy from the song scan (better than beat-guessing, but not word-perfect)

Enable **Auto-sync lyrics** when loading a track. Use **Search synced lyrics again** if the first match failed.

### Manual .txt / .lrc

**LRC** (best — exact timestamps):
```
[00:12.00]First line of the chorus
[00:18.50]Second line here
```

**Plain text** — one line per row; auto-aligned to vocals after song analysis:

```
Feeling the rhythm tonight
Colors exploding in my mind
```

Tip: rename files to `Artist - Song Title.mp3` for better LRCLIB matches.

## Visuals

| Preset | Description |
|--------|-------------|
| **Director** | Auto-morphs scenes; cut speed matches song energy/tempo |
| **Object Storm** | 50+ flashing objects; bursts on beat/drop |
| **Generative AI** | Organic morphing blobs + neural lines + shards |
| Typography, Face, 3D Objects, Fireworks, Tunnel, Galaxy… |

### Reactivity by frequency band

| Band | Drives |
|------|--------|
| Bass | Size pulses, beat detection, drops |
| Mids | Fly speed, motion intensity |
| Vocals | Lyric advance, text shard spawns |
| Treble | Spin speed, sparkle flashes |

### Never empty

- Beat sparks overlay (toggle in sidebar)
- Director forces scene change on **drops**
- High energy = faster cuts (3–4 sec); chill = slower (6–8 sec)

## Export

- **MP4 only** for Instagram (not WebM)
- **Fade in / fade out** sliders — applies to both audio and video
- Click Stop → fade out plays → then MP4 downloads

Wait for **"MP4 saved — ready for Instagram!"**

## Tips

1. Load lyrics + song for synced words on screen
2. Use **Object Storm** or **Generative AI** for maximum chaos
3. **Director** for variety without editing
4. Set 2s fade in/out for polished Reels
5. Record the drop/chorus — scene cuts accelerate automatically

## License

Personal use. Ensure rights to music and lyrics you share.
