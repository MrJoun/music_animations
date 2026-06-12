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
let loadedAudioFile = null;
let useCamera = true;
let showSparks = false;
let showStemFx = true;
let p5Instance = null;

const $ = (sel) => document.querySelector(sel);

function getTheme() {
  return THEMES[currentTheme] || THEMES.neon;
}

function getPreset() {
  return PRESETS[currentPreset] || PRESETS.director;
}

function getDrawOptions() {
  return {
    customText,
    energy,
    lyrics,
    showSparks,
    showStemFx,
    profile: songAnalyzer.getProfile(),
  };
}

function showAnalysisProgress(pct, msg) {
  const panel = $("#analysis-panel");
  panel.classList.remove("hidden");
  $("#analysis-bar").style.width = `${Math.round(pct * 100)}%`;
  $("#analysis-text").textContent = msg;
}

function showSongProfile(profile, opts = {}) {
  const panel = $("#analysis-panel");
  panel.classList.remove("hidden");
  $("#analysis-bar").style.width = "100%";
  const packNote = opts.fromPack ? " · Loaded local analysis pack" : opts.browserOnly ? " · Browser analysis" : "";
  $("#analysis-text").textContent = songAnalyzer.getMoodLabel() + packNote;
  const variance = profile.energyVariance != null
    ? ` · dynamics ${Math.round(profile.energyVariance * 100)}%`
    : "";
  const story = profile.storySummary ? ` · ${profile.storySummary}` : "";
  const sourceNote = opts.fromPack
    ? " · Demucs stems + faster-whisper"
    : "";
  $("#analysis-detail").textContent =
    `${profile.bpm} BPM · ${profile.dropCount} drops · ` +
    `${profile.sectionCount || profile.blueprint?.sectionCount || "?"} sections` +
    story +
    ` · motion ${profile.motionIntensity.toFixed(1)}×${variance}${sourceNote}`;
}

function rebuildSongBlueprint() {
  const profile = songAnalyzer.getProfile();
  if (!profile?.duration) return null;

  songBlueprint.build(
    profile,
    songAnalyzer.getAnalysisExtras(),
    trackTitle,
    lyrics
  );
  energy.applyProfile(profile);
  showSongProfile(profile);

  if (profile.blueprint?.suggestedTheme) {
    currentTheme = profile.blueprint.suggestedTheme;
    $("#theme-select").value = currentTheme;
  }

  if (currentPreset === "director" && p5Instance) {
    SceneDirector.setup(p5Instance, profile);
  }

  return profile;
}

function applyIntensityFromSlider() {
  const v = parseInt($("#intensity-slider").value, 10);
  $("#intensity-val").textContent = `${v}%`;
  songAnalyzer.setUserIntensity(v);
  const profile = songAnalyzer.getProfile();
  energy.applyProfile(profile);
  showSongProfile(profile);
  if (currentPreset === "director" && p5Instance) {
    SceneDirector.setup(p5Instance, profile);
  }
}

function hideAnalysisBusy() {
  $("#analysis-bar").style.width = "100%";
}

function syncLyricsContext(file = loadedAudioFile) {
  const profile = songAnalyzer.getProfile();
  const extras = songAnalyzer.getAnalysisExtras();
  const meta = LyricsFetcher.mergeMeta({}, file?.name || trackTitle);
  lyrics.setTrackCacheKey(LyricsCache.trackKey(meta, profile?.duration, file));
  lyrics.setSongContext(extras, profile);
  StemEnergy.apply(extras);
}

function updateLyricsSyncUI() {
  const slider = $("#lyrics-sync-slider");
  const sec = lyrics._userSyncOffsetSec || 0;
  slider.disabled = !lyrics.hasLines();
  $("#whisper-retranscribe-btn").disabled = !lyrics.hasLines();
  slider.value = String(Math.round(sec * 100));
  const sign = sec >= 0 ? "+" : "";
  $("#lyrics-sync-val").textContent = `${sign}${sec.toFixed(2)}s`;
}

