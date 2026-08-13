/**
 * config.js — immutable defaults, colormaps and engine constants.
 * Every value here matches the original single-file build, so the visualizer
 * looks identical until a control is moved.
 */

export const defaults = Object.freeze({
  // Playback
  volume: 100,
  muted: false,
  audioLoop: false,

  // Analysis
  fftSize: 4096,
  smoothing: 0.8,
  amplitudeMode: "adaptive",
  inputGain: 1.0,
  noiseFloor: 2.5,
  dynamicRange: 60,

  // Viewport
  viewportPreset: "fill",

  // Camera
  cameraPreset: "static",
  cameraSpeed: 1.0,
  cameraAmount: 100,
  cameraDistance: 50,
  cameraElevation: 0,
  cameraAzimuth: 0,

  // HUD
  hudEnabled: true,
  hudOpacity: 0.9,
  hudScale: 1.0,

  // Performance
  qualityPreset: "custom",
  renderPixelRatioLimit: 2,

  // Particles
  reactivity: 100,
  boidType: "flow",
  morphScope: "all",
  morphSpeed: 1.0,
  movementSpeed: 1.0,
  movementAmount: 100,
  boidAlignment: 100,
  boidCohesion: 100,
  boidSeparation: 100,
  visualizationSize: 100,
  minParticles: 800,
  maxParticles: 20000,
  particleSize: 0.15,
  particleOpacity: 80,
  noiseScale: 1.0,
  damping: 0.95,
  sphereBoundary: 1.0,

  // Chaotic attractors
  attractorColorSource: "speed",
  traversalFloor: 0.25,
  traversalRange: 8.0,
  traversalCurve: 1.8,
  beatTraversalBoost: 60,
  attractorTrails: true,
  trailLength: 24,
  trailParticles: 1500,
  trailOpacity: 55,

  // Bloom
  bloomBase: 0.6,
  bloomGain: 3.2,
  bloomRadius: 0.45,
  bloomThreshold: 0.45,

  // Color
  lockedCmapIndex: -1,
  cycleSpeed: 1.0,
  brightness: 100,

  // Effects
  beatFlashEnabled: true,
  beatFlashIntensity: 100,
  beatSensitivity: 1.55
});


export const SETTINGS_APP = "Particle Visualizer";
export const SETTINGS_VERSION = 1;

export const QUALITY_PRESETS = Object.freeze({
  performance: { minParticles: 400, maxParticles: 8000, renderPixelRatioLimit: 1 },
  balanced: { minParticles: 800, maxParticles: 16000, renderPixelRatioLimit: 1.5 },
  high: { minParticles: 800, maxParticles: 24000, renderPixelRatioLimit: 2 },
  maximum: { minParticles: 1200, maxParticles: 40000, renderPixelRatioLimit: 2.5 }
});

export const PERSISTED_SETTING_KEYS = Object.freeze([
  "volume", "muted", "audioLoop",
  "fftSize", "smoothing", "amplitudeMode", "inputGain", "noiseFloor", "dynamicRange",
  "viewportPreset",
  "cameraPreset", "cameraSpeed", "cameraAmount", "cameraDistance", "cameraElevation", "cameraAzimuth",
  "hudEnabled", "hudOpacity", "hudScale",
  "qualityPreset", "renderPixelRatioLimit",
  "reactivity", "boidType", "morphScope", "morphSpeed", "movementSpeed", "movementAmount",
  "boidAlignment", "boidCohesion", "boidSeparation", "visualizationSize",
  "minParticles", "maxParticles", "particleSize", "particleOpacity", "noiseScale", "damping", "sphereBoundary",
  "attractorColorSource", "attractorTrails", "trailLength", "trailParticles", "trailOpacity",
  "traversalFloor", "traversalRange", "traversalCurve", "beatTraversalBoost",
  "bloomBase", "bloomGain", "bloomRadius", "bloomThreshold",
  "lockedCmapIndex", "cycleSpeed", "brightness",
  "beatFlashEnabled", "beatFlashIntensity", "beatSensitivity",
  "loopBpm", "loopBars", "loopSnap", "loopStart", "loopEnd",
  "videoResolution", "videoFileType", "videoFrameRate", "videoBitrateMbps"
]);

export const loopDefaults = Object.freeze({
  bpm: 120,
  bars: 4,
  snap: true,
  start: 0,
  end: 0
});

export const isFirefoxBrowser = /Firefox\//i.test(navigator.userAgent);

export const videoExportDefaults = Object.freeze({
  // Firefox's H.264 WebCodecs output can omit the decoder metadata that MP4
  // muxing requires, so default Firefox to the MKV/VP9 path instead.
  fileType: isFirefoxBrowser ? "mkv" : "mp4",
  resolution: "4k",
  frameRate: 60,
  bitrateMbps: 24
});

