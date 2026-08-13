/** quality.js — preview performance presets and conservative Auto mode. */
import { QUALITY_PRESETS } from "./config.js";
import { elements, state } from "./core.js";
import { setControlValue } from "./controls.js";
import { fitViewport } from "./viewport.js";

const AUTO_LEVELS = ["performance", "balanced", "high"];
let autoLevelIndex = 1;
let autoSampleSeconds = 0;
let lowFpsSeconds = 0;
let highFpsSeconds = 0;

function applyPresetValues(name, preservePresetName = false) {
  const preset = QUALITY_PRESETS[name];
  if (!preset) return;
  state.qualityPresetApplying = true;
  try {
    setControlValue("minParticles", preset.minParticles);
    setControlValue("maxParticles", preset.maxParticles);
    state.renderPixelRatioLimit = preset.renderPixelRatioLimit;
    fitViewport();
  } finally {
    state.qualityPresetApplying = false;
  }
  if (!preservePresetName) state.qualityPreset = name;
}

export function applyQualityPreset(name) {
  if (name === "custom") {
    state.qualityPreset = "custom";
    updateQualityStatus();
    return;
  }
  if (name === "auto") {
    state.qualityPreset = "auto";
    autoLevelIndex = 1;
    applyPresetValues(AUTO_LEVELS[autoLevelIndex], true);
    state.qualityPreset = "auto";
    lowFpsSeconds = 0;
    highFpsSeconds = 0;
    updateQualityStatus();
    return;
  }
  applyPresetValues(name);
  updateQualityStatus();
}

export function markQualityCustom() {
  if (state.qualityPresetApplying || state.qualityPreset === "custom") return;
  state.qualityPreset = "custom";
  if (elements.qualityPreset) elements.qualityPreset.value = "custom";
  updateQualityStatus();
}

export function updateAutoQuality(deltaTime, fps) {
  if (state.qualityPreset !== "auto") return;
  autoSampleSeconds += deltaTime;
  if (fps < 44) {
    lowFpsSeconds += deltaTime;
    highFpsSeconds = 0;
  } else if (fps > 57) {
    highFpsSeconds += deltaTime;
    lowFpsSeconds = 0;
  } else {
    lowFpsSeconds = Math.max(0, lowFpsSeconds - deltaTime * 0.5);
    highFpsSeconds = Math.max(0, highFpsSeconds - deltaTime * 0.5);
  }

  if (autoSampleSeconds < 2.5) return;
  autoSampleSeconds = 0;

  let nextIndex = autoLevelIndex;
  if (lowFpsSeconds >= 3 && autoLevelIndex > 0) nextIndex -= 1;
  if (highFpsSeconds >= 8 && autoLevelIndex < AUTO_LEVELS.length - 1) nextIndex += 1;

  if (nextIndex !== autoLevelIndex) {
    autoLevelIndex = nextIndex;
    applyPresetValues(AUTO_LEVELS[autoLevelIndex], true);
    state.qualityPreset = "auto";
    lowFpsSeconds = 0;
    highFpsSeconds = 0;
  }
  updateQualityStatus();
}

export function updateQualityStatus() {
  if (!elements.qualityStatus) return;
  if (state.qualityPreset === "auto") {
    elements.qualityStatus.textContent = `Auto · ${AUTO_LEVELS[autoLevelIndex]} · ${Math.round(state.previewFps || 0)} FPS`;
    return;
  }
  if (state.qualityPreset === "custom") {
    elements.qualityStatus.textContent = `Custom · ${Math.round(state.previewFps || 0)} FPS`;
    return;
  }
  elements.qualityStatus.textContent = `${state.qualityPreset[0].toUpperCase()}${state.qualityPreset.slice(1)} · ${Math.round(state.previewFps || 0)} FPS`;
}