function updateLyricsUI(result) {
  if (lyrics.hasLines()) {
    const count = lyrics.mode === "timed" ? lyrics.timed.length : lyrics.lines.length;
    const cacheNote = result?.fromPack
      ? " · local analysis pack"
      : result?.whisperCached
        ? " · Whisper (cached)"
        : result?.whisperRealigned
          ? " · Whisper (realigned)"
          : result?.whisper
            ? " · Whisper"
            : result?.fromCache
              ? " · cached"
              : "";
    const lagNote =
      lyrics._lagShiftSec > 0.02
        ? ` · auto −${lyrics._lagShiftSec.toFixed(2)}s`
        : "";
    $("#lyrics-name").textContent =
      `${count} lines · ${lyrics.getSourceLabel()}${lagNote}${cacheNote}`;
    updateLyricsSyncUI();
    return;
  }
  updateLyricsSyncUI();
  if (result?.meta?.title) {
    $("#lyrics-name").textContent =
      `No synced lyrics for "${result.meta.title}" — try Artist - Title.mp3 or load .lrc`;
  } else {
    $("#lyrics-name").textContent = "No synced lyrics found — load .lrc or plain .txt";
  }
}

async function runWhisperLyricSync(forceTranscribe = false) {
  if (!lyrics.hasLines()) return false;

  const waveform = songAnalyzer.getWaveform();
  if (!waveform && !forceTranscribe) {
    const tr = await WhisperCache.getTranscript(lyrics._trackCacheKey);
    if (!tr?.asrWords?.length) return false;
  }
  if (!waveform) return false;

  try {
    const result = await lyrics.alignWithWhisper(
      waveform,
      (pct, msg) => {
        showAnalysisProgress(Math.max(0, Math.min(1, pct)), msg);
      },
      { forceTranscribe }
    );
    if (result?.ok) {
      updateLyricsUI({
        ok: true,
        whisper: true,
        whisperCached: result.fromCache && !result.realigned,
        whisperRealigned: result.realigned,
      });
      return true;
    }
  } catch (err) {
    console.error("Whisper sync failed:", err);
    $("#lyrics-name").textContent +=
      " · Whisper failed — using vocal alignment";
  }
  return false;
}

async function autoFetchLyrics(file, profile) {
  if (!$("#auto-lyrics-toggle").checked || !file || !profile?.duration) {
    return null;
  }

  const cacheKey = LyricsCache.trackKey(
    LyricsFetcher.mergeMeta({}, file.name),
    profile.duration,
    file
  );
  const hasCachedLyrics = !!LyricsCache.getLyrics(cacheKey);
  showAnalysisProgress(
    0.92,
    hasCachedLyrics ? "Loading cached lyrics…" : "Finding synced lyrics…"
  );
  const result = await LyricsFetcher.autoLoad(
    file,
    profile.duration,
    songAnalyzer.getAnalysisExtras(),
    lyrics
  );

  if (result?.meta?.title && !trackTitle.includes(" - ")) {
    trackTitle = result.meta.artist && result.meta.artist !== "Unknown Artist"
      ? `${result.meta.artist} - ${result.meta.title}`
      : result.meta.title;
  }

  updateLyricsUI(result);
  return result;
}

async function analyzeAndPrepare(file) {
  setTrackLoaded(false);
  showAnalysisProgress(0, "Starting analysis…");

  let usedPack = false;
  let profile;

  const pack = await AnalysisPack.load(file.name);
  if (pack) {
    usedPack = true;
    showAnalysisProgress(0.05, "Loading local analysis pack…");
    await songAnalyzer.decodeForPlayback(audio, file, (pct, msg) => {
      showAnalysisProgress(0.05 + pct * 0.25, msg);
    });
    lyrics.clear();
    AnalysisPack.applyPack(pack, songAnalyzer);
    profile = songAnalyzer.getProfile();
    showAnalysisProgress(0.35, "Loaded local analysis pack");
  } else {
    profile = await songAnalyzer.analyze(audio, file, (pct, msg) => {
      showAnalysisProgress(pct, msg);
    });
    lyrics.clear();
  }

  energy.applyProfile(profile);
  const trackMeta = LyricsFetcher.mergeMeta({}, file.name);
  lyrics.setTrackCacheKey(LyricsCache.trackKey(trackMeta, profile.duration, file));

  const lyricResult = await autoFetchLyrics(file, profile);
  if (usedPack && AnalysisPack.applyWordSchedule(pack, lyrics)) {
    updateLyricsUI({ ok: true, fromPack: true });
  } else if (lyricResult) {
    updateLyricsUI(lyricResult);
  }

  songBlueprint.build(profile, songAnalyzer.getAnalysisExtras(), trackTitle, lyrics);
  energy.applyProfile(profile);
  if (lyricResult?.ok) {
    songBlueprint.build(profile, songAnalyzer.getAnalysisExtras(), trackTitle, lyrics);
  }
  syncLyricsContext();

  const hasPackSchedule = usedPack && lyrics._fromLocalPack;
  if ($("#whisper-sync-toggle").checked && lyrics.hasLines() && !hasPackSchedule) {
    await runWhisperLyricSync();
  }

  hideAnalysisBusy();

  const sliderVal = Math.round(songAnalyzer.getEffectiveIntensity() * 100);
  $("#intensity-slider").value = sliderVal;
  $("#intensity-val").textContent = `${sliderVal}%`;
  if (profile.blueprint?.suggestedTheme) {
    currentTheme = profile.blueprint.suggestedTheme;
    $("#theme-select").value = currentTheme;
  }

  showSongProfile(profile, { fromPack: usedPack, browserOnly: !usedPack });

  showSparks = profile.revival && sliderVal >= 60;
  $("#sparks-toggle").checked = showSparks;

  if (currentPreset === "director" && p5Instance) {
    SceneDirector.setup(p5Instance, profile);
  }

  setTrackLoaded(true);
  const packStatus = usedPack ? " (local analysis pack)" : "";
  setStatus(`${songAnalyzer.getMoodLabel()}${packStatus} — press Play`);
}