/** Absolute engine constants — not exposed as controls. */
export const engine = Object.freeze({
  DT: 0.0875,
  AUDIO_FACTOR: 3.0,
  PARTICLE_POOL: 40000,
  WORLD_BOUNDARY: 32,
  RENDER_SCALE: 20.0,
  BLOOM_LAYER: 1,
  BEAT_HISTORY: 43,
  BEAT_COOLDOWN_FRAMES: 14,
  FLASH_DURATION: 0.38,
  ANALYSIS_FPS: 60,
  BASE_FRAME_TIME: 0.016,
  // Chaotic-attractor trails. The ring buffer is allocated for the worst case
  // once; the controls only change how much of it is walked each frame.
  TRAIL_MAX_LENGTH: 48,
  TRAIL_PARTICLE_CAP: 4000,
  // Silent sub-steps walked by a single leader particle when entering an
  // attractor mode, so the first visible frame is already a formed manifold
  // instead of a collapsing ball.
  ATTRACTOR_PREWARM_BURN_IN: 600,
  // Explicit Euler blurs the manifold once the per-sub-step distance grows.
  // Above this, the attractor field is re-evaluated multiple times per step.
  ATTRACTOR_MAX_POSITION_STEP: 0.0875,
  ATTRACTOR_MAX_SUBSTEPS: 8,
  // Decay of the per-beat traversal impulse, in simulation seconds.
  BEAT_IMPULSE_DECAY: 0.18
});

export const FREQ_BANDS = Object.freeze([
  { name: "Sub Bass", min: 20, max: 60 },
  { name: "Bass", min: 60, max: 250 },
  { name: "Low Mids", min: 250, max: 500 },
  { name: "Midrange", min: 500, max: 2000 },
  { name: "Upper Mids", min: 2000, max: 4000 },
  { name: "Presence", min: 4000, max: 6000 },
  { name: "Brilliance", min: 6000, max: 20000 }
]);

export const LOW_FREQ_BAND = Object.freeze({ min: 0, max: 150 });

export const COLORMAPS = Object.freeze([
  { name: "Turbo", stops: [
    [0.00, [0.19, 0.07, 0.23]],
    [0.25, [0.10, 0.55, 0.95]],
    [0.50, [0.30, 0.95, 0.55]],
    [0.75, [0.98, 0.86, 0.20]],
    [1.00, [0.93, 0.20, 0.10]]
  ]},
  { name: "Viridis", stops: [
    [0.00, [0.27, 0.00, 0.33]],
    [0.33, [0.13, 0.57, 0.55]],
    [0.66, [0.37, 0.79, 0.38]],
    [1.00, [0.99, 0.91, 0.11]]
  ]},
  { name: "Inferno", stops: [
    [0.00, [0.00, 0.00, 0.04]],
    [0.33, [0.42, 0.04, 0.33]],
    [0.66, [0.92, 0.35, 0.13]],
    [1.00, [0.99, 0.99, 0.75]]
  ]},
  { name: "Magma", stops: [
    [0.00, [0.00, 0.00, 0.04]],
    [0.25, [0.28, 0.13, 0.45]],
    [0.50, [0.72, 0.21, 0.47]],
    [0.75, [0.99, 0.52, 0.38]],
    [1.00, [0.99, 0.99, 0.75]]
  ]},
  { name: "Plasma", stops: [
    [0.00, [0.05, 0.03, 0.53]],
    [0.33, [0.62, 0.15, 0.69]],
    [0.66, [0.96, 0.45, 0.41]],
    [1.00, [0.94, 0.98, 0.13]]
  ]},
  { name: "Cool", stops: [
    [0.00, [0.00, 1.00, 1.00]],
    [0.50, [0.50, 0.50, 1.00]],
    [1.00, [1.00, 0.00, 1.00]]
  ]},
  { name: "Hot", stops: [
    [0.00, [0.04, 0.00, 0.00]],
    [0.33, [1.00, 0.00, 0.00]],
    [0.66, [1.00, 1.00, 0.00]],
    [1.00, [1.00, 1.00, 1.00]]
  ]},
  { name: "Twilight", stops: [
    [0.00, [0.89, 0.80, 0.85]],
    [0.25, [0.55, 0.42, 0.69]],
    [0.50, [0.18, 0.24, 0.32]],
    [0.75, [0.55, 0.42, 0.69]],
    [1.00, [0.89, 0.80, 0.85]]
  ]},
  { name: "Greyscale", stops: [
    [0.00, [0.00, 0.00, 0.00]],
    [0.50, [0.50, 0.50, 0.50]],
    [1.00, [1.00, 1.00, 1.00]]
  ]},
  { name: "Cividis", stops: [
    [0.00, [0.00, 0.13, 0.30]],
    [0.33, [0.31, 0.38, 0.42]],
    [0.66, [0.77, 0.58, 0.32]],
    [1.00, [1.00, 0.85, 0.16]]
  ]}
]);

export const viewportPresets = Object.freeze({
  fill: { label: "Fill Window", aspect: null },
  landscape: { label: "Landscape — 16:9", aspect: 16 / 9 },
  square: { label: "Square — 1:1", aspect: 1 },
  portrait: { label: "Portrait — 9:16", aspect: 9 / 16 }
});

export const exportResolutions = Object.freeze({
  "1080": 1080,
  "2k": 1440,
  "4k": 2160
});
