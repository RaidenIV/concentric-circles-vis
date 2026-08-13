/**
 * loader.js — audio file loading, decoding and offline analysis.
 */
import { analyzeAudioBuffer, computeWaveformPeaks } from "./analysis.js";
import { audio, elements, state } from "./core.js";
import { applyVolume, pausePlayback, setPlayButtonState } from "./playback.js";
import { resetSimulation } from "./render.js";
import { clamp } from "./utils.js";

let decodeContext = null;

function formatFileSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "Unavailable";
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function getFileTypeLabel(file) {
  if (file.type) return file.type;
  const extension = file.name.includes(".") ? file.name.split(".").pop() : "";
  return extension ? extension.toUpperCase() : "Unavailable";
}

function updateFileInformation(file, decoded = null, decodeStatus = "Reading") {
  state.fileInfo = file ? {
    name: file.name,
    type: getFileTypeLabel(file),
    size: file.size,
    duration: decoded?.duration ?? null,
    sampleRate: decoded?.sampleRate ?? null,
    channels: decoded?.numberOfChannels ?? null,
    decodeStatus
  } : null;

  elements.fileInfoName.textContent = file?.name || "No file loaded";
  elements.fileInfoName.title = file?.name || "No file loaded";
  elements.fileInfoType.textContent = file ? getFileTypeLabel(file) : "Unavailable";
  elements.fileInfoSize.textContent = file ? formatFileSize(file.size) : "Unavailable";
  elements.fileInfoDuration.textContent = decoded ? formatDuration(decoded.duration) : "Unavailable";
  elements.fileInfoSampleRate.textContent = decoded ? `${(decoded.sampleRate / 1000).toFixed(decoded.sampleRate % 1000 === 0 ? 0 : 1)} kHz` : "Unavailable";
  elements.fileInfoChannels.textContent = decoded
    ? decoded.numberOfChannels === 1 ? "Mono" : decoded.numberOfChannels === 2 ? "Stereo" : `${decoded.numberOfChannels} channels`
    : "Unavailable";
  elements.fileInfoDecodeStatus.textContent = decodeStatus;
}

function setFileStatus(message, stateName = "idle") {
  elements.audioFileStatus.textContent = message;
  elements.audioFileStatus.dataset.state = stateName;
}

function getDecodeContext() {
  if (!decodeContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    decodeContext = new AudioContextClass();
  }
  return decodeContext;
}

function setLoadProgress(fraction, stage) {
  const percent = clamp(Math.round(fraction * 100), 0, 100);
  elements.audioLoadWrap.hidden = false;
  elements.audioLoadProgress.value = percent;
  elements.audioLoadPercent.textContent = `${percent}%`;
  if (stage) elements.audioLoadStage.textContent = stage;
}

function hideLoadProgress() {
  elements.audioLoadWrap.hidden = true;
  elements.audioLoadProgress.value = 0;
  elements.audioLoadPercent.textContent = "0%";
}

export function setAnalysisProgress(fraction) {
  const percent = clamp(Math.round(fraction * 100), 0, 100);
  elements.fftLoadWrap.hidden = false;
  elements.fftLoadProgress.value = percent;
  elements.fftLoadPercent.textContent = `${percent}%`;
}

export function hideAnalysisProgress() {
  elements.fftLoadWrap.hidden = true;
  elements.fftLoadProgress.value = 0;
  elements.fftLoadPercent.textContent = "0%";
}

function readFileWithProgress(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable) {
        setLoadProgress((event.loaded / event.total) * 0.5, "Reading file…");
      }
    };
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the audio file."));
    reader.readAsArrayBuffer(file);
  });
}

function setLoopControlsEnabled(enabled) {
  elements.loopButton.disabled = !enabled;
  elements.loopStartHandle.disabled = !enabled;
  elements.loopEndHandle.disabled = !enabled;
  elements.loopBpmValue.disabled = !enabled;
  elements.loopBarsValue.disabled = !enabled;
  elements.loopSnap.disabled = !enabled;
  elements.detectBpm.disabled = !enabled;
  elements.fullTrackLoop.disabled = !enabled;
  elements.loopRegion.classList.toggle("is-disabled", !enabled);
}

