# Testing lyric–vocal alignment locally

## 0. Prereqs
- Python 3.10+ and `ffmpeg` on PATH.
- ~2 GB free disk for models (Demucs ~80 MB, MMS_FA ~1.2 GB, whisper ~150 MB) — downloaded once, cached.

```bash
cd tools
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cd ..
```

## 1. Align a real song
Default is whisper-anchored CTC forced alignment. Lyrics come from `--lyrics` or LRCLIB auto-fetch (uses the `Artist - Title.mp3` filename).

```bash
# Manual lyrics:
python tools/analyze_song.py "Yebba - Far Away.mp3" --lyrics yebba_far_away_lyrics.txt

# LRCLIB auto-fetch (any "Artist - Title.mp3"):
python tools/analyze_song.py "Hozier - Too Sweet (Official Lyric Video).mp3"
```
This writes `"<Artist - Title>.analysis/word_schedule.json"` next to the MP3.

## 2. Watch the karaoke (the real test)
```bash
python3 -m http.server 8000      # from the repo root
```
Open `http://localhost:8000/timing-lab.html` → **Choose Song** → pick the same MP3.
It auto-loads the `.analysis` pack. Tick **Show debug panel**, press **Play**, and watch
the word highlight track the vocals. The **Sync offset** slider nudges all words if your
audio output has latency (saved per track).

## 3. Inspect alignment objectively (no listening needed)
Word onsets (red) should sit on the vocal-energy rises (blue):
```bash
python tools/plot_alignment.py "Yebba - Far Away.analysis/stems/vocals.wav" \
       "Yebba - Far Away.analysis/word_schedule.json" --start 0 --end 22 --out check.png
```

## 4. Objective accuracy on synthetic ground truth
This is the only flow with an exact known answer (TTS vocals at known times). Use
`--anchor none` because robotic TTS is adversarial for the ASR anchor:
```bash
python tools/make_ground_truth.py yebba_far_away_lyrics.txt --out tools/fixtures/gt
python tools/analyze_song.py tools/fixtures/gt.mp3 --lyrics yebba_far_away_lyrics.txt --anchor none
python tools/eval_alignment.py tools/fixtures/gt.analysis/word_schedule.json \
       tools/fixtures/gt.ground_truth.json
```
Reports onset error in ms (positive = late, negative = early) and % of words within
50/80/100/150 ms.

## Tuning knobs
- `--align {forced,whisper,hybrid}` — default `forced`.
- `--anchor {whisper,none}` — `whisper` (default) windows each line for long songs; `none` is one global pass.
- `--lyric-lead <sec>` — shift all forced onsets earlier/later (default 0.02).
- `--model small.en` — better whisper anchors (slower) for the `whisper`/anchor path.
