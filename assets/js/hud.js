/** hud.js — shared technical HUD for preview, PNG and video export. */
import { FREQ_BANDS, viewportPresets } from "./config.js";
import { audio, elements, state } from "./core.js";
import { formatTime } from "./utils.js";

const HUD_FONT = "Rajdhani, sans-serif";
// Sizing reference. At a 1080-pixel short side and hudScale 1, every derived
// value below reproduces the previous absolute-pixel layout exactly.
const HUD_REFERENCE_HEIGHT = 1080;

function titleCase(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}


function getViewportLabel() {
  return viewportPresets[state.viewportPreset]?.label || "Fill Window";
}

function drawCornerTicks(context, width, height, inset, tick) {
  const right = width - inset;
  const bottom = height - inset;
  context.beginPath();
  context.moveTo(inset, inset + tick); context.lineTo(inset, inset); context.lineTo(inset + tick, inset);
  context.moveTo(right - tick, inset); context.lineTo(right, inset); context.lineTo(right, inset + tick);
  context.moveTo(inset, bottom - tick); context.lineTo(inset, bottom); context.lineTo(inset + tick, bottom);
  context.moveTo(right - tick, bottom); context.lineTo(right, bottom); context.lineTo(right, bottom - tick);
  context.stroke();
}

function drawSpectralPanel(context, x, bottom, width, scale) {
  const rowHeight = 11.5 * scale;
  const headerHeight = 17 * scale;
  const labelWidth = 62 * scale;
  const valueWidth = 28 * scale;
  const gap = 7 * scale;
  const meterWidth = Math.max(42 * scale, width - labelWidth - valueWidth - gap);
  const top = bottom - headerHeight - FREQ_BANDS.length * rowHeight;

  context.save();
  context.textBaseline = "top";
  context.textAlign = "left";
  context.font = `600 ${Math.max(8, 8.5 * scale)}px ${HUD_FONT}`;
  context.fillStyle = "rgba(255,255,255,0.78)";
  context.fillText("SPECTRAL BANDS", x, top);
  context.fillStyle = "rgba(255,255,255,0.28)";
  context.fillRect(x, top + 12 * scale, width, Math.max(1, scale));

  context.font = `${Math.max(7.5, 8 * scale)}px ${HUD_FONT}`;
  context.textBaseline = "middle";
  FREQ_BANDS.forEach((band, index) => {
    const value = Math.max(0, Math.min(1, state.magnitudes[index] || 0));
    const rowY = top + headerHeight + index * rowHeight;
    const centerY = rowY + rowHeight * 0.5;
    const barX = x + labelWidth;
    const barY = centerY - Math.max(1, 1.75 * scale);
    const barHeight = Math.max(2, 3.5 * scale);

    context.textAlign = "left";
    context.fillStyle = "rgba(255,255,255,0.58)";
    context.fillText(band.name.toUpperCase(), x, centerY);

    context.fillStyle = "rgba(255,255,255,0.11)";
    context.fillRect(barX, barY, meterWidth, barHeight);
    context.fillStyle = "rgba(255,255,255,0.78)";
    context.fillRect(barX, barY, meterWidth * value, barHeight);

    context.textAlign = "right";
    context.fillStyle = "rgba(255,255,255,0.48)";
    context.fillText(`${Math.round(value * 100)}%`, x + width, centerY);
  });
  context.restore();
}

function drawBottomRightStatus(context, width, height, contentInset, scale, opacity) {
  const blockWidth = Math.min(width * 0.30, 230 * scale);
  const right = width - contentInset;
  const left = right - blockWidth;
  const bottom = height - contentInset;
  const headerHeight = 17 * scale;
  const rowHeight = 17 * scale;
  const footerHeight = 24 * scale;
  const top = bottom - headerHeight - rowHeight * 3 - footerHeight;
  const barHeight = Math.max(2, 3.5 * scale);
  const energy = Math.max(0, Math.min(1, Number(state.spectralEnergy) || 0));
  const centroid = Math.max(0, Math.min(1, Number(state.spectralCentroid) || 0.5));
  const ringResponse = Math.max(0, Math.min(1,
    (Number(state.lowFreqMagnitude) || 0) * (Number(state.reactivity) || 100) / 100
  ));

  const rows = [
    ["MASTER ENERGY", energy, `${Math.round(energy * 100)}%`],
    ["CENTROID", centroid, `${Math.round(centroid * 100)}%`],
    ["RING RESPONSE", ringResponse, `${Math.round(ringResponse * 100)}%`]
  ];

  context.save();
  context.globalAlpha = opacity;
  context.textBaseline = "top";
  context.textAlign = "right";
  context.font = `600 ${Math.max(8, 8.5 * scale)}px ${HUD_FONT}`;
  context.fillStyle = "rgba(255,255,255,0.78)";
  context.fillText("SYSTEM OUTPUT", right, top);
  context.fillStyle = "rgba(255,255,255,0.28)";
  context.fillRect(left, top + 12 * scale, blockWidth, Math.max(1, scale));

  rows.forEach(([label, value, display], index) => {
    const rowTop = top + headerHeight + index * rowHeight;
    context.font = `${Math.max(7.5, 8 * scale)}px ${HUD_FONT}`;
    context.textBaseline = "top";
    context.textAlign = "left";
    context.fillStyle = "rgba(255,255,255,0.58)";
    context.fillText(label, left, rowTop);
    context.textAlign = "right";
    context.fillStyle = "rgba(255,255,255,0.52)";
    context.fillText(display, right, rowTop);

    const barY = rowTop + 10 * scale;
    context.fillStyle = "rgba(255,255,255,0.11)";
    context.fillRect(left, barY, blockWidth, barHeight);
    context.fillStyle = "rgba(255,255,255,0.78)";
    context.fillRect(left, barY, blockWidth * value, barHeight);
  });

  const footerTop = top + headerHeight + rowHeight * 3 + 2 * scale;
  context.font = `600 ${Math.max(7.5, 8 * scale)}px ${HUD_FONT}`;
  context.textAlign = "right";
  context.fillStyle = "rgba(255,255,255,0.48)";
  context.fillText(
    `FFT ${Number(state.fftSize).toLocaleString()}  /  SIZE ${Math.round(state.sphereSize)}%`,
    right,
    footerTop
  );
  context.fillText(
    `QUALITY ${titleCase(state.qualityPreset)}  /  ${getViewportLabel().toUpperCase()}`,
    right,
    footerTop + 10 * scale
  );
  context.restore();
}

