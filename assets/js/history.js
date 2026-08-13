/** history.js — bounded settings undo/redo stack. */
import { PERSISTED_SETTING_KEYS } from "./config.js";
import { elements, state } from "./core.js";

const MAX_HISTORY = 80;
const undoStack = [];
const redoStack = [];
let pending = null;
let applyingHistory = false;

function snapshot() {
  const settings = {};
  PERSISTED_SETTING_KEYS.forEach((key) => {
    const value = state[key];
    settings[key] = Array.isArray(value) ? [...value] : value;
  });
  return settings;
}

function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function syncHistoryButtons() {
  if (elements.undoButton) elements.undoButton.disabled = undoStack.length === 0;
  if (elements.redoButton) elements.redoButton.disabled = redoStack.length === 0;
}

export function beginHistory(label = "Change settings") {
  if (applyingHistory || pending) return;
  pending = { label, before: snapshot() };
}

export function commitHistory(label = null) {
  if (applyingHistory || !pending) return;
  const after = snapshot();
  const entry = {
    label: label || pending.label,
    before: pending.before,
    after
  };
  pending = null;
  if (equal(entry.before, entry.after)) return;
  undoStack.push(entry);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
  syncHistoryButtons();
}

export function cancelHistory() {
  pending = null;
}

export function recordHistory(label, mutate) {
  beginHistory(label);
  try {
    mutate();
  } finally {
    commitHistory(label);
  }
}

export async function undoSettings(applySnapshot) {
  if (!undoStack.length || applyingHistory) return;
  const entry = undoStack.pop();
  applyingHistory = true;
  try {
    await applySnapshot(entry.before);
    redoStack.push(entry);
  } finally {
    applyingHistory = false;
    syncHistoryButtons();
  }
}

export async function redoSettings(applySnapshot) {
  if (!redoStack.length || applyingHistory) return;
  const entry = redoStack.pop();
  applyingHistory = true;
  try {
    await applySnapshot(entry.after);
    undoStack.push(entry);
  } finally {
    applyingHistory = false;
    syncHistoryButtons();
  }
}

export function isApplyingHistory() {
  return applyingHistory;
}
