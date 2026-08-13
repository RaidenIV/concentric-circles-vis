/**
 * app.js — entry point. Binds every control, wires the transport and runs the
 * preview render loop.
 */
import { sampleAnalysisAtTime } from "./analysis.js";
import { defaults } from "./config.js";
import { audio, elements, state } from "./core.js";
import {
  bindRange,
  bindSelect,
  bindToggle,
  buildColormapGrid,
  enhanceValueEditors,
  initializeCollapsibleSections,
  initializeColormapDisclosure,
  initializePanelToggle,
  setControlValue
} from "./controls.js";
import {
  exportJson,
  exportPng,
  exportVideo,
  requestVideoExportCancel,
  updateExportEstimate,
  updateVideoExportFormatUi
} from "./export.js";
import { loadAudioFile, reanalyzeCurrentBuffer } from "./loader.js";
import { renderHudPreview } from "./hud.js";
import {
  beginHistory,
  cancelHistory,
  commitHistory,
  redoSettings,
  syncHistoryButtons,
  undoSettings
} from "./history.js";
import {
  applyQualityPreset,
  updateAutoQuality,
  updateQualityStatus
} from "./quality.js";
import { applySettingsSnapshot, parseSettingsFile } from "./settings.js";
import {
  applyLoopBars,
  drawLoopWaveform,
  galaxyLoopController,
  initializeLoopEditor,
  runBpmDetection,
  setFullTrackLoop,
  updateLoopPlayhead,
  updateLoopSelectionUi
} from "./loop.js";
import {
  applyVolume,
  currentPlayheadTime,
  enforceLoopRange,
  seekTo,
  setPlayButtonState,
  togglePlayback,
  updateLoopButtonState,
  updateTransportUi
} from "./playback.js";
import { renderFrame, resetSimulation } from "./render.js";
import { initializeSectionResets, resetAll } from "./reset.js";
import { clamp } from "./utils.js";
import { fitViewport } from "./viewport.js";

/* ---------------------------------------------------------------------------
   Control wiring
--------------------------------------------------------------------------- */
let reanalysisTimer = null;

function scheduleReanalysis() {
  window.clearTimeout(reanalysisTimer);
  reanalysisTimer = window.setTimeout(() => {
    reanalyzeCurrentBuffer();
  }, 250);
}

