/**
 * reset.js — reset-to-defaults for each control section and for the app.
 */
import { defaults, loopDefaults, videoExportDefaults } from "./config.js";
import { elements, state } from "./core.js";
import { setControlValue, syncColormapButtons } from "./controls.js";
import {
  setLoopStatus,
  updateLoopSelectionUi
} from "./loop.js";
import { applyVolume, updateLoopButtonState } from "./playback.js";
import { resetSimulation } from "./render.js";
import { updateVideoExportFormatUi } from "./export.js";
import { fitViewport } from "./viewport.js";
import { beginHistory, commitHistory } from "./history.js";

const sectionKeys = {
  playback: ["volume", "muted", "audioLoop"],
  audio: ["fftSize", "smoothing", "amplitudeMode", "inputGain", "noiseFloor", "dynamicRange"],
  viewport: ["viewportPreset"],
  hud: ["hudEnabled", "hudOpacity", "hudScale"],
  performance: ["qualityPreset", "renderPixelRatioLimit"],
  camera: [
    "cameraPreset",
    "cameraSpeed",
    "cameraAmount",
    "cameraDistance",
    "cameraElevation",
    "cameraAzimuth"
  ],
  sphere: [
    "reactivity",
    "magnitudeExpansion",
    "cascadeSpeed",
    "cascadeSmoothing",
    "cascadeDirection",
    "ringCount",
    "sphereRadius",
    "sphereSize",
    "ringOpacity",
    "ringLineWidth",
    "rotationSpeed",
    "rotationAmount"
  ],
  bloom: ["bloomEnabled", "bloomBase", "bloomGain", "bloomRadius", "bloomThreshold"],
  color: ["cycleSpeed", "brightness"],
  effects: ["beatFlashEnabled", "beatFlashIntensity", "beatSensitivity"],
  "export-format": [
    "videoResolution",
    "videoFileType",
    "videoFrameRate",
    "videoBitrateMbps"
  ]
};

function resetKeys(keys) {
  keys.forEach((key) => {
    if (key in defaults) {
      setControlValue(key, defaults[key]);
    } else if (key in videoExportDefaults) {
      setControlValue(key, videoExportDefaults[key]);
    }
  });
}

function resetExportFormat() {
  setControlValue("videoResolution", videoExportDefaults.resolution);
  setControlValue("videoFileType", videoExportDefaults.fileType);
  setControlValue("videoFrameRate", videoExportDefaults.frameRate);
  setControlValue("videoBitrateMbps", videoExportDefaults.bitrateMbps);
  updateVideoExportFormatUi(true);
}

function resetLoopSection() {
  state.loopBpm = loopDefaults.bpm;
  state.loopBars = loopDefaults.bars;
  state.loopSnap = loopDefaults.snap;
  elements.loopBpmValue.value = String(loopDefaults.bpm);
  elements.loopBarsValue.value = String(loopDefaults.bars);
  elements.loopSnap.checked = loopDefaults.snap;

  if (state.loopReady) {
    const duration = state.decodedAudioBuffer?.duration || 0;
    state.loopStart = Math.max(0, Math.min(duration, loopDefaults.start));
    state.loopEnd = Math.max(
      state.loopStart,
      Math.min(
        duration,
        loopDefaults.end > state.loopStart ? loopDefaults.end : duration
      )
    );
  } else {
    state.loopStart = loopDefaults.start;
    state.loopEnd = loopDefaults.end;
  }
  updateLoopSelectionUi();
  setLoopStatus("Loop reset to default settings.", "idle");
}

export function resetSection(section, { record = true } = {}) {
  if (record) beginHistory(`Reset ${section}`);
  try {
    if (section === "loop") {
      resetLoopSection();
      return;
    }
    if (section === "export-format") {
      resetExportFormat();
      return;
    }
    if (section === "export") {
      elements.exportFileName.value = "";
      resetExportFormat();
      return;
    }

    const keys = sectionKeys[section];
    if (!keys) return;
    resetKeys(keys);

    if (section === "playback") {
      applyVolume();
      updateLoopButtonState();
    }
    if (section === "performance") {
      state.renderPixelRatioLimit = defaults.renderPixelRatioLimit;
      fitViewport();
    }
  } finally {
    if (record) commitHistory(`Reset ${section}`);
  }
}

/** The original "Reset to Defaults" button — now covers every section. */
export function resetAll() {
  beginHistory("Reset all");
  try {
    Object.keys(sectionKeys).forEach((section) => resetSection(section, { record: false }));
    setControlValue("lockedCmapIndex", defaults.lockedCmapIndex);
    state.lockedCmapIndex = defaults.lockedCmapIndex;
    syncColormapButtons();
    resetLoopSection();
    elements.exportFileName.value = "";
    applyVolume();
    updateLoopButtonState();
    resetSimulation();
  } finally {
    commitHistory("Reset all");
  }
}

export function initializeSectionResets() {
  document.querySelectorAll("[data-reset-section]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      resetSection(button.dataset.resetSection);
    });
  });
}
