/**
 * playback.js — transport control.
 *
 * Analysis is precomputed offline, so no AnalyserNode or MediaElementSource is
 * needed here; the <audio> element's own volume and muted properties provide
 * gain, which also removes the AudioContext resume dance on first play.
 */
import { audio, elements, state } from "./core.js";
import { clamp, formatTime } from "./utils.js";

export function applyVolume() {
  audio.volume = clamp(state.volume / 100, 0, 1);
  audio.muted = Boolean(state.muted);
}

/** The playhead the visualizer should be evaluated at. */
export function currentPlayheadTime() {
  return Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
}

export function setPlayButtonState() {
  if (state.isPlaying) {
    elements.playButton.textContent = "⏸ Pause";
    elements.playButton.className = "pause";
  } else {
    elements.playButton.textContent = "▶ Play";
    elements.playButton.className = "play";
  }
}

export async function togglePlayback() {
  if (!state.hasAudio || state.isExportingVideo) return;

  if (state.isPlaying) {
    audio.pause();
    state.isPlaying = false;
  } else {
    try {
      if (
        state.audioLoop &&
        state.loopReady &&
        state.loopEnd > state.loopStart &&
        (audio.currentTime < state.loopStart || audio.currentTime >= state.loopEnd)
      ) {
        audio.currentTime = state.loopStart;
      }
      await audio.play();
      state.isPlaying = true;
    } catch (error) {
      console.warn("Playback could not start", error);
      state.isPlaying = false;
    }
  }

  setPlayButtonState();
}

export function pausePlayback() {
  audio.pause();
  state.isPlaying = false;
  setPlayButtonState();
}

export function seekTo(seconds) {
  if (!state.hasAudio || !Number.isFinite(audio.duration)) return;
  audio.currentTime = clamp(seconds, 0, audio.duration);
}

/** Keep the transport inside the loop region while looping is enabled. */
export function enforceLoopRange() {
  if (!state.audioLoop || !state.loopReady) return;
  const { loopStart, loopEnd } = state;
  if (loopEnd <= loopStart) return;

  if (audio.currentTime >= loopEnd - 0.005) {
    audio.currentTime = loopStart;
  } else if (audio.currentTime < loopStart - 0.05) {
    audio.currentTime = loopStart;
  }
}

export function updateTransportUi() {
  if (!state.hasAudio || !Number.isFinite(audio.duration) || !audio.duration) {
    return;
  }

  const percent = (audio.currentTime / audio.duration) * 100;
  elements.progressFill.style.width = `${percent}%`;
  elements.currentTime.textContent = formatTime(audio.currentTime);
  elements.durationTime.textContent = formatTime(audio.duration);
}

export function updateLoopButtonState() {
  const duration = state.decodedAudioBuffer?.duration || audio.duration || 0;
  const active = Boolean(
    state.audioLoop &&
    state.loopEnd > state.loopStart &&
    duration > 0 &&
    state.loopEnd - state.loopStart < duration - 1e-4
  );
  audio.loop = Boolean(state.audioLoop && duration > 0 && !active);
  elements.loopButton.classList.remove("is-active");
  elements.loopButton.classList.toggle("loop-active", active);
  elements.loopButton.textContent = "Loop";
  elements.loopButton.setAttribute("aria-pressed", String(active));
}
