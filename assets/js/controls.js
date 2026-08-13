/**
 * controls.js — the Binary Tower control grammar.
 * Collapsible sections, paired slider + numeric editors with steppers,
 * toggles, selects and the colormap grid.
 */
import { COLORMAPS } from "./config.js";
import { elements, state } from "./core.js";
import { beginHistory, commitHistory } from "./history.js";

/* ---------------------------------------------------------------------------
   Collapsible sections and clusters
--------------------------------------------------------------------------- */
export function initializeCollapsibleSections() {
  document.querySelectorAll(".collapse-toggle").forEach((button) => {
    const owner = button.closest(".section, .control-cluster");
    if (!owner) return;

    const header = button.closest(".collapsible-header");
    const content = owner.querySelector(":scope > .collapsible-content");
    if (!header || !content) return;

    const title = owner.dataset.collapsibleTitle || "section";
    const titleElement = header.querySelector("h2, h3");

    let inner = content.querySelector(":scope > .collapsible-content-inner");
    if (!inner || content.children.length !== 1) {
      inner = document.createElement("div");
      inner.className = "collapsible-content-inner";
      while (content.firstChild) inner.appendChild(content.firstChild);
      content.appendChild(inner);
    }

    const updateToggleState = (isCollapsed) => {
      button.setAttribute("aria-expanded", String(!isCollapsed));
      button.setAttribute(
        "aria-label",
        `${isCollapsed ? "Expand" : "Collapse"} ${title}`
      );
      button.title = `${isCollapsed ? "Expand" : "Collapse"} ${title}`;
      button.textContent = isCollapsed ? "+" : "−";
      content.setAttribute("aria-hidden", String(isCollapsed));
      content.inert = isCollapsed;
      if (titleElement) {
        titleElement.setAttribute("aria-expanded", String(!isCollapsed));
      }
    };

    const toggleSection = () => {
      const isCollapsed = owner.classList.toggle("is-collapsed");
      updateToggleState(isCollapsed);
    };

    updateToggleState(owner.classList.contains("is-collapsed"));
    content.classList.add("is-animated");
    button.addEventListener("click", toggleSection);

    if (titleElement) {
      titleElement.setAttribute("role", "button");
      titleElement.setAttribute("tabindex", "0");
      const controls = button.getAttribute("aria-controls");
      if (controls) titleElement.setAttribute("aria-controls", controls);
      titleElement.addEventListener("click", toggleSection);
      titleElement.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggleSection();
      });
    }
  });
}

/* ---------------------------------------------------------------------------
   Numeric value editors
--------------------------------------------------------------------------- */
export function enhanceValueEditors() {
  document.querySelectorAll(".value-editor").forEach((editor) => {
    const valueInput = editor.querySelector(".value-input");
    if (!valueInput || editor.dataset.enhanced === "true") return;

    const label = valueInput.getAttribute("aria-label") || "Value";
    const suffix = editor.querySelector(".value-suffix");
    editor.classList.toggle("has-suffix", Boolean(suffix));

    const makeStepper = (text, direction) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "value-stepper";
      button.textContent = text;
      button.setAttribute(
        "aria-label",
        `${direction < 0 ? "Decrease" : "Increase"} ${label}`
      );
      button.title = button.getAttribute("aria-label");
      button.addEventListener("click", () => {
        if (valueInput.disabled) return;
        if (direction < 0) valueInput.stepDown();
        else valueInput.stepUp();
        valueInput.dispatchEvent(new Event("input", { bubbles: true }));
        valueInput.dispatchEvent(new Event("change", { bubbles: true }));
      });
      return button;
    };

    editor.appendChild(makeStepper("−", -1));
    editor.appendChild(makeStepper("+", 1));
    editor.dataset.enhanced = "true";

    valueInput.addEventListener("focus", () => {
      requestAnimationFrame(() => valueInput.select());
    });
    valueInput.addEventListener("wheel", () => valueInput.blur(), {
      passive: true
    });
  });
}

/* ---------------------------------------------------------------------------
   Binding helpers
--------------------------------------------------------------------------- */
const registry = new Map();

function precisionOf(step) {
  const text = String(step);
  return text.includes(".") ? text.split(".")[1].length : 0;
}