function bindControls() {
  // Playback
  bindRange(elements.volume, elements.volumeValue, "volume", applyVolume);
  bindToggle(elements.muteToggle, "muted", applyVolume);

  // Audio resolution
  bindSelect(elements.fftSize, "fftSize", scheduleReanalysis, Number);
  bindRange(elements.smoothing, elements.smoothingValue, "smoothing", scheduleReanalysis);
  bindSelect(elements.amplitudeMode, "amplitudeMode");
  bindRange(elements.inputGain, elements.inputGainValue, "inputGain");
  bindRange(elements.noiseFloor, elements.noiseFloorValue, "noiseFloor");
  bindRange(elements.dynamicRange, elements.dynamicRangeValue, "dynamicRange");

  // Viewport
  bindSelect(elements.viewportPreset, "viewportPreset", () => {
    fitViewport();
    updateExportEstimate();
  });

  // Camera
  bindSelect(elements.cameraPreset, "cameraPreset");
  bindRange(elements.cameraSpeed, elements.cameraSpeedValue, "cameraSpeed");
  bindRange(elements.cameraAmount, elements.cameraAmountValue, "cameraAmount");
  bindRange(elements.cameraDistance, elements.cameraDistanceValue, "cameraDistance");
  bindRange(elements.cameraElevation, elements.cameraElevationValue, "cameraElevation");
  bindRange(elements.cameraAzimuth, elements.cameraAzimuthValue, "cameraAzimuth");
  elements.centerVisualization?.addEventListener("click", () => {
    beginHistory("Center visualization");
    setControlValue("cameraElevation", 0);
    setControlValue("cameraAzimuth", 0);
    state.cameraFollowAzimuth = 0;
    commitHistory("Center visualization");
  });

  // Mouse camera controls — drag to orbit the current preset and wheel to
  // change camera distance. These update the existing camera controls rather
  // than introducing a second camera state, so preview/export stay identical.
  let cameraDrag = null;
  let cameraWheelCommitTimer = null;
  const normalizeAzimuth = (value) => {
    const wrapped = ((value + 180) % 360 + 360) % 360 - 180;
    return Math.round(wrapped);
  };

  elements.canvas?.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || state.isExportingPng || state.isExportingVideo) return;
    beginHistory("Adjust camera with mouse");
    cameraDrag = {
      x: event.clientX,
      y: event.clientY,
      azimuth: state.cameraAzimuth,
      elevation: state.cameraElevation
    };
    elements.canvas.classList.add("is-camera-dragging");
    event.preventDefault();
  });

  document.addEventListener("mousemove", (event) => {
    if (!cameraDrag) return;
    const dx = event.clientX - cameraDrag.x;
    const dy = event.clientY - cameraDrag.y;
    setControlValue("cameraAzimuth", normalizeAzimuth(cameraDrag.azimuth + dx * 0.25));
    setControlValue("cameraElevation", clamp(cameraDrag.elevation - dy * 0.2, -89, 89));
  });

  const finishCameraDrag = () => {
    if (!cameraDrag) return;
    cameraDrag = null;
    elements.canvas?.classList.remove("is-camera-dragging");
    commitHistory("Adjust camera with mouse");
  };
  document.addEventListener("mouseup", finishCameraDrag);
  window.addEventListener("blur", finishCameraDrag);

  elements.canvas?.addEventListener("wheel", (event) => {
    if (state.isExportingPng || state.isExportingVideo) return;
    event.preventDefault();
    beginHistory("Adjust camera distance with mouse");
    const wheelSteps = Math.max(0.5, Math.min(4, Math.abs(event.deltaY) / 100 || 1));
    const direction = Math.sign(event.deltaY || 1);
    setControlValue(
      "cameraDistance",
      clamp(state.cameraDistance + direction * wheelSteps * 2, 20, 120)
    );
    window.clearTimeout(cameraWheelCommitTimer);
    cameraWheelCommitTimer = window.setTimeout(() => {
      commitHistory("Adjust camera distance with mouse");
    }, 180);
  }, { passive: false });

  // HUD
  bindToggle(elements.hudEnabled, "hudEnabled", renderHudPreview);
  bindRange(elements.hudOpacity, elements.hudOpacityValue, "hudOpacity", renderHudPreview);
  bindRange(elements.hudScale, elements.hudScaleValue, "hudScale", renderHudPreview);

  // Performance
  bindSelect(elements.qualityPreset, "qualityPreset", applyQualityPreset);

  // Concentric sphere
  bindRange(elements.reactivity, elements.reactivityValue, "reactivity");
  bindRange(elements.ringCount, elements.ringCountValue, "ringCount");
  bindRange(elements.sphereRadius, elements.sphereRadiusValue, "sphereRadius");
  bindRange(elements.sphereSize, elements.sphereSizeValue, "sphereSize");
  bindRange(elements.ringOpacity, elements.ringOpacityValue, "ringOpacity");
  bindRange(elements.rotationSpeed, elements.rotationSpeedValue, "rotationSpeed");
  bindRange(elements.rotationAmount, elements.rotationAmountValue, "rotationAmount");

  // Bloom
  bindRange(elements.bloomBase, elements.bloomBaseValue, "bloomBase");
  bindRange(elements.bloomGain, elements.bloomGainValue, "bloomGain");
  bindRange(elements.bloomRadius, elements.bloomRadiusValue, "bloomRadius");
  bindRange(elements.bloomThreshold, elements.bloomThresholdValue, "bloomThreshold");

  // Color
  bindRange(elements.cycleSpeed, elements.cycleSpeedValue, "cycleSpeed");
  bindRange(elements.brightness, elements.brightnessValue, "brightness");

  // Effects
  bindToggle(elements.beatFlashEnabled, "beatFlashEnabled");
  bindRange(
    elements.beatFlashIntensity,
    elements.beatFlashIntensityValue,
    "beatFlashIntensity"
  );
  bindRange(elements.beatSensitivity, elements.beatSensitivityValue, "beatSensitivity");

  // Export format
  bindSelect(elements.exportResolution, "videoResolution", updateExportEstimate);
  bindSelect(elements.videoFileType, "videoFileType", () => {
    updateVideoExportFormatUi(true);
    updateExportEstimate();
  });
  bindSelect(elements.videoFrameRate, "videoFrameRate", updateExportEstimate, Number);
  bindSelect(elements.videoBitrate, "videoBitrateMbps", updateExportEstimate, Number);

}

