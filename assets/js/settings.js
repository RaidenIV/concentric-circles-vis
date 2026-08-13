/** settings.js — versioned JSON settings serialization, validation and apply. */
import {
  PERSISTED_SETTING_KEYS,
  SETTINGS_APP,
  SETTINGS_VERSION
} from "./config.js";
import { elements, state } from "./core.js";
import { setControlValue, syncColormapButtons } from "./controls.js";
import { updateLoopSelectionUi } from "./loop.js";
import { applyVolume, updateLoopButtonState } from "./playback.js";
import { resetSimulation } from "./render.js";
import { clamp } from "./utils.js";
import { fitViewport } from "./viewport.js";

const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;
const ENUMS = {
  amplitudeMode: new Set(["fixed", "track", "adaptive"]),
  viewportPreset: new Set(["fill", "landscape", "square", "portrait"]),
  cameraPreset: new Set([
    "static", "orbit", "horizontalOrbit", "verticalArc", "helix",
    "pendulum", "cinematicSweep", "figure8", "pushPull", "drift",
    "spectralCentroid"
  ]),
  qualityPreset: new Set(["custom", "performance", "balanced", "high", "maximum", "auto"]),
  videoResolution: new Set(["1080", "2k", "4k"]),
  videoFileType: new Set(["mp4", "mkv"]),
  cascadeDirection: new Set(["topToBottom", "bottomToTop"])
};

const NUMERIC_SELECTS = {
  videoFrameRate: new Set([24, 30, 60]),
  videoBitrateMbps: new Set([6, 10, 16, 24])
};

const BOOLEAN_KEYS = new Set([
  "muted", "audioLoop", "hudEnabled", "bloomEnabled",
  "beatFlashEnabled", "loopSnap"
]);

export function getSerializableSettings() {
  const output = {};
  PERSISTED_SETTING_KEYS.forEach((key) => {
    output[key] = state[key];
  });
  return output;
}

export function buildSettingsPayload() {
  return {
    app: SETTINGS_APP,
    version: SETTINGS_VERSION,
    exportedAt: new Date().toISOString(),
    sourceFile: state.fileName || null,
    settings: getSerializableSettings()
  };
}

function normalizeSettings(rawSettings) {
  if (!rawSettings || typeof rawSettings !== "object" || Array.isArray(rawSettings)) {
    throw new Error("Settings must be a JSON object.");
  }

  const normalized = {};
  PERSISTED_SETTING_KEYS.forEach((key) => {
    if (!(key in rawSettings)) return;
    const raw = rawSettings[key];

    if (ENUMS[key]) {
      const value = String(raw);
      if (ENUMS[key].has(value)) normalized[key] = value;
      return;
    }
    if (NUMERIC_SELECTS[key]) {
      const value = Number(raw);
      if (NUMERIC_SELECTS[key].has(value)) normalized[key] = value;
      return;
    }
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof raw === "boolean") normalized[key] = raw;
      return;
    }
    if (key === "renderPixelRatioLimit") {
      const value = Number(raw);
      if (Number.isFinite(value)) normalized[key] = clamp(value, 0.75, 3);
      return;
    }
    if (key === "lockedCmapIndex") {
      const value = Number(raw);
      if (Number.isFinite(value)) normalized[key] = Math.round(clamp(value, -1, 9));
      return;
    }

    const current = state[key];
    if (typeof current === "number") {
      const value = Number(raw);
      if (Number.isFinite(value)) normalized[key] = value;
      return;
    }

    if (typeof raw === typeof current) normalized[key] = raw;
  });

  return normalized;
}

export async function parseSettingsFile(file) {
  if (!file) throw new Error("No settings file selected.");
  if (file.size > MAX_SETTINGS_FILE_BYTES) {
    throw new Error("Settings file is too large. Select a JSON file under 1 MB.");
  }

  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch (error) {
    throw new Error("Invalid JSON. The selected settings file could not be parsed.", { cause: error });
  }

  // Legacy exports were a plain settings object. They remain importable, but
  // all new exports use the versioned wrapper required by the specification.
  if (!payload.settings) {
    return normalizeSettings(payload);
  }

  if (payload.app && payload.app !== SETTINGS_APP) {
    throw new Error(`This settings file belongs to “${payload.app}”, not ${SETTINGS_APP}.`);
  }
  const version = Number(payload.version);
  if (!Number.isFinite(version)) throw new Error("Settings version is missing or invalid.");
  if (version > SETTINGS_VERSION) {
    throw new Error(`Settings version ${version} is newer than this app supports (v${SETTINGS_VERSION}).`);
  }

  return normalizeSettings(payload.settings);
}

export async function applySettingsSnapshot(settings) {
  const normalized = normalizeSettings(settings);

  Object.entries(normalized).forEach(([key, value]) => {
    if (key === "loopBpm" || key === "loopBars" || key === "loopSnap" ||
        key === "loopStart" || key === "loopEnd" || key === "lockedCmapIndex" ||
        key === "renderPixelRatioLimit") {
      state[key] = value;
      return;
    }
    setControlValue(key, value);
  });

  state.loopBpm = clamp(Number(state.loopBpm) || 120, 40, 300);
  state.loopBars = clamp(Number(state.loopBars) || 4, 1, 999);
  const duration = state.decodedAudioBuffer?.duration || 0;
  if (duration > 0) {
    state.loopStart = clamp(Number(state.loopStart) || 0, 0, duration);
    state.loopEnd = clamp(Number(state.loopEnd) || duration, state.loopStart, duration);
  }

  elements.loopBpmValue.value = String(state.loopBpm);
  elements.loopBarsValue.value = String(state.loopBars);
  elements.loopSnap.checked = Boolean(state.loopSnap);
  syncColormapButtons();
  updateLoopSelectionUi();
  updateLoopButtonState();
  applyVolume();
  resetSimulation();
  fitViewport();

  window.dispatchEvent(new CustomEvent("visualizer-settings-applied"));
}
