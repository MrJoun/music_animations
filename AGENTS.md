# AGENTS.md

## Cursor Cloud specific instructions

Reel Studio is a **fully client-side static web app** (vanilla HTML/CSS/JS, p5.js loaded from a CDN). There is **no build step, no package manager, no lockfile, no backend, and no database** — state lives in browser IndexedDB/localStorage. There are also **no automated tests and no lint config** in the repo, so there is nothing to "build", "lint", or "test" beyond running the app in a browser.

### Running the app (dev)
- Serve the repo root over HTTP and open in a browser. It must be served over HTTP — opening `index.html` via `file://` breaks `fetch` of analysis sidecars and CORS.
  - `python3 -m http.server 8000` (zero install, always available) — then open `http://localhost:8000/index.html`.
  - `npx serve .` also works (see `README.md`), defaults to port 3000.
- Two entry pages: `index.html` (main studio) and `timing-lab.html` (lyrics word-sync only).
- p5.js is loaded from `cdnjs.cloudflare.com`, so the app needs internet access to render. LRCLIB lyrics lookup (`lrclib.net`) is optional.

### Testing / demoing end-to-end (gotchas)
- The core flow needs a **local audio file**, but `*.mp3` is gitignored and none ship in the repo. Generate a throwaway test track with `ffmpeg` (e.g. `ffmpeg -f lavfi -i "sine=frequency=55:duration=16" -af "tremolo=f=2:d=1,volume=4" "Test Artist - Hello World.mp3"`). The file picker is a native OS dialog; paste the absolute path into the filename field.
- The default **Director** preset is intentionally slow/subtle on low-energy ("chill") tracks and can look almost static in a recording. To clearly demonstrate animation, pick a high-motion preset (**Typography**, **Object Storm**, or **Generative AI**) and/or raise the **Visual intensity** slider.
- Console 404s for `favicon.ico`, manifest icons, or unrelated extension/telemetry endpoints are benign and unrelated to the app.

### Optional Python analysis pipeline (`tools/`)
- Only needed when working on Demucs stems / faster-whisper lyric timing — **not** required for the web app. Deps are heavy ML packages (`torch==2.6.0`, `demucs`, `faster-whisper`); install on demand in a venv: `cd tools && python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`. Do not add these to startup/update automation.