function syncFadeSettings() {
  fade.fadeInSec = parseFloat($("#fade-in").value) || 2;
  fade.fadeOutSec = parseFloat($("#fade-out").value) || 2;
}

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
      if (prof.revival || prof.subtleRevival) {
        RevivalEngine.drawOverlay(p, theme, revival);
      }

      if (showSparks) {
        PresetUtils.drawBeatSparks(p, audio, theme, energy);
      }

      if (showStemFx) {
        const prof = songAnalyzer.getProfile();
        StemVisualFX.draw(
          p,
          theme,
          energy,
          prof?.dominantStem,
          songAnalyzer.getEffectiveIntensity()
        );
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

p5Instance = new p5(sketch);

function switchPreset(name) {
  if (currentPreset === name) return;
  currentPreset = name;
  const preset = getPreset();
  if (preset.setup && p5Instance) {
    preset.setup(p5Instance);
  }
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
  btn.textContent = busy ? "Stop & Save MP4" : "Export MP4 for Instagram";
  $("#export-panel").classList.toggle("active", busy);
  $("#rec-dot").classList.toggle("hidden", !busy);
  if (!busy) $("#export-timer").textContent = "";
}

function setStatus(msg) {
  $("#export-status").textContent = msg;
}

$("#audio-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    setStatus("Loading track…");
    await audio.loadFile(file);
    const baseName = file.name.replace(/\.[^.]+$/, "");
    loadedAudioFile = file;
    trackTitle = baseName;
    $("#track-name").textContent = file.name;
    $("#lyrics-refetch-btn").disabled = false;
    $("#whisper-retranscribe-btn").disabled = false;
    if (!$("#custom-text").value.trim()) {
      customText = baseName.toUpperCase().slice(0, 80);
      $("#custom-text").value = customText;
    }
    updatePlayButton(false);
    updateTimeDisplay();
    await analyzeAndPrepare(file);
    switchPreset(currentPreset);
  } catch (err) {
    $("#track-name").textContent = "Failed to load audio";
    setStatus("Could not load audio file");
    console.error(err);
  }
});

$("#lyrics-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    await lyrics.loadFile(file);
    const profile = songAnalyzer.getProfile();
    if (lyrics.mode === "plain" && profile?.duration) {
      lyrics.alignToVocals(songAnalyzer.getAnalysisExtras(), profile.duration);
    }
    syncLyricsContext();
    if ($("#whisper-sync-toggle").checked && lyrics.hasLines()) {
      await runWhisperLyricSync();
    }
    updateLyricsUI({ ok: lyrics.hasLines() });
    const rebuilt = rebuildSongBlueprint();
    const sceneNote = rebuilt?.storySummary ? ` · ${rebuilt.storySummary}` : "";
    const syncNote = lyrics.mode === "timed" ? "time-synced" : "aligned";
    setStatus(`Lyrics loaded — ${syncNote}${sceneNote}`);
  } catch (err) {
    $("#lyrics-name").textContent = "Failed to load";
    console.error(err);
  }
});

$("#preset-grid").addEventListener("click", (e) => {
  const card = e.target.closest(".preset-card");
  if (!card) return;
  switchPreset(card.dataset.preset);
});

$("#theme-select").addEventListener("change", (e) => {
  currentTheme = e.target.value;
});

$("#custom-text").addEventListener("input", (e) => {
  customText = e.target.value.trim() || "FEEL THE BEAT";
});

