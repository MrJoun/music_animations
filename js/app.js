// Reel Studio app orchestrator — backend-driven (upload / URL → analysis pack → visuals).
const CANVAS_W = 1080;
const CANVAS_H = 1920;

const PRESETS = {
  director: SceneDirector,
  storm: StormPreset,
  generative: GenerativePreset,
  typography: TypographyPreset,
  face: FacePreset,
  objects3d: Objects3dPreset,
  aurora: AuroraPreset,
  fireworks: FireworksPreset,
  galaxy: GalaxyPreset,
  kaleidoscope: KaleidoscopePreset,
  tunnel: TunnelPreset,
  waveform: WaveformPreset,
  bars: BarsPreset,
  particles: ParticlesPreset,
  radial: RadialPreset,
};

const audio = new AudioEngine();
const energy = new EnergyAnalyzer(audio);
const songAnalyzer = new SongAnalyzer();
const lyrics = new LyricsManager();
const exporter = new ReelExporter();
const fade = new FadeController();

let currentPreset = "director";
let currentTheme = "neon";
let customText = "FEEL THE BEAT";
let trackTitle = "";
let useCamera = true;
let showSparks = false;
let showStemFx = true;
let p5Instance = null;
let pollTimer = null;

const $ = (sel) => document.querySelector(sel);
const getTheme = () => THEMES[currentTheme] || THEMES.neon;
const getPreset = () => PRESETS[currentPreset] || PRESETS.director;
const getDrawOptions = () => ({
  customText,
  energy,
  lyrics,
  showSparks,
  showStemFx,
  profile: songAnalyzer.getProfile(),
});

// ---------- Ingest (backend) ----------

async function startAnalysis(formData) {
  showIngestBusy(true);
  setJobStatus("queued", 0, "Uploading…");
  try {
    const res = await fetch("/api/analyze", { method: "POST", body: formData });
    if (!res.ok) throw new Error((await res.json()).detail || "request failed");
    const { jobId } = await res.json();
    pollJob(jobId);
  } catch (err) {
    setJobStatus("error", 0, `Failed: ${err.message}`);
    showIngestBusy(false);
  }
}

function pollJob(jobId) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      const job = await res.json();
      setJobStatus(job.status, job.progress || 0, job.message || job.step || "");
      if (job.status === "done") {
        clearInterval(pollTimer);
        await loadResult(job);
      } else if (job.status === "error") {
        clearInterval(pollTimer);
        showIngestBusy(false);
      }
    } catch (err) {
      /* transient; keep polling */
    }
  }, 700);
}

async function loadResult(job) {
  setJobStatus("done", 1, "Loading visuals…");
  try {
    const pack = await AnalysisPack.loadFromUrl(job.manifestUrl);
    if (!pack) throw new Error("could not load analysis pack");

    await audio.loadUrl(job.audioUrl);
    trackTitle = job.title || pack.manifest.sourceFile || "track";

    lyrics.clear();
    AnalysisPack.applyPack(pack, songAnalyzer);
    const profile = songAnalyzer.getProfile();

    if (pack.wordSchedule?.length) {
      lyrics.loadFromPack(pack.wordSchedule, pack.lyricLines);
    }
    lyrics.setTrackCacheKey(job.audioUrl);
    lyrics.setSongContext(songAnalyzer.getAnalysisExtras(), profile);
    StemEnergy.apply(songAnalyzer.getAnalysisExtras());

    songBlueprint.build(profile, songAnalyzer.getAnalysisExtras(), trackTitle, lyrics);
    energy.applyProfile(profile);

    applyAnimation(pack.manifest.animation, pack.manifest.insights, profile);
    customText = trackTitle.toUpperCase().slice(0, 80);
    if ($("#custom-text")) $("#custom-text").value = customText;

    renderInsights(pack.manifest, job);
    if (currentPreset === "director" && p5Instance) SceneDirector.setup(p5Instance, profile);
    switchPreset(currentPreset);
    setTrackLoaded(true);
    enterStage();
  } catch (err) {
    setJobStatus("error", 1, `Load failed: ${err.message}`);
    showIngestBusy(false);
  }
}

function applyAnimation(animation, insights, profile) {
  if (animation?.theme && THEMES[animation.theme]) {
    currentTheme = animation.theme;
    if ($("#theme-select")) $("#theme-select").value = currentTheme;
  }
  if (animation?.preset && PRESETS[animation.preset]) {
    currentPreset = animation.preset;
  }
  const intensity = Math.round(((animation?.intensity ?? songAnalyzer.getEffectiveIntensity()) || 0.5) * 100);
  if ($("#intensity-slider")) {
    $("#intensity-slider").value = intensity;
    $("#intensity-val").textContent = `${intensity}%`;
  }
  songAnalyzer.setUserIntensity(intensity);
  energy.applyProfile(songAnalyzer.getProfile());
  showSparks = (profile?.revival && intensity >= 60) || false;
  if ($("#sparks-toggle")) $("#sparks-toggle").checked = showSparks;
}

