/**
 * export.js — PNG, video (MP4 / MKV) and JSON export.
 *
 * The video path mirrors Binary Tower: frames are rendered off a fixed
 * frame-rate clock rather than the wall clock, WebCodecs encodes in quality
 * mode with strict backpressure so no frame is dropped, and audio is encoded
 * from the decoded buffer across the same range as the visuals.
 */
import { isFirefoxBrowser, videoExportDefaults } from "./config.js";
import { sampleAnalysisAtTime } from "./analysis.js";
import { audio, elements, state } from "./core.js";
import { getSelectedLoopRange, hasPartialLoopSelection } from "./loop.js";
import { pausePlayback } from "./playback.js";
import { renderFrame, resetSimulation } from "./render.js";
import { drawHud } from "./hud.js";
import { buildSettingsPayload, getSerializableSettings } from "./settings.js";
import { canvas, resizeRenderer } from "./scene.js";
import { fitViewport, getExportDimensions } from "./viewport.js";
import {
  clamp,
  downloadBlob,
  nextEventLoopTurn,
  sanitizeFileName
} from "./utils.js";

let Mp4MuxerModule = null;
let MediabunnyModule = null;

let compositeCanvas = null;
let compositeContext = null;
let exportProgressTracker = null;

/* ---------------------------------------------------------------------------
   Status and progress
--------------------------------------------------------------------------- */
export function setExportStatus(message, status = "idle") {
  elements.exportStatus.textContent = message;
  elements.exportStatus.dataset.state = status;
}

function formatDurationLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}m ${String(remaining).padStart(2, "0")}s`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function initializeProgressTracker(totalFrames, duration) {
  exportProgressTracker = {
    startedAt: performance.now(),
    totalFrames,
    duration,
    completedFrames: 0
  };
}

export function setExportProgress(percent, detail = "Encoding", meta = {}) {
  const normalized = clamp(Number(percent) || 0, 0, 100);
  const rounded = Math.round(normalized);
  elements.exportProgressWrap.hidden = false;
  elements.exportProgress.value = normalized;
  elements.exportProgressText.textContent = `${rounded}%`;
  elements.exportOverlayProgress.value = normalized;
  elements.exportOverlayProgressText.textContent = `${rounded}%`;
  elements.exportOverlayDetail.textContent = `${detail} · ${rounded}%`;

  const stage = meta.stage || detail || "Working";
  const completedFrames = Number.isFinite(meta.completedFrames)
    ? meta.completedFrames
    : exportProgressTracker?.completedFrames || 0;
  const totalFrames = Number.isFinite(meta.totalFrames)
    ? meta.totalFrames
    : exportProgressTracker?.totalFrames || 0;
  const duration = Number.isFinite(meta.duration)
    ? meta.duration
    : exportProgressTracker?.duration || 0;
  const currentTime = Number.isFinite(meta.currentTime)
    ? meta.currentTime
    : totalFrames > 0 ? duration * (completedFrames / totalFrames) : 0;

  if (exportProgressTracker && Number.isFinite(meta.completedFrames)) {
    exportProgressTracker.completedFrames = meta.completedFrames;
  }

  let etaLabel = "—";
  if (exportProgressTracker && completedFrames >= 5 && totalFrames > completedFrames) {
    const elapsedWall = Math.max(0.001, (performance.now() - exportProgressTracker.startedAt) / 1000);
    const secondsPerFrame = elapsedWall / completedFrames;
    etaLabel = formatDurationLabel((totalFrames - completedFrames) * secondsPerFrame);
  } else if (rounded >= 98) {
    etaLabel = "< 1s";
  }

  const timeLabel = duration > 0
    ? `${formatDurationLabel(currentTime)} / ${formatDurationLabel(duration)}`
    : "—";
  const frameLabel = totalFrames > 0 ? `${Math.min(completedFrames, totalFrames)} / ${totalFrames}` : "—";

  elements.exportProgressStage.textContent = stage;
  elements.exportProgressTime.textContent = timeLabel;
  elements.exportProgressFrames.textContent = frameLabel;
  elements.exportProgressEta.textContent = etaLabel;
  elements.exportOverlayStage.textContent = stage;
  elements.exportOverlayTime.textContent = timeLabel;
  elements.exportOverlayFrames.textContent = frameLabel;
  elements.exportOverlayEta.textContent = etaLabel;
}

function getSelectedVideoFileType() {
  return state.videoFileType === "mkv" ? "mkv" : "mp4";
}

function getVideoFormatLabel(fileType = getSelectedVideoFileType()) {
  return fileType.toUpperCase();
}

export function getVideoExportIdleMessage(fileType = getSelectedVideoFileType()) {
  if (isFirefoxBrowser && fileType === "mp4") {
    return "Firefox cannot reliably mux MP4/H.264 from WebCodecs. Select MKV for Firefox export.";
  }
  if (isFirefoxBrowser && fileType === "mkv") {
    return "Firefox export uses MKV with the first supported VP9, VP8, AV1 or AVC encoder and Opus audio.";
  }
  return `${getVideoFormatLabel(fileType)} export requires a loaded audio file and WebCodecs support.`;
}

export function updateVideoExportFormatUi(resetStatus = true) {
  if (state.isExportingVideo) return;
  elements.exportVideo.textContent = "Export Video";
  elements.exportVideo.classList.remove("is-cancel");
  if (resetStatus) setExportStatus(getVideoExportIdleMessage(), "idle");
}

/* ---------------------------------------------------------------------------
   Cancellation
--------------------------------------------------------------------------- */
function registerVideoExportCancelHandler(handler) {
  state.videoExportCancelHandlers.add(handler);
  return () => state.videoExportCancelHandlers.delete(handler);
}

export function requestVideoExportCancel() {
  if (!state.isExportingVideo || state.videoExportCancelled) return;
  state.videoExportCancelled = true;
  setExportStatus("Cancelling video export…", "active");
  state.videoExportCancelHandlers.forEach((handler) => {
    try {
      handler();
    } catch (error) {
      console.warn("Cancel handler failed", error);
    }
  });
}

function throwIfCancelled() {
  if (!state.videoExportCancelled) return;
  throw new DOMException("Video export cancelled.", "AbortError");
}

function beginExportOverlay() {
  elements.exportOverlay.classList.add("active");
}

function endExportOverlay() {
  elements.exportOverlay.classList.remove("active");
}

/* ---------------------------------------------------------------------------
   Frame compositing
   The beat flash is a DOM overlay in the preview; for export it is drawn onto
   a 2D composite canvas so the encoded file matches what is on screen.
--------------------------------------------------------------------------- */
function ensureCompositeCanvas(width, height) {
  if (!compositeCanvas) {
    compositeCanvas = document.createElement("canvas");
    compositeContext = compositeCanvas.getContext("2d", { alpha: false });
  }
  if (compositeCanvas.width !== width || compositeCanvas.height !== height) {
    compositeCanvas.width = width;
    compositeCanvas.height = height;
  }
  return compositeCanvas;
}

function compositeFrame(width, height) {
  ensureCompositeCanvas(width, height);
  compositeContext.fillStyle = "#000000";
  compositeContext.fillRect(0, 0, width, height);
  compositeContext.drawImage(canvas, 0, 0, width, height);

  const flash = state.beatFlashEnabled ? state.flashAlpha : 0;
  if (flash > 0.001) {
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.max(width, height) * 0.68;
    const gradient = compositeContext.createRadialGradient(
      centerX,
      centerY,
      0,
      centerX,
      centerY,
      radius
    );
    gradient.addColorStop(0, `rgba(255,255,255,${0.2 * flash})`);
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    compositeContext.fillStyle = gradient;
    compositeContext.fillRect(0, 0, width, height);
  }

  drawHud(compositeContext, width, height);
  return compositeCanvas;
}

/* ---------------------------------------------------------------------------
   File naming
--------------------------------------------------------------------------- */
export function getExportFileBaseName() {
  const customName = elements.exportFileName.value.trim();
  if (customName) return sanitizeFileName(customName);
  if (state.fileName) return sanitizeFileName(state.fileName);
  return "particle-visualizer";
}

/* ---------------------------------------------------------------------------
   PNG export
--------------------------------------------------------------------------- */
function canvasToPngBlob(sourceCanvas) {
  return new Promise((resolve) => sourceCanvas.toBlob(resolve, "image/png"));
}

export async function exportPng() {
  if (state.isExportingPng || state.isExportingVideo) return;

  state.isExportingPng = true;
  elements.exportPng.disabled = true;
  const originalLabel = elements.exportPng.textContent;
  elements.exportPng.textContent = "Exporting…";

  const savedWidth = state.cssWidth;
  const savedHeight = state.cssHeight;
  const savedRatio = state.pixelRatio;

  try {
    const { width, height } = getExportDimensions();
    resizeRenderer(width, height, 1);
    renderFrame(0, false);

    const blob = await canvasToPngBlob(compositeFrame(width, height));
    if (!blob) throw new Error("PNG export failed.");

    downloadBlob(blob, `${getExportFileBaseName()}-frame.png`);
    setExportStatus(`PNG exported at ${width}×${height}.`, "done");
  } catch (error) {
    console.error(error);
    setExportStatus(`EXPORT ERROR / ${error.message}`, "error");
  } finally {
    resizeRenderer(savedWidth, savedHeight, savedRatio);
    renderFrame(0, false);
    state.isExportingPng = false;
    elements.exportPng.disabled = false;
    elements.exportPng.textContent = originalLabel;
  }
}

/* ---------------------------------------------------------------------------
   JSON export
--------------------------------------------------------------------------- */
export function collectExportedControlValues() {
  return getSerializableSettings();
}

export function exportJson() {
  const payload = JSON.stringify(buildSettingsPayload(), null, 2);
  downloadBlob(
    new Blob([payload], { type: "application/json" }),
    `${getExportFileBaseName()}.json`
  );
  setExportStatus("Settings exported as versioned JSON.", "done");
}

/* ---------------------------------------------------------------------------
   Encoder helpers
--------------------------------------------------------------------------- */
async function loadMp4MuxerModule() {
  if (!Mp4MuxerModule) {
    Mp4MuxerModule = await import("https://cdn.jsdelivr.net/npm/mp4-muxer@5/+esm");
  }
  return Mp4MuxerModule;
}

async function loadMediabunnyModule() {
  if (!MediabunnyModule) {
    MediabunnyModule = await import(
      "https://cdn.jsdelivr.net/npm/mediabunny@1.46.0/+esm"
    );
  }
  return MediabunnyModule;
}

async function chooseSupportedAvcConfig(width, height, bitrate, frameRate) {
  const candidates = ["avc1.640033", "avc1.64002A", "avc1.4D402A", "avc1.42001F"];
  const qualityProfiles = [
    { latencyMode: "quality", bitrateMode: "variable", hardwareAcceleration: "no-preference" },
    { latencyMode: "quality", hardwareAcceleration: "no-preference" },
    { bitrateMode: "variable", hardwareAcceleration: "no-preference" }
  ];

  // Offline export must never use realtime mode: a realtime encoder is allowed
  // to drop frames when it cannot keep pace, which shows up as visible pauses.
  for (const codec of candidates) {
    for (const qualityProfile of qualityProfiles) {
      const config = {
        codec,
        width,
        height,
        bitrate,
        framerate: frameRate,
        ...qualityProfile,
        avc: { format: "avc" }
      };
      try {
        const support = await VideoEncoder.isConfigSupported(config);
        if (support.supported) return support.config || config;
      } catch (error) {
        console.warn(`Unsupported AVC configuration ${codec}`, error);
      }
    }
  }

  throw new Error(
    "The selected resolution, bitrate or frame rate is not supported by this browser."
  );
}

async function waitForEncoderQueue(encoder, maximumQueueSize = 5) {
  while (encoder.encodeQueueSize > maximumQueueSize) {
    if (state.videoExportCancelled) return;
    await nextEventLoopTurn();
  }
}

function getEffectiveVideoBitrate(baseBitrateMbps, width, height) {
  // Treat the selected value as the 1080p target, then scale gently for larger
  // rasters. Square-root scaling avoids a 4x bitrate spike at 4K.
  const basePixels = 1920 * 1080;
  const pixelScale = Math.max(1, (width * height) / basePixels);
  const resolutionScale = clamp(Math.sqrt(pixelScale), 1, 2.5);
  return Math.round(clamp(baseBitrateMbps * resolutionScale, 1, 120) * 1_000_000);
}

function getVideoFrameTiming(frameIndex, frameRate) {
  const timestampUs = Math.round((frameIndex * 1_000_000) / frameRate);
  const nextTimestampUs = Math.round(((frameIndex + 1) * 1_000_000) / frameRate);
  return {
    timestampUs,
    durationUs: Math.max(1, nextTimestampUs - timestampUs),
    timestampSeconds: frameIndex / frameRate,
    durationSeconds: 1 / frameRate
  };
}

function getVideoExportRange() {
  const fullDuration = state.decodedAudioBuffer?.duration || 0;
  if (fullDuration <= 0) return { start: 0, end: 0, duration: 0 };

  // A partial selection is exported only when looping is actually enabled.
  if (state.audioLoop && hasPartialLoopSelection()) {
    return getSelectedLoopRange();
  }
  return { start: 0, end: fullDuration, duration: fullDuration };
}

export function updateExportEstimate() {
  const range = getVideoExportRange();
  if (!range.duration || !state.decodedAudioBuffer) {
    elements.exportEstimateDuration.textContent = "—";
    elements.exportEstimateSize.textContent = "—";
    elements.exportEstimateTime.textContent = "—";
    return;
  }

  const { width, height } = getExportDimensions();
  const frameRate = Number(state.videoFrameRate) || videoExportDefaults.frameRate;
  const baseBitrateMbps = Number(state.videoBitrateMbps) || videoExportDefaults.bitrateMbps;
  const videoBitrate = getEffectiveVideoBitrate(baseBitrateMbps, width, height);
  const audioBitrate = 192_000;
  const estimatedBytes = range.duration * (videoBitrate + audioBitrate) / 8 * 1.03;
  const totalFrames = Math.max(1, Math.ceil(range.duration * frameRate));

  let estimatedSeconds;
  if (state.lastExportSecondsPerFrame > 0) {
    estimatedSeconds = totalFrames * state.lastExportSecondsPerFrame;
  } else {
    const pixelScale = (width * height) / (1920 * 1080);
    const fpsScale = frameRate / 30;
    estimatedSeconds = range.duration * clamp(0.28 * pixelScale * fpsScale, 0.25, 6);
  }

  elements.exportEstimateDuration.textContent = formatDurationLabel(range.duration);
  elements.exportEstimateSize.textContent = `≈ ${formatBytes(estimatedBytes)}`;
  elements.exportEstimateTime.textContent = `≈ ${formatDurationLabel(estimatedSeconds)}`;
}

async function encodeAudioIntoMuxer(muxer, audioBuffer, startSeconds, endSeconds) {
  if (!window.AudioEncoder || !window.AudioData) {
    return { encoded: false, reason: "AudioEncoder is unavailable." };
  }

  const sampleRate = audioBuffer.sampleRate;
  const numberOfChannels = 2;
  const audioConfig = {
    codec: "mp4a.40.2",
    sampleRate,
    numberOfChannels,
    bitrate: 192_000
  };

  let support;
  try {
    support = await AudioEncoder.isConfigSupported(audioConfig);
  } catch (error) {
    return { encoded: false, reason: error.message };
  }
  if (!support.supported) {
    return { encoded: false, reason: "AAC encoding is unsupported." };
  }

  let encodingError = null;
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => muxer.addAudioChunk(chunk, metadata),
    error: (error) => {
      encodingError = error;
    }
  });
  encoder.configure(support.config || audioConfig);

  const unregister = registerVideoExportCancelHandler(() => {
    try {
      if (encoder.state === "configured") encoder.reset();
    } catch (error) {
      console.warn("Audio encoder cancellation failed", error);
    }
  });

  const sourceLeft = audioBuffer.getChannelData(0);
  const sourceRight =
    audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : sourceLeft;
  const gain = state.muted ? 0 : clamp(state.volume / 100, 0, 1);
  const chunkSize = 2048;
  const startFrame = clamp(Math.floor(startSeconds * sampleRate), 0, audioBuffer.length);
  const endFrame = clamp(Math.ceil(endSeconds * sampleRate), startFrame, audioBuffer.length);
  const totalFrames = endFrame - startFrame;

  try {
    for (let offset = 0; offset < totalFrames; offset += chunkSize) {
      if (state.videoExportCancelled) break;
      if (encodingError) throw encodingError;

      const frameCount = Math.min(chunkSize, totalFrames - offset);
      const planarData = new Float32Array(frameCount * numberOfChannels);

      for (let index = 0; index < frameCount; index += 1) {
        const sourceIndex = startFrame + offset + index;
        planarData[index] = sourceLeft[sourceIndex] * gain;
        planarData[frameCount + index] = sourceRight[sourceIndex] * gain;
      }

      const audioData = new AudioData({
        format: "f32-planar",
        sampleRate,
        numberOfFrames: frameCount,
        numberOfChannels,
        timestamp: Math.round((offset / sampleRate) * 1_000_000),
        data: planarData
      });

      encoder.encode(audioData);
      audioData.close();
      await waitForEncoderQueue(encoder, 8);
      await nextEventLoopTurn();
    }

    if (!state.videoExportCancelled) await encoder.flush();
  } finally {
    unregister();
    try {
      if (encoder.state !== "closed") encoder.close();
    } catch (error) {
      console.warn("Audio encoder cleanup failed", error);
    }
  }

  if (encodingError) return { encoded: false, reason: encodingError.message };
  return { encoded: true };
}

function createExportAudioBufferSegment(audioBuffer, startSeconds, endSeconds) {
  const sampleRate = audioBuffer.sampleRate;
  const startFrame = clamp(Math.floor(startSeconds * sampleRate), 0, audioBuffer.length);
  const endFrame = clamp(Math.ceil(endSeconds * sampleRate), startFrame, audioBuffer.length);
  const frameCount = Math.max(1, endFrame - startFrame);
  const outputBuffer = new AudioBuffer({
    length: frameCount,
    numberOfChannels: 2,
    sampleRate
  });

  const sourceLeft = audioBuffer.getChannelData(0);
  const sourceRight =
    audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : sourceLeft;
  const gain = state.muted ? 0 : clamp(state.volume / 100, 0, 1);

  [sourceLeft, sourceRight].forEach((sourceChannel, channelIndex) => {
    const destination = outputBuffer.getChannelData(channelIndex);
    const slice = sourceChannel.subarray(startFrame, endFrame);
    if (gain === 1) {
      destination.set(slice);
    } else if (gain !== 0) {
      for (let index = 0; index < slice.length; index += 1) {
        destination[index] = slice[index] * gain;
      }
    }
  });

  return outputBuffer;
}

/* ---------------------------------------------------------------------------
   Frame loop
--------------------------------------------------------------------------- */
async function renderVideoExportFrames({
  formatLabel,
  frameRate,
  totalFrames,
  duration,
  exportStart,
  exportEnd,
  width,
  height,
  addFrame
}) {
  const frameDelta = 1 / frameRate;

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    if (state.videoExportCancelled) break;

    const elapsed = Math.min(duration, frameIndex / frameRate);
    const exportTime = Math.min(exportEnd, exportStart + elapsed);
    state.renderTimeOverride = exportTime;

    sampleAnalysisAtTime(exportTime);
    renderFrame(frameDelta, true);
    compositeFrame(width, height);

    // Let the browser dispatch the cancel click before queueing another frame.
    await nextEventLoopTurn();
    if (state.videoExportCancelled) break;

    await addFrame(frameIndex);
    await nextEventLoopTurn();
    if (state.videoExportCancelled) break;

    if (frameIndex % Math.max(1, Math.round(frameRate / 3)) === 0) {
      const percent = Math.min(
        90,
        Math.round(((frameIndex + 1) / totalFrames) * 90)
      );
      setExportStatus(
        `Encoding ${formatLabel} video… ${percent}% · ${frameIndex + 1}/${totalFrames} frames`,
        "active"
      );
      setExportProgress(percent, `Encoding frame ${frameIndex + 1} of ${totalFrames}`, {
        stage: `Rendering ${formatLabel} video`,
        completedFrames: frameIndex + 1,
        totalFrames,
        duration,
        currentTime: Math.min(duration, (frameIndex + 1) / frameRate)
      });
    }
  }
}

/* ---------------------------------------------------------------------------
   Video export
--------------------------------------------------------------------------- */
export async function exportVideo() {
  if (state.isExportingVideo) {
    requestVideoExportCancel();
    return;
  }

  if (!state.hasAudio || !state.analysisReady || !state.decodedAudioBuffer) {
    setExportStatus(
      "Load and finish analyzing an audio file before exporting video.",
      "error"
    );
    return;
  }

  const fileType = getSelectedVideoFileType();
  const formatLabel = getVideoFormatLabel(fileType);

  if (isFirefoxBrowser && fileType === "mp4") {
    setExportStatus(
      "Firefox does not provide reliable H.264 decoder metadata for MP4 muxing. Select MKV, or export MP4 in Chrome or Edge.",
      "error"
    );
    return;
  }

  if (!window.VideoEncoder || !window.VideoFrame) {
    setExportStatus(
      `${formatLabel} export requires a browser with WebCodecs video encoding support.`,
      "error"
    );
    return;
  }

  const { width, height } = getExportDimensions();
  const frameRate = Number(state.videoFrameRate) || videoExportDefaults.frameRate;
  const baseBitrateMbps =
    Number(state.videoBitrateMbps) || videoExportDefaults.bitrateMbps;
  const videoBitrate = getEffectiveVideoBitrate(baseBitrateMbps, width, height);
  const effectiveBitrateMbps = videoBitrate / 1_000_000;

  const exportRange = getVideoExportRange();
  const exportStart = exportRange.start;
  const exportEnd = exportRange.end;
  const duration = Math.max(0.001, exportRange.duration);
  const totalFrames = Math.max(1, Math.ceil(duration * frameRate));
  initializeProgressTracker(totalFrames, duration);
  const exportWallStart = performance.now();

  const savedWidth = state.cssWidth;
  const savedHeight = state.cssHeight;
  const savedRatio = state.pixelRatio;
  const savedTime = audio.currentTime;
  const savedWasPlaying = state.isPlaying;

  state.isExportingVideo = true;
  state.videoExportCancelled = false;
  state.videoExportCancelHandlers.clear();

  pausePlayback();
  beginExportOverlay();
  elements.exportVideo.textContent = "Cancel Video Export";
  elements.exportVideo.classList.add("is-cancel");
  elements.exportPng.disabled = true;
  elements.exportJson.disabled = true;
  elements.importJson.disabled = true;
  elements.videoFileType.disabled = true;
  elements.videoFrameRate.disabled = true;
  elements.videoBitrate.disabled = true;
  elements.exportResolution.disabled = true;

  setExportStatus(
    `Preparing ${formatLabel} encoder · ${frameRate} FPS · ${effectiveBitrateMbps.toFixed(1)} Mbps quality mode…`,
    "active"
  );
  setExportProgress(1, "Preparing encoder", {
    stage: "Preparing", completedFrames: 0, totalFrames, duration, currentTime: 0
  });

  let videoEncoder = null;
  let mediabunnyOutput = null;
  let exportCompleted = false;

  try {
    resizeRenderer(width, height, 1);
    resetSimulation();
    ensureCompositeCanvas(width, height);
    throwIfCancelled();

    if (fileType === "mkv") {
      const {
        Output,
        MkvOutputFormat,
        BufferTarget,
        CanvasSource,
        AudioBufferSource,
        getFirstEncodableVideoCodec,
        getFirstEncodableAudioCodec
      } = await loadMediabunnyModule();
      throwIfCancelled();

      // Firefox's AVC encoder can report support while omitting the first
      // chunk's decoderConfig, so prefer royalty-free codecs there.
      const preferredVideoCodecs = isFirefoxBrowser
        ? ["vp9", "vp8", "av1", "avc"]
        : ["avc", "vp9", "vp8", "av1"];

      const selectedVideoCodec = await getFirstEncodableVideoCodec(
        preferredVideoCodecs,
        { width, height, bitrate: videoBitrate }
      );
      const selectedAudioCodec = await getFirstEncodableAudioCodec(
        ["opus", "aac"],
        { numberOfChannels: 2, sampleRate: 48_000, bitrate: 192_000 }
      );
      throwIfCancelled();

      if (!selectedVideoCodec) {
        throw new Error(
          "No compatible MKV video encoder is available for the selected resolution and bitrate."
        );
      }
      if (!selectedAudioCodec) {
        throw new Error("No compatible MKV audio encoder is available in this browser.");
      }

      setExportStatus(
        `Preparing MKV ${selectedVideoCodec.toUpperCase()} + ${selectedAudioCodec.toUpperCase()} encoders…`,
        "active"
      );

      const target = new BufferTarget();
      mediabunnyOutput = new Output({
        format: new MkvOutputFormat(),
        target
      });

      const videoSource = new CanvasSource(compositeCanvas, {
        codec: selectedVideoCodec,
        bitrate: videoBitrate
      });
      const audioSource = new AudioBufferSource({
        codec: selectedAudioCodec,
        bitrate: 192_000
      });

      mediabunnyOutput.addVideoTrack(videoSource, { frameRate });
      mediabunnyOutput.addAudioTrack(audioSource);
      await mediabunnyOutput.start();

      registerVideoExportCancelHandler(async () => {
        try {
          if (mediabunnyOutput && ["pending", "started"].includes(mediabunnyOutput.state)) {
            await mediabunnyOutput.cancel();
          }
        } catch (error) {
          console.warn("MKV cancellation failed", error);
        }
      });

      const exportAudioBuffer = createExportAudioBufferSegment(
        state.decodedAudioBuffer,
        exportStart,
        exportEnd
      );

      let audioEncodingError = null;
      const audioEncodingPromise = audioSource
        .add(exportAudioBuffer)
        .catch((error) => {
          audioEncodingError = error;
        })
        .finally(() => {
          try {
            audioSource.close();
          } catch (error) {
            console.warn("MKV audio source cleanup failed", error);
          }
        });

      await renderVideoExportFrames({
        formatLabel,
        frameRate,
        totalFrames,
        duration,
        exportStart,
        exportEnd,
        width,
        height,
        addFrame: (frameIndex) => {
          if (state.videoExportCancelled) return;
          const timing = getVideoFrameTiming(frameIndex, frameRate);
          return videoSource.add(timing.timestampSeconds, timing.durationSeconds, {
            keyFrame: frameIndex % Math.max(1, frameRate * 2) === 0
          });
        }
      });

      if (!state.videoExportCancelled) videoSource.close();

      if (state.videoExportCancelled) {
        await audioEncodingPromise;
        setExportStatus("Video export cancelled.", "idle");
        return;
      }

      setExportStatus("Encoding synchronized audio… 92%", "active");
      setExportProgress(92, "Encoding audio", {
        stage: "Encoding audio", completedFrames: totalFrames, totalFrames, duration, currentTime: duration
      });
      await audioEncodingPromise;
      if (audioEncodingError) throw audioEncodingError;

      setExportStatus("Finalizing MKV container… 98%", "active");
      setExportProgress(98, "Finalizing MKV", {
        stage: "Finalizing file", completedFrames: totalFrames, totalFrames, duration, currentTime: duration
      });
      await mediabunnyOutput.finalize();

      const blob = new Blob([target.buffer], { type: "video/x-matroska" });
      downloadBlob(blob, `${getExportFileBaseName()}.mkv`);
      setExportStatus(
        `MKV exported with ${selectedVideoCodec.toUpperCase()} video and ${selectedAudioCodec.toUpperCase()} audio · ${(blob.size / 1048576).toFixed(1)} MB`,
        "done"
      );
      setExportProgress(100, "Export complete", {
        stage: "Complete", completedFrames: totalFrames, totalFrames, duration, currentTime: duration
      });
      exportCompleted = true;
    } else {
      const { Muxer, ArrayBufferTarget } = await loadMp4MuxerModule();
      throwIfCancelled();

      const videoConfig = await chooseSupportedAvcConfig(
        width,
        height,
        videoBitrate,
        frameRate
      );
      throwIfCancelled();

      let audioSupported = false;
      if (window.AudioEncoder && window.AudioData) {
        try {
          const audioSupport = await AudioEncoder.isConfigSupported({
            codec: "mp4a.40.2",
            sampleRate: state.decodedAudioBuffer.sampleRate,
            numberOfChannels: 2,
            bitrate: 192_000
          });
          audioSupported = Boolean(audioSupport.supported);
        } catch (error) {
          console.warn("AAC support check failed", error);
        }
      }

      const target = new ArrayBufferTarget();
      const muxer = new Muxer({
        target,
        video: { codec: "avc", width, height },
        ...(audioSupported
          ? {
              audio: {
                codec: "aac",
                sampleRate: state.decodedAudioBuffer.sampleRate,
                numberOfChannels: 2
              }
            }
          : {}),
        fastStart: "in-memory"
      });

      let encoderError = null;
      let encodedVideoFrameCount = 0;

      videoEncoder = new VideoEncoder({
        output: (chunk, metadata) => {
          encodedVideoFrameCount += 1;
          muxer.addVideoChunk(chunk, metadata);
        },
        error: (error) => {
          encoderError = error;
        }
      });
      videoEncoder.configure(videoConfig);

      registerVideoExportCancelHandler(() => {
        try {
          if (videoEncoder && videoEncoder.state === "configured") {
            videoEncoder.reset();
          }
        } catch (error) {
          console.warn("Video encoder cancellation failed", error);
        }
      });

      await renderVideoExportFrames({
        formatLabel,
        frameRate,
        totalFrames,
        duration,
        exportStart,
        exportEnd,
        width,
        height,
        addFrame: async (frameIndex) => {
          if (state.videoExportCancelled) return;
          if (encoderError) throw encoderError;

          const timing = getVideoFrameTiming(frameIndex, frameRate);
          const frame = new VideoFrame(compositeCanvas, {
            timestamp: timing.timestampUs,
            duration: timing.durationUs
          });
          videoEncoder.encode(frame, {
            keyFrame: frameIndex % Math.max(1, frameRate * 2) === 0
          });
          frame.close();

          // Keep at most one queued encode request so the browser encoder is
          // never flooded, which would produce uneven output cadence.
          await waitForEncoderQueue(videoEncoder, 1);
        }
      });

      if (state.videoExportCancelled) {
        setExportStatus("Video export cancelled.", "idle");
        return;
      }

      await videoEncoder.flush();
      if (encoderError) throw encoderError;
      if (encodedVideoFrameCount !== totalFrames) {
        throw new Error(
          `Video encoder returned ${encodedVideoFrameCount} of ${totalFrames} frames. Retry at a lower resolution or use a different browser.`
        );
      }

      let audioResult = { encoded: false, reason: "AAC unavailable." };
      if (audioSupported) {
        setExportStatus("Encoding synchronized audio… 92%", "active");
        setExportProgress(92, "Encoding audio", {
        stage: "Encoding audio", completedFrames: totalFrames, totalFrames, duration, currentTime: duration
      });
        audioResult = await encodeAudioIntoMuxer(
          muxer,
          state.decodedAudioBuffer,
          exportStart,
          exportEnd
        );
      }

      if (state.videoExportCancelled) {
        setExportStatus("Video export cancelled.", "idle");
        return;
      }

      setExportStatus("Finalizing MP4 container… 98%", "active");
      setExportProgress(98, "Finalizing MP4", {
        stage: "Finalizing file", completedFrames: totalFrames, totalFrames, duration, currentTime: duration
      });
      muxer.finalize();

      const blob = new Blob([target.buffer], { type: "video/mp4" });
      downloadBlob(blob, `${getExportFileBaseName()}.mp4`);
      setExportStatus(
        audioResult.encoded
          ? `MP4 exported with synchronized audio · ${(blob.size / 1048576).toFixed(1)} MB`
          : `MP4 exported without audio (${audioResult.reason}) · ${(blob.size / 1048576).toFixed(1)} MB`,
        "done"
      );
      setExportProgress(100, "Export complete", {
        stage: "Complete", completedFrames: totalFrames, totalFrames, duration, currentTime: duration
      });
      exportCompleted = true;
    }
  } catch (error) {
    if (state.videoExportCancelled) {
      setExportStatus("Video export cancelled.", "idle");
    } else {
      console.error("Video export failed", error);
      const message =
        error && typeof error.message === "string" ? error.message : String(error);
      const isMissingDecoderConfig =
        /decoderConfig/i.test(message) && /null|undefined|colorSpace/i.test(message);
      setExportStatus(
        isMissingDecoderConfig
          ? "VIDEO EXPORT ERROR / The browser omitted required codec metadata. In Firefox select MKV; use Chrome or Edge for MP4."
          : `VIDEO EXPORT ERROR / ${message}`,
        "error"
      );
    }
  } finally {
    try {
      if (videoEncoder && videoEncoder.state !== "closed") videoEncoder.close();
    } catch (error) {
      console.warn("Video encoder cleanup failed", error);
    }

    try {
      if (mediabunnyOutput && ["pending", "started"].includes(mediabunnyOutput.state)) {
        await mediabunnyOutput.cancel();
      }
    } catch (error) {
      console.warn("MKV output cleanup failed", error);
    }

    if (exportCompleted && exportProgressTracker?.totalFrames) {
      const elapsedWallSeconds = Math.max(0.001, (performance.now() - exportWallStart) / 1000);
      state.lastExportSecondsPerFrame = elapsedWallSeconds / exportProgressTracker.totalFrames;
    }
    exportProgressTracker = null;
    state.renderTimeOverride = null;
    state.isExportingVideo = false;
    state.videoExportCancelled = false;
    state.videoExportCancelHandlers.clear();

    elements.exportVideo.disabled = false;
    elements.exportPng.disabled = false;
    elements.exportJson.disabled = false;
    elements.importJson.disabled = false;
    elements.videoFileType.disabled = false;
    elements.videoFrameRate.disabled = false;
    elements.videoBitrate.disabled = false;
    elements.exportResolution.disabled = false;
    elements.exportVideo.textContent = "Export Video";
    elements.exportVideo.classList.remove("is-cancel");

    resizeRenderer(savedWidth, savedHeight, savedRatio);
    fitViewport();
    resetSimulation();

    if (Number.isFinite(savedTime)) {
      audio.currentTime = clamp(savedTime, 0, audio.duration || savedTime);
    }
    sampleAnalysisAtTime(audio.currentTime);
    renderFrame(0, false);
    endExportOverlay();
    updateExportEstimate();

    if (savedWasPlaying) {
      try {
        await audio.play();
        state.isPlaying = true;
      } catch (error) {
        console.warn("Playback could not resume after export", error);
      }
    }
  }
}