/* ---------------------------------------------------------------------------
   Transport wiring
--------------------------------------------------------------------------- */
function bindTransport() {
  elements.audioFile.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (file) await handleFile(file);
  });

  elements.playButton.addEventListener("click", togglePlayback);

  elements.loopButton.addEventListener("click", () => {
    galaxyLoopController.open();
  });

  audio.addEventListener("ended", () => {
    if (state.audioLoop && state.loopReady) {
      audio.currentTime = state.loopStart;
      audio.play().catch(() => {});
      return;
    }
    state.isPlaying = false;
    setPlayButtonState();
  });

  // Progress bar scrubbing — click and drag.
  let isScrubbing = false;
  const scrubTo = (clientX) => {
    if (!state.hasAudio || !Number.isFinite(audio.duration)) return;
    const rect = elements.progressBar.getBoundingClientRect();
    const fraction = clamp((clientX - rect.left) / rect.width, 0, 1);
    seekTo(fraction * audio.duration);
  };

  elements.progressBar.addEventListener("mousedown", (event) => {
    isScrubbing = true;
    scrubTo(event.clientX);
    event.preventDefault();
  });
  elements.progressBar.addEventListener(
    "touchstart",
    (event) => {
      isScrubbing = true;
      scrubTo(event.touches[0].clientX);
    },
    { passive: true }
  );
  document.addEventListener("mousemove", (event) => {
    if (isScrubbing) scrubTo(event.clientX);
  });
  document.addEventListener(
    "touchmove",
    (event) => {
      if (isScrubbing) scrubTo(event.touches[0].clientX);
    },
    { passive: true }
  );
  document.addEventListener("mouseup", () => {
    isScrubbing = false;
  });
  document.addEventListener("touchend", () => {
    isScrubbing = false;
  });
}

/* ---------------------------------------------------------------------------
   Loop wiring
--------------------------------------------------------------------------- */
function bindLoopControls() {
  initializeLoopEditor();

  elements.loopBpmValue.addEventListener("change", (event) => {
    beginHistory("Change loop BPM");
    state.loopBpm = clamp(Number(event.target.value) || 120, 40, 300);
    event.target.value = String(state.loopBpm);
    updateLoopSelectionUi();
    updateExportEstimate();
    commitHistory("Change loop BPM");
  });

  elements.loopBarsValue.addEventListener("change", (event) => {
    beginHistory("Change loop bars");
    state.loopBars = clamp(Number(event.target.value) || 4, 1, 999);
    event.target.value = String(state.loopBars);
    applyLoopBars();
    updateExportEstimate();
    commitHistory("Change loop bars");
  });

  elements.loopSnap.addEventListener("change", (event) => {
    beginHistory("Change loop snapping");
    state.loopSnap = event.target.checked;
    commitHistory("Change loop snapping");
  });

  elements.detectBpm.addEventListener("click", runBpmDetection);
  elements.fullTrackLoop.addEventListener("click", setFullTrackLoop);
}

/* ---------------------------------------------------------------------------
   Export wiring
--------------------------------------------------------------------------- */
function bindExportControls() {
  elements.exportVideo.addEventListener("click", exportVideo);
  elements.exportPng.addEventListener("click", exportPng);
  elements.exportJson.addEventListener("click", exportJson);
  elements.importJson.addEventListener("click", () => elements.importJsonFile.click());
  elements.importJsonFile.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      const settings = await parseSettingsFile(file);
      beginHistory("Import settings");
      await applySettingsSnapshot(settings);
      commitHistory("Import settings");
      elements.settingsStatus.textContent = "Settings imported successfully.";
      elements.settingsStatus.dataset.state = "done";
    } catch (error) {
      cancelHistory();
      console.error("Settings import failed", error);
      elements.settingsStatus.textContent = error.message || "Settings import failed.";
      elements.settingsStatus.dataset.state = "error";
    }
  });
  elements.exportCancel.addEventListener("click", requestVideoExportCancel);
  updateVideoExportFormatUi(true);
  updateExportEstimate();
}

/* ---------------------------------------------------------------------------
   File handling (picker and drag-and-drop)
--------------------------------------------------------------------------- */
async function handleFile(file) {
  await loadAudioFile(file, () => {
    drawLoopWaveform();
    updateLoopSelectionUi();
    updateExportEstimate();
  });
}

function bindDragAndDrop() {
  let dragDepth = 0;
  const supportedExtensions = new Set(["wav", "mp3", "m4a", "aac", "ogg", "flac"]);

  const isSupportedAudio = (file) => {
    if (!file) return false;
    if (file.type?.startsWith("audio/")) return true;
    const extension = file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "";
    return supportedExtensions.has(extension);
  };

  const hideOverlay = () => {
    dragDepth = 0;
    elements.dragOverlay.classList.remove("active", "is-invalid");
    elements.dragOverlay.setAttribute("aria-hidden", "true");
    elements.dragFileName.textContent = "mp3 · wav · m4a · ogg · flac · aac";
  };

  document.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    dragDepth += 1;
    elements.dragOverlay.classList.add("active");
    elements.dragOverlay.setAttribute("aria-hidden", "false");
  });
  document.addEventListener("dragleave", (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideOverlay();
  });
  document.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const file = event.dataTransfer.files?.[0];
    if (file) {
      const valid = isSupportedAudio(file) && event.dataTransfer.files.length === 1;
      elements.dragOverlay.classList.toggle("is-invalid", !valid);
      elements.dragFileName.textContent = event.dataTransfer.files.length > 1
        ? "Drop one audio file at a time"
        : file.name;
    }
  });
  document.addEventListener("drop", async (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files || []);
    hideOverlay();
    if (files.length !== 1) {
      elements.audioFileStatus.textContent = "Drop exactly one audio file at a time.";
      elements.audioFileStatus.dataset.state = "error";
      return;
    }
    const file = files[0];
    if (!isSupportedAudio(file)) {
      elements.audioFileStatus.textContent = "Unsupported file. Try WAV, MP3, M4A, AAC, OGG or FLAC.";
      elements.audioFileStatus.dataset.state = "error";
      return;
    }
    await handleFile(file);
  });
  window.addEventListener("blur", hideOverlay);
}