function renderInsights(manifest, job) {
  const ins = manifest.insights || {};
  const anim = manifest.animation || {};
  const prof = manifest.profile || {};
  const chips = [];
  const genres = (ins.genre || []).map((g) => g.tag).slice(0, 2);
  if (genres.length) chips.push(genres.join(" · "));
  if (ins.key && ins.key !== "?") chips.push(`${ins.key} ${ins.mode}`);
  if (manifest.bpm) chips.push(`${manifest.bpm} BPM`);
  if (anim.motion) chips.push(anim.motion);
  const moodTag = (ins.moodTags || [])[0]?.tag;
  if (moodTag) chips.push(moodTag.replace(" music", ""));
  $("#np-title").textContent = trackTitle;
  $("#np-chips").innerHTML = chips.map((c) => `<span class="chip">${c}</span>`).join("");
  $("#np-prompt").textContent = anim.prompt || "";
  const tags = (ins.instrumentTags || []).map((t) => t.tag).slice(0, 4);
  $("#np-tags").textContent = tags.length ? `Instruments: ${tags.join(", ")}` : "";
}

// ---------- UI plumbing ----------

function showIngestBusy(busy) {
  $("#analyze-btn").disabled = busy;
  $("#job-progress").classList.toggle("hidden", !busy);
  $("#ingest-inputs").classList.toggle("dim", busy);
}

function setJobStatus(status, frac, msg) {
  $("#job-bar").style.width = `${Math.round((frac || 0) * 100)}%`;
  $("#job-msg").textContent = msg || status;
  $("#job-bar").classList.toggle("error", status === "error");
}

function enterStage() {
  $("#ingest").classList.add("hidden");
  $("#stage").classList.remove("hidden");
  window.dispatchEvent(new Event("resize"));
}

function backToIngest() {
  audio.pause();
  updatePlayButton(false);
  $("#stage").classList.add("hidden");
  $("#ingest").classList.remove("hidden");
  showIngestBusy(false);
  setJobStatus("idle", 0, "");
}

function switchPreset(name) {
  currentPreset = name;
  const preset = getPreset();
  if (preset.setup && p5Instance) preset.setup(p5Instance);
  document.querySelectorAll(".preset-card").forEach((el) => {
    el.classList.toggle("active", el.dataset.preset === name);
  });
}

function updatePlayButton(playing) {
  $("#play-btn").textContent = playing ? "Pause" : "Play";
}
function setTrackLoaded(loaded) {
  $("#play-btn").disabled = !loaded;
  $("#export-btn").disabled = !loaded;
  $("#seek-slider").disabled = !loaded;
  $("#lyrics-sync-slider").disabled = !loaded || !lyrics.hasLines();
}
function updateTimeDisplay() {
  $("#time-current").textContent = audio.formatTime(audio.getCurrentTime());
  $("#time-duration").textContent = audio.formatTime(audio.getDuration());
  const dur = audio.getDuration();
  if (dur > 0) {
    $("#seek-slider").max = dur;
    $("#seek-slider").value = audio.getCurrentTime();
  }
}
function setExportUI(recording) {
  const btn = $("#export-btn");
  const busy = recording || exporter.isFadingOut;
  btn.classList.toggle("recording", busy);
  btn.textContent = busy ? "Stop & Save MP4" : "Export MP4";
  $("#rec-dot").classList.toggle("hidden", !busy);
  if (!busy) $("#export-timer").textContent = "";
}
function setStatus(msg) {
  $("#export-status").textContent = msg;
}
function syncFadeSettings() {
  fade.fadeInSec = parseFloat($("#fade-in").value) || 2;
  fade.fadeOutSec = parseFloat($("#fade-out").value) || 2;
}

// ---------- p5 sketch ----------

const sketch = (p) => {
  p.setup = () => {
    const canvas = p.createCanvas(CANVAS_W, CANVAS_H);
    canvas.parent("canvas-container");
    p.frameRate(30);
    PresetUtils.initSparks(p, 12);
    getPreset().setup(p);
  };

  p.draw = () => {
    energy.update();
    lyrics.update(audio);
    const preset = getPreset();
    const theme = getTheme();
    const options = getDrawOptions();

    if (currentPreset === "director") {
      preset.draw(p, audio, theme, options);
    } else {
      const revival = RevivalEngine.update(p, audio, energy, songAnalyzer.getProfile());
      p.push();
      if (useCamera) PresetUtils.applyCamera(p, audio, energy);
      preset.draw(p, audio, theme, { ...options, revival });
      p.pop();
      const prof = songAnalyzer.getProfile();
      if (prof.revival || prof.subtleRevival) RevivalEngine.drawOverlay(p, theme, revival);
      if (showSparks) PresetUtils.drawBeatSparks(p, audio, theme, energy);
      if (showStemFx) {
        StemVisualFX.draw(p, theme, energy, prof?.dominantStem, songAnalyzer.getEffectiveIntensity());
      }
      if (lyrics.hasLines() && currentPreset !== "typography") {
        lyrics.draw(p, theme, energy, audio);
      }
      PresetUtils.drawCinematicGrade(p, theme);
    }

    if (exporter.isRecording || exporter.isFadingOut) {
      fade.tick();
      fade.applyAudioGain(audio);
      fade.applyVisualFade(p);
      exporter.captureFrame();
    }
  };
};

