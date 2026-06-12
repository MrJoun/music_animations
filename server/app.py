"""Reel Studio backend.

GUI-driven: the browser POSTs an uploaded audio file or a URL (YouTube/SoundCloud/direct);
the server downloads/normalizes it, runs the analysis pipeline (Demucs stems +
forced-aligned lyrics + tempo/key/energy/mood/genre insights + animation blueprint) with
live progress, and serves the resulting pack + audio + the static frontend.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

from pipeline.run import run_pipeline  # noqa: E402

DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)

app = FastAPI(title="Reel Studio")
_executor = ThreadPoolExecutor(max_workers=1)  # serialize CPU-heavy Demucs jobs
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_tagger = None
_tagger_ready = threading.Event()


@app.on_event("startup")
def _load_tagger() -> None:
    def _bg():
        global _tagger
        try:
            from pipeline.insights import load_tagger
            _tagger = load_tagger()
        except Exception:
            _tagger = None
        _tagger_ready.set()
    threading.Thread(target=_bg, daemon=True).start()


def _set(job_id: str, **kw) -> None:
    with _jobs_lock:
        _jobs.setdefault(job_id, {}).update(kw)


def _get(job_id: str) -> dict | None:
    with _jobs_lock:
        j = _jobs.get(job_id)
        return dict(j) if j else None


AUDIO_EXTS = {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".opus", ".aac"}


def _download_url(url: str, dest_dir: Path, job_id: str) -> Path:
    _set(job_id, step="download", progress=0.02, message="Downloading audio…")
    out_tmpl = str(dest_dir / "audio.%(ext)s")
    cmd = [
        sys.executable, "-m", "yt_dlp", "--no-playlist", "-x",
        "--audio-format", "mp3", "--audio-quality", "0",
        "-o", out_tmpl, url,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    mp3 = dest_dir / "audio.mp3"
    if mp3.exists():
        return mp3
    # Some extractors keep the original container; pick whatever audio landed.
    for f in dest_dir.iterdir():
        if f.suffix.lower() in AUDIO_EXTS:
            return f
    raise RuntimeError(
        "Download failed. " + (proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else "")
    )


def _run_job(job_id: str, source: dict) -> None:
    job_dir = DATA / job_id
    try:
        job_dir.mkdir(parents=True, exist_ok=True)
        if source["kind"] == "url":
            audio_path = _download_url(source["url"], job_dir, job_id)
        else:
            audio_path = job_dir / source["filename"]
        title = audio_path.stem

        def progress(step, frac, msg):
            _set(job_id, step=step, progress=round(float(frac), 3), message=msg)

        _set(job_id, status="running")
        # Wait briefly for the tagger to finish loading on first boot.
        _tagger_ready.wait(timeout=30)
        manifest = run_pipeline(
            audio_path, out_dir=job_dir / "analysis", tagger=_tagger, progress=progress,
        )
        _set(
            job_id, status="done", progress=1.0, step="done", message="Ready",
            title=title,
            audioUrl=f"/data/{job_id}/{audio_path.name}",
            manifestUrl=f"/data/{job_id}/analysis/manifest.json",
            baseUrl=f"/data/{job_id}/analysis/",
            animation=manifest.get("animation"),
            insights=manifest.get("insights"),
            bpm=manifest.get("bpm"),
        )
    except Exception as err:  # noqa: BLE001
        _set(job_id, status="error", message=str(err), error=str(err))
        (job_dir / "error.log").write_text(traceback.format_exc(), encoding="utf-8")


@app.post("/api/analyze")
async def analyze(file: UploadFile | None = File(default=None), url: str | None = Form(default=None)):
    job_id = uuid.uuid4().hex[:12]
    job_dir = DATA / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    if file is not None and file.filename:
        ext = Path(file.filename).suffix.lower() or ".mp3"
        if ext not in AUDIO_EXTS:
            raise HTTPException(400, f"Unsupported audio type: {ext}")
        safe = f"audio{ext}"
        with (job_dir / safe).open("wb") as out:
            shutil.copyfileobj(file.file, out)
        source = {"kind": "file", "filename": safe}
    elif url:
        source = {"kind": "url", "url": url.strip()}
    else:
        raise HTTPException(400, "Provide an audio file or a url.")

    _set(job_id, status="queued", step="queued", progress=0.0, message="Queued…")
    _executor.submit(_run_job, job_id, source)
    return {"jobId": job_id}


@app.get("/api/jobs/{job_id}")
async def job_status(job_id: str):
    job = _get(job_id)
    if not job:
        raise HTTPException(404, "No such job")
    return JSONResponse(job)


@app.get("/api/health")
async def health():
    return {"ok": True, "taggerReady": _tagger_ready.is_set(), "taggerLoaded": _tagger is not None}


# Serve per-song packs/audio and the static frontend.
app.mount("/data", StaticFiles(directory=str(DATA)), name="data")
app.mount("/", StaticFiles(directory=str(ROOT), html=True), name="static")
