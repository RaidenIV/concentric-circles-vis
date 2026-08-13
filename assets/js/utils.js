/** utils.js — pure helpers shared by every module. */

export function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

export function formatPreciseTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}:${remaining.toFixed(3).padStart(6, "0")}`;
}

export function sanitizeFileName(name) {
  const cleaned = String(name || "")
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "particle-visualizer";
}

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function nextEventLoopTurn() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

/** Sample a colormap definition at t in [0, 1]. */
export function sampleColormap(stops, t) {
  t = clamp(t, 0, 1);
  for (let index = 0; index < stops.length - 1; index += 1) {
    const [t0, c0] = stops[index];
    const [t1, c1] = stops[index + 1];
    if (t >= t0 && t <= t1) {
      const u = (t - t0) / Math.max(1e-6, t1 - t0);
      return [
        c0[0] + (c1[0] - c0[0]) * u,
        c0[1] + (c1[1] - c0[1]) * u,
        c0[2] + (c1[2] - c0[2]) * u
      ];
    }
  }
  return stops[stops.length - 1][1];
}

/** Round to an even integer — required by most video encoders. */
export function toEvenInteger(value) {
  return Math.max(2, Math.round(value / 2) * 2);
}