// ---------- Event wiring ----------

function wireEvents() {
  const fileInput = $("#file-input");
  const drop = $("#drop-zone");
  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    if (e.dataTransfer.files[0]) { fileInput.files = e.dataTransfer.files; updateChosen(); }
  });
  fileInput.addEventListener("change", updateChosen);
  function updateChosen() {
    const f = fileInput.files[0];
    $("#drop-label").textContent = f ? f.name : "Drop an audio file or click to browse";
  }

  $("#analyze-btn").addEventListener("click", () => {
    const f = $("#file-input").files[0];
    const url = $("#url-input").value.trim();
    const fd = new FormData();
    if (f) fd.append("file", f);
    else if (url) fd.append("url", url);
    else { setJobStatus("error", 0, "Choose a file or paste a URL"); $("#job-progress").classList.remove("hidden"); return; }
    startAnalysis(fd);
  });
  $("#url-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#analyze-btn").click(); });

  $("#new-song-btn").addEventListener("click", backToIngest);
  $("#preset-grid").addEventListener("click", (e) => {
    const card = e.target.closest(".preset-card");
    if (card) switchPreset(card.dataset.preset);
  });
  $("#theme-select").addEventListener("change", (e) => { currentTheme = e.target.value; });
  $("#custom-text").addEventListener("input", (e) => { customText = e.target.value.trim() || "FEEL THE BEAT"; });
  $("#camera-toggle").addEventListener("change", (e) => { useCamera = e.target.checked; });
  $("#sparks-toggle").addEventListener("change", (e) => { showSparks = e.target.checked; });
  $("#stem-fx-toggle").addEventListener("change", (e) => {
    showStemFx = e.target.checked;
    if (!showStemFx) StemVisualFX.reset();
  });
  $("#intensity-slider").addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10);
    $("#intensity-val").textContent = `${v}%`;
    songAnalyzer.setUserIntensity(v);
    const profile = songAnalyzer.getProfile();
    energy.applyProfile(profile);
    if (currentPreset === "director" && p5Instance) SceneDirector.setup(p5Instance, profile);
  });
  $("#lyrics-sync-slider").addEventListener("input", (e) => {
    const sec = parseInt(e.target.value, 10) / 100;
    lyrics.setUserSyncOffset(sec);
    const sign = sec >= 0 ? "+" : "";
    $("#lyrics-sync-val").textContent = `${sign}${sec.toFixed(2)}s`;
  });
  $("#fade-in").addEventListener("input", syncFadeSettings);
  $("#fade-out").addEventListener("input", syncFadeSettings);
  $("#fade-in").addEventListener("input", (e) => { $("#fade-in-val").textContent = e.target.value + "s"; });
  $("#fade-out").addEventListener("input", (e) => { $("#fade-out-val").textContent = e.target.value + "s"; });

  $("#play-btn").addEventListener("click", async () => updatePlayButton(await audio.toggle()));
  $("#seek-slider").addEventListener("input", (e) => { audio.seekTo(parseFloat(e.target.value)); updateTimeDisplay(); });

  $("#export-btn").addEventListener("click", async () => {
    const canvas = document.querySelector("#canvas-container canvas");
    if (!canvas || exporter.isProcessing) return;
    if (!exporter.isRecording && !exporter.isFadingOut) {
      syncFadeSettings();
      if (!audio.isPlaying) { await audio.play(); updatePlayButton(true); }
      fade.startRecording();
      await exporter.start(canvas, audio);
      setExportUI(true);
    } else {
      setStatus("Fading out…");
      $("#export-btn").disabled = true;
      exporter.isRecording = false;
      exporter.isFadingOut = true;
      await fade.beginFadeOut();
      await exporter.stopAfterFade();
      fade.reset(audio);
      setExportUI(false);
      $("#export-btn").disabled = false;
    }
  });

  exporter.onTimerUpdate = (t) => { $("#export-timer").textContent = t; };
  exporter.onStatus = setStatus;
  exporter.onStop = () => setExportUI(false);

  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.target.matches("input, select, textarea")) {
      e.preventDefault();
      if (audio.hasTrack) audio.toggle().then(updatePlayButton);
    }
  });
}

setInterval(() => { if (audio.hasTrack) updateTimeDisplay(); }, 500);

document.addEventListener("DOMContentLoaded", () => {
  wireEvents();
  syncFadeSettings();
  exporter.preload();
  p5Instance = new p5(sketch);
});