/** Re-run analysis against the already-decoded buffer (FFT size / smoothing). */
export async function reanalyzeCurrentBuffer() {
  if (!state.decodedAudioBuffer || state.isAnalyzing) return;

  state.isAnalyzing = true;
  state.analysisReady = false;
  const version = ++state.analysisVersion;

  try {
    const analysis = await analyzeAudioBuffer(
      state.decodedAudioBuffer,
      state.fftSize,
      state.smoothing,
      setAnalysisProgress
    );
    if (version !== state.analysisVersion) return;
    state.analysis = analysis;
    state.analysisReady = true;
  } catch (error) {
    console.error("Analysis failed", error);
  } finally {
    if (version === state.analysisVersion) {
      state.isAnalyzing = false;
      hideAnalysisProgress();
    }
  }
}

export async function loadAudioFile(file, onReady = () => {}) {
  if (!file) return;

  pausePlayback();
  updateFileInformation(file, null, "Reading");
  setFileStatus("Reading audio file…", "active");
  elements.loadButton.classList.add("is-busy");
  elements.loadButtonText.textContent = "Loading…";
  state.analysisReady = false;
  state.analysis = null;
  state.decodedAudioBuffer = null;
  state.hasAudio = false;
  state.loopReady = false;
  state.loopWaveformPeaks = null;
  state.magnitudes.fill(0);
  state.lowFreqMagnitude = 0;
  elements.audioName.textContent = file.name;
  elements.progressContainer.style.display = "none";
  setLoopControlsEnabled(false);
  elements.playButton.disabled = true;

  try {
    setLoadProgress(0.02, "Reading file…");
    const arrayBuffer = await readFileWithProgress(file);

    setLoadProgress(0.6, "Decoding audio…");
    updateFileInformation(file, null, "Decoding");
    setFileStatus("Decoding audio…", "active");
    const decoded = await getDecodeContext().decodeAudioData(
      arrayBuffer.slice(0)
    );

    if (state.objectUrl) {
      // Detach the previous Blob before revoking it. Revoking a URL that is
      // still assigned to the media element can leave some browsers in a
      // stale/error state when a replacement track is loaded immediately.
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = null;
    }
    state.objectUrl = URL.createObjectURL(file);

    // Attach media listeners before assigning/loading the Blob URL. Local
    // files can resolve metadata extremely quickly; registering afterward can
    // miss loadedmetadata and leave the loader waiting until its timeout.
    await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        window.clearTimeout(timeout);
        audio.removeEventListener("loadedmetadata", handleReady);
        audio.removeEventListener("canplay", handleReady);
        audio.removeEventListener("error", handleError);
      };
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const handleReady = () => finish(resolve);
      const handleError = () => finish(() => reject(new Error("Failed to load audio")));
      const timeout = window.setTimeout(() => {
        // decodeAudioData has already validated the selected file. If the media
        // element has metadata by the timeout boundary, accept it instead of
        // incorrectly reporting a load failure.
        if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
          finish(resolve);
        } else {
          finish(() => reject(new Error("Audio load timeout")));
        }
      }, 15000);

      audio.addEventListener("loadedmetadata", handleReady);
      audio.addEventListener("canplay", handleReady);
      audio.addEventListener("error", handleError);
      audio.preload = "metadata";
      audio.src = state.objectUrl;
      audio.load();

      // Covers cached/immediately-resolved Blob URLs where readyState advances
      // synchronously during load().
      if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) handleReady();
    });

    setLoadProgress(1, "Analyzing…");
    hideLoadProgress();

    state.decodedAudioBuffer = decoded;
    state.fileName = file.name;
    updateFileInformation(file, decoded, "Analyzing");
    setFileStatus("Building analysis data…", "active");
    state.hasAudio = true;
    state.loopWaveformPeaks = computeWaveformPeaks(decoded);
    state.loopStart = 0;
    state.loopEnd = decoded.duration;
    state.loopReady = true;

    elements.audioName.textContent = file.name;
    elements.progressContainer.style.display = "block";
    elements.playButton.disabled = false;
    setLoopControlsEnabled(true);
    setPlayButtonState();
    applyVolume();
    resetSimulation();

    await reanalyzeCurrentBuffer();
    updateFileInformation(file, decoded, state.analysisReady ? "Ready" : "Analysis failed");
    setFileStatus(state.analysisReady ? "Audio ready." : "Audio decoded, but analysis failed.", state.analysisReady ? "done" : "error");
    onReady();
  } catch (error) {
    console.error("Failed to load audio:", error);
    elements.audioName.textContent = "Load failed – try again";
    updateFileInformation(file, null, "Failed");
    setFileStatus("Audio could not be loaded or decoded. Try another supported audio file.", "error");
    hideLoadProgress();
    hideAnalysisProgress();
  } finally {
    elements.loadButton.classList.remove("is-busy");
    elements.loadButtonText.textContent = "Load Audio File";
  }
}