/** Two-way bind a range input and its numeric editor to a state key. */
export function bindRange(rangeInput, valueInput, key, onChange = () => {}) {
  const minimum = rangeInput.min === "" ? -Infinity : Number(rangeInput.min);
  const maximum = rangeInput.max === "" ? Infinity : Number(rangeInput.max);
  const step = Number(rangeInput.step) || 1;
  const precision = precisionOf(rangeInput.step || "1");

  const normalize = (raw) => {
    let value = Number(raw);
    if (!Number.isFinite(value)) return null;
    value = Math.max(minimum, Math.min(maximum, value));
    const base = Number.isFinite(minimum) ? minimum : 0;
    value = base + Math.round((value - base) / step) * step;
    value = Number(value.toFixed(precision));
    return Math.max(minimum, Math.min(maximum, value));
  };

  const apply = (raw, { silent = false } = {}) => {
    const value = normalize(raw);
    if (value === null) return;
    state[key] = value;
    rangeInput.value = String(value);
    if (valueInput) valueInput.value = String(value);
    if (!silent) onChange(value);
  };

  const label = `Change ${key}`;
  rangeInput.addEventListener("pointerdown", () => beginHistory(label));
  rangeInput.addEventListener("input", (event) => {
    beginHistory(label);
    apply(event.target.value);
  });
  rangeInput.addEventListener("change", () => commitHistory(label));
  rangeInput.addEventListener("blur", () => commitHistory(label));
  if (valueInput) {
    valueInput.addEventListener("focus", () => beginHistory(label));
    valueInput.addEventListener("change", (event) => {
      apply(event.target.value);
      commitHistory(label);
    });
    valueInput.addEventListener("input", (event) => {
      if (event.target.value === "" || event.target.value === "-") return;
      beginHistory(label);
      apply(event.target.value);
    });
    valueInput.addEventListener("blur", () => commitHistory(label));
  }

  registry.set(key, (value) => apply(value, { silent: false }));
  apply(state[key], { silent: true });
}

/** Bind a select element to a state key. */
export function bindSelect(selectElement, key, onChange = () => {}, cast = String) {
  const apply = (raw, { silent = false } = {}) => {
    const value = cast(raw);
    state[key] = value;
    selectElement.value = String(raw);
    if (!silent) onChange(value);
  };

  selectElement.addEventListener("change", (event) => {
    const label = `Change ${key}`;
    beginHistory(label);
    apply(event.target.value);
    commitHistory(label);
  });
  registry.set(key, (value) => apply(value));
  apply(state[key], { silent: true });
}

/** Bind a checkbox to a boolean state key. */
export function bindToggle(checkbox, key, onChange = () => {}) {
  const apply = (raw, { silent = false } = {}) => {
    const value = Boolean(raw);
    state[key] = value;
    checkbox.checked = value;
    if (!silent) onChange(value);
  };

  checkbox.addEventListener("change", (event) => {
    const label = `Change ${key}`;
    beginHistory(label);
    apply(event.target.checked);
    commitHistory(label);
  });
  registry.set(key, (value) => apply(value));
  apply(state[key], { silent: true });
}

/** Push a value through the control bound to `key`, firing its side effects. */
export function setControlValue(key, value) {
  const setter = registry.get(key);
  if (setter) setter(value);
  else state[key] = value;
}

export function hasControl(key) {
  return registry.has(key);
}

/* ---------------------------------------------------------------------------
   Colormap grid
--------------------------------------------------------------------------- */
export function buildColormapGrid() {
  const grid = elements.cmapGrid;
  const autoButton = grid.querySelector('[data-cmap="auto"]');

  COLORMAPS.forEach((colormap, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cmap-btn";
    button.textContent = colormap.name;
    button.dataset.cmap = String(index);
    button.addEventListener("click", () => selectColormap(index));
    grid.appendChild(button);
  });

  autoButton.addEventListener("click", () => selectColormap(-1));
  syncColormapButtons();
}

export function selectColormap(index) {
  beginHistory("Change colormap");
  state.lockedCmapIndex = index;
  syncColormapButtons();
  commitHistory("Change colormap");
}

export function syncColormapButtons() {
  const grid = elements.cmapGrid;
  grid.querySelectorAll(".cmap-btn").forEach((button) => {
    button.classList.remove("active", "auto-active");
  });

  if (state.lockedCmapIndex < 0) {
    grid.querySelector('[data-cmap="auto"]').classList.add("auto-active");
    return;
  }

  const target = grid.querySelector(
    `[data-cmap="${state.lockedCmapIndex}"]`
  );
  if (target) target.classList.add("active");
}

/** The original collapsed-by-default colormap disclosure row. */
export function initializeColormapDisclosure() {
  elements.cmapBody.classList.add("collapsed");
  elements.cmapToggleRow.addEventListener("click", () => {
    const isCollapsed = elements.cmapBody.classList.toggle("collapsed");
    elements.cmapArrow.classList.toggle("open", !isCollapsed);
  });
}

/* ---------------------------------------------------------------------------
   Panel minimize
--------------------------------------------------------------------------- */
export function initializePanelToggle() {
  elements.minimize.addEventListener("click", () => {
    state.panelCollapsed = elements.panel.classList.toggle("collapsed");
    elements.minimize.textContent = state.panelCollapsed ? "+" : "−";
  });
}