$("#camera-toggle").addEventListener("change", (e) => {
  useCamera = e.target.checked;
});

$("#sparks-toggle").addEventListener("change", (e) => {
  showSparks = e.target.checked;
});

$("#stem-fx-toggle").addEventListener("change", (e) => {
  showStemFx = e.target.checked;
  if (!showStemFx) StemVisualFX.reset();
});

$("#intensity-slider").addEventListener("input", applyIntensityFromSlider);

$("#lyrics-sync-slider").addEventListener("input", (e) => {
  const sec = parseInt(e.target.value, 10) / 100;
  lyrics.setUserSyncOffset(sec);
  const sign = sec >= 0 ? "+" : "";
  $("#lyrics-sync-val").textContent = `${sign}${sec.toFixed(2)}s`;
});

$("#auto-lyrics-toggle").addEventListener("change", async () => {
  if (!$("#auto-lyrics-toggle").checked || !loadedAudioFile) return;
  const profile = songAnalyzer.getProfile();
  if (!profile?.duration) return;
  lyrics.clear();
  const result = await autoFetchLyrics(loadedAudioFile, profile);
  if (result?.ok) {
    syncLyricsContext();
    if ($("#whisper-sync-toggle").checked) {
      await runWhisperLyricSync();
    }
    rebuildSongBlueprint();
  }
});

$("#whisper-sync-toggle").addEventListener("change", async () => {
  if (!$("#whisper-sync-toggle").checked || !lyrics.hasLines()) return;
  await runWhisperLyricSync(false);
});

$("#clear-cache-btn").addEventListener("click", async () => {
  await AppCache.clearAll();
  lyrics.setUserSyncOffset(0);
  updateLyricsSyncUI();
  setStatus("All lyrics & Whisper cache cleared — reload song");
  $("#lyrics-name").textContent = "Cache cleared — load song to re-sync";
});

$("#whisper-retranscribe-btn").addEventListener("click", async () => {
  if (!loadedAudioFile || !lyrics.hasLines()) return;
  $("#whisper-sync-toggle").checked = true;
  setStatus("Re-transcribing with Whisper…");
  showAnalysisProgress(0, "Starting Whisper re-transcription…");
  await runWhisperLyricSync(true);
  hideAnalysisBusy();
  setStatus(`Whisper sync — ${lyrics.getSourceLabel()}`);
});

$("#lyrics-fullscreen-toggle").addEventListener("change", (e) => {
  lyrics.fullscreen = e.target.checked;
});

$("#lyrics-refetch-btn").addEventListener("click", async () => {
  if (!loadedAudioFile) return;
  const profile = songAnalyzer.getProfile();
  if (!profile?.duration) return;
  $("#auto-lyrics-toggle").checked = true;
  lyrics.clear();
  setStatus("Searching for synced lyrics…");
  const result = await autoFetchLyrics(loadedAudioFile, profile);
  if (result?.ok) {
    syncLyricsContext();
    if ($("#whisper-sync-toggle").checked) {
      await runWhisperLyricSync();
    }
    rebuildSongBlueprint();
    setStatus(`Synced lyrics — ${lyrics.getSourceLabel()}`);
  } else {
    setStatus("No synced lyrics found online");
  }
});

$("#fade-in, #fade-out").addEventListener("input", syncFadeSettings);

$("#play-btn").addEventListener("click", async () => {
  const playing = await audio.toggle();
  updatePlayButton(playing);
});

$("#export-btn").addEventListener("click", async () => {
  const canvas = document.querySelector("#canvas-container canvas");
  if (!canvas || exporter.isProcessing) return;

  if (!exporter.isRecording && !exporter.isFadingOut) {
    syncFadeSettings();
    if (!audio.isPlaying) {
      await audio.play();
      updatePlayButton(true);
    }
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

$("#seek-slider").addEventListener("input", (e) => {
  audio.seekTo(parseFloat(e.target.value));
  updateTimeDisplay();
});

exporter.onTimerUpdate = (time) => {
  $("#export-timer").textContent = time;
};

exporter.onStatus = setStatus;
exporter.onStop = () => setExportUI(false);

setInterval(() => {
  if (audio.hasTrack) updateTimeDisplay();
}, 500);

document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.target.matches("input, select, textarea")) {
    e.preventDefault();
    if (!audio.hasTrack) return;
    audio.toggle().then((playing) => updatePlayButton(playing));
  }
});

syncFadeSettings();
exporter.preload();
switchPreset(currentPreset);
setStatus("Load a song — we analyze it first");
