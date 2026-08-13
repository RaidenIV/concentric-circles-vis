/**
 * viewport.js — viewport format handling, canvas sizing and the dimensions
 * used for PNG and video export.
 */
import { exportResolutions, viewportPresets } from "./config.js";
import { elements, state } from "./core.js";
import { resizeRenderer } from "./scene.js";
import { toEvenInteger } from "./utils.js";

/** The aspect ratio the visualizer is currently composed for. */
export function getViewportAspect() {
  const preset = viewportPresets[state.viewportPreset] || viewportPresets.fill;
  if (preset.aspect) return preset.aspect;
  const width = window.innerWidth || 16;
  const height = window.innerHeight || 9;
  return width / height;
}

/** Size the on-screen canvas for the selected format. */
export function fitViewport() {
  const availableWidth = window.innerWidth;
  const availableHeight = window.innerHeight;
  const preset = viewportPresets[state.viewportPreset] || viewportPresets.fill;

  let width = availableWidth;
  let height = availableHeight;

  if (preset.aspect) {
    elements.container.classList.add("is-framed");
    if (availableWidth / availableHeight > preset.aspect) {
      height = availableHeight;
      width = height * preset.aspect;
    } else {
      width = availableWidth;
      height = width / preset.aspect;
    }
  } else {
    elements.container.classList.remove("is-framed");
  }

  width = Math.max(1, Math.floor(width));
  height = Math.max(1, Math.floor(height));

  state.cssWidth = width;
  state.cssHeight = height;
  state.pixelRatio = Math.min(window.devicePixelRatio, state.renderPixelRatioLimit || 2);

  elements.canvas.style.width = `${width}px`;
  elements.canvas.style.height = `${height}px`;

  resizeRenderer(width, height, state.pixelRatio);
}

/** Pixel dimensions for the selected export resolution and format. */
export function getExportDimensions() {
  const shortSide = exportResolutions[state.videoResolution] || 2160;
  const aspect = getViewportAspect();

  let width;
  let height;

  if (aspect >= 1) {
    height = shortSide;
    width = height * aspect;
  } else {
    width = shortSide;
    height = width / aspect;
  }

  return {
    width: toEvenInteger(width),
    height: toEvenInteger(height)
  };
}