export function drawHud(context, width, height) {
  if (!state.hudEnabled || !context || width <= 0 || height <= 0) return;

  const userScale = Math.max(0.5, Math.min(2, Number(state.hudScale) || 1));
  // Everything below is expressed in units of `scale`, which folds in the
  // output resolution. Previously `inset` and `fontSize` scaled with the frame
  // while `tick`, `lineWidth` and every constant in drawMeters() were absolute
  // pixels, so a 4K export drew the same HUD chrome as a 1080p preview at a
  // third the relative size, with hairline strokes. This function is shared by
  // preview, PNG and video precisely so they match.
  const scale = userScale * (Math.min(width, height) / HUD_REFERENCE_HEIGHT);
  const opacity = Math.max(0, Math.min(1, Number(state.hudOpacity) || 0));
  const frameInset = Math.max(16, 22 * scale);
  const tick = 18 * scale;
  // Keep all HUD content beyond the corner tick footprint. Previously text and
  // meters began on the exact same inset used by the technical frame, so the
  // top-left title, top-right status and bottom-left meters intersected it.
  const contentInset = frameInset + tick + Math.max(6, 6 * scale);
  const fontSize = Math.max(9, 12.96 * scale);
  const lineHeight = fontSize * 1.32;

  context.save();
  context.globalAlpha *= opacity;
  context.strokeStyle = "rgba(255,255,255,0.46)";
  context.lineWidth = Math.max(1, scale);

  drawCornerTicks(context, width, height, frameInset, tick);

  context.font = `600 ${fontSize}px ${HUD_FONT}`;
  context.textBaseline = "top";
  context.fillStyle = "rgba(255,255,255,0.84)";

  const fileName = state.fileName || "NO AUDIO LOADED";
  const current = state.hasAudio
    ? (Number.isFinite(state.renderTimeOverride) ? state.renderTimeOverride : audio.currentTime)
    : 0;
  const duration = state.decodedAudioBuffer?.duration || audio.duration || 0;
  const leftLines = [
    "CONCENTRIC SPHERE VISUALIZER / SYSTEM HUD",
    fileName,
    `${state.isExportingVideo ? "EXPORT" : state.isPlaying ? "PLAY" : "PAUSE"}  ${formatTime(current)} / ${formatTime(duration)}`,
    `RINGS ${Math.round(state.ringCount)}  /  CAMERA ${titleCase(state.cameraPreset)}`,
    `AMPLITUDE ${titleCase(state.amplitudeMode)}  /  ${getViewportLabel()}`
  ];

  leftLines.forEach((line, index) => {
    context.globalAlpha = opacity * (index === 0 ? 1 : 0.76);
    context.fillText(line, contentInset, contentInset + index * lineHeight);
  });

  context.globalAlpha = opacity;
  context.textAlign = "right";
  const rightLines = [
    `${Math.round(state.previewFps || 0)} FPS`,
    `AZ ${Math.round(state.cameraAzimuth)}° / EL ${Math.round(state.cameraElevation)}°`,
    `CENTROID ${Math.round((state.spectralCentroid || 0.5) * 100)}%`,
    `RADIUS ${Number(state.sphereRadius).toFixed(2)}×`
  ];
  rightLines.forEach((line, index) => {
    context.fillStyle = index === 0 ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.66)";
    context.fillText(line, width - contentInset, contentInset + index * lineHeight);
  });
  context.textAlign = "left";

  const bottomPanelWidth = Math.min(width * 0.30, 230 * scale);
  drawSpectralPanel(
    context,
    contentInset,
    height - contentInset,
    bottomPanelWidth,
    scale
  );

  drawBottomRightStatus(context, width, height, contentInset, scale, opacity);

  context.restore();
}

export function renderHudPreview() {
  const hudCanvas = elements.hudCanvas;
  if (!hudCanvas) return;

  if (!state.hudEnabled) {
    hudCanvas.hidden = true;
    return;
  }
  hudCanvas.hidden = false;

  const rect = elements.canvas.getBoundingClientRect();
  const ratio = Math.max(1, state.pixelRatio || 1);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));

  if (hudCanvas.width !== width || hudCanvas.height !== height) {
    hudCanvas.width = width;
    hudCanvas.height = height;
  }
  hudCanvas.style.left = `${rect.left}px`;
  hudCanvas.style.top = `${rect.top}px`;
  hudCanvas.style.width = `${rect.width}px`;
  hudCanvas.style.height = `${rect.height}px`;

  const context = hudCanvas.getContext("2d");
  context.clearRect(0, 0, width, height);
  drawHud(context, width, height);
}