/* ---------------------------------------------------------------------------
   Keyboard shortcuts
--------------------------------------------------------------------------- */
function bindKeyboardShortcuts() {
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.matches("input, select, textarea")
    ) {
      return;
    }

    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redoSettings(applySettingsSnapshot);
      else undoSettings(applySettingsSnapshot);
      return;
    }
    if (modifier && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redoSettings(applySettingsSnapshot);
      return;
    }

    if (event.key === "f" || event.key === "F") {
      event.preventDefault();
      if (!document.fullscreenElement) {
        elements.container.requestFullscreen().catch((error) => {
          console.error("Could not enter fullscreen:", error);
        });
      } else {
        document.exitFullscreen();
      }
    }

    if (event.key === " " || event.code === "Space") {
      event.preventDefault();
      if (state.hasAudio) togglePlayback();
    }

    if (event.key === "h" || event.key === "H") {
      event.preventDefault();
      state.uiHidden = elements.panel.classList.toggle("hidden");
    }

    if (event.key === "l" || event.key === "L") {
      event.preventDefault();
      if (!elements.loopButton.disabled) {
        galaxyLoopController.open();
      }
    }
  });
}

/* ---------------------------------------------------------------------------
   Preview loop
--------------------------------------------------------------------------- */
let lastTimestamp = 0;

function tick(timestamp) {
  requestAnimationFrame(tick);

  if (state.isExportingVideo) {
    lastTimestamp = timestamp;
    return;
  }

  const deltaTime =
    lastTimestamp === 0
      ? 1 / 60
      : clamp((timestamp - lastTimestamp) / 1000, 0.001, 0.05);
  lastTimestamp = timestamp;
  const instantaneousFps = 1 / Math.max(0.001, deltaTime);
  state.previewFps += (instantaneousFps - state.previewFps) * 0.08;
  updateAutoQuality(deltaTime, state.previewFps);

  if (state.hasAudio) {
    enforceLoopRange();
    if (state.analysisReady) sampleAnalysisAtTime(currentPlayheadTime());
    updateTransportUi();
    updateLoopPlayhead();
  }

  renderFrame(deltaTime, state.isPlaying);
  renderHudPreview();

  elements.beatFlash.style.opacity = state.beatFlashEnabled
    ? String(state.flashAlpha)
    : "0";
}

/* ---------------------------------------------------------------------------
   Boot
--------------------------------------------------------------------------- */
function boot() {
  initializeCollapsibleSections();
  enhanceValueEditors();
  bindControls();
  buildColormapGrid();
  initializeColormapDisclosure();
  initializePanelToggle();
  initializeSectionResets();
  bindTransport();
  bindLoopControls();
  bindExportControls();
  bindDragAndDrop();
  bindKeyboardShortcuts();
  syncHistoryButtons();

  elements.undoButton.addEventListener("click", () => undoSettings(applySettingsSnapshot));
  elements.redoButton.addEventListener("click", () => redoSettings(applySettingsSnapshot));
  elements.resetButton.addEventListener("click", resetAll);

  window.addEventListener("visualizer-settings-applied", () => {
    updateVideoExportFormatUi(true);
    updateExportEstimate();
    updateQualityStatus();
    renderHudPreview();
  });
  window.addEventListener("visualizer-loop-changed", updateExportEstimate);

  applyVolume();
  updateLoopButtonState();
  galaxyLoopController.syncButton();
  setPlayButtonState();
  fitViewport();
  drawLoopWaveform();
  updateLoopSelectionUi();
  resetSimulation();
  updateQualityStatus();
  updateExportEstimate();
  renderHudPreview();

  window.addEventListener("resize", () => {
    fitViewport();
    drawLoopWaveform();
    updateLoopSelectionUi();
  });

  requestAnimationFrame(tick);
}

boot();

// Keep the defaults reachable for debugging without exposing internals.
window.__concentricSphereVisualizerDefaults = defaults;
