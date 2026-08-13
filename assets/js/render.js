/**
 * render.js — one deterministic frame of the visualizer.
 *
 * Both the preview loop and the video export loop call renderFrame() with an
 * explicit delta time, so the exported file matches what is on screen. The
 * simulation itself advances in fixed 0.016 s sub-steps, which is what the
 * original build did implicitly at 60 fps; the accumulator keeps that cadence
 * identical at 24, 30 or 60 fps export.
 */
import { COLORMAPS, engine } from "./config.js";
import { state } from "./core.js";
import {
  copyParticleWithJitter,
  getMorphBlend,
  particles,
  reseedParticles,
  resetTrails,
  sampleTrails,
  seedAttractorPoint,
  spawnFromManifold,
  trails
} from "./particles.js";
import {
  camera,
  particleGeometry,
  particleMaterial,
  particleSystem,
  renderScene,
  swarm,
  bloomPass,
  trailBuffers,
  trailGeometry,
  trailMaterial,
  trailSystem,
  SPHERE_RING_COUNT,
  configureSphereRingLayout,
  sphereRingMaterial,
  sphereRingSystem
} from "./scene.js";
import { clamp, sampleColormap } from "./utils.js";

const {
  BASE_FRAME_TIME,
  BEAT_HISTORY,
  BEAT_COOLDOWN_FRAMES,
  FLASH_DURATION,
  RENDER_SCALE,
  PARTICLE_POOL,
  ATTRACTOR_PREWARM_BURN_IN,
  BEAT_IMPULSE_DECAY
} = engine;

// Matches the PerspectiveCamera constructed in scene.js.
const BASE_CAMERA_FOV = 75;
const MAX_CAMERA_FOV = 110;

let simulationAccumulator = 0;
let flashPhase = 1;
let smoothedAttractorEnergy = 0;
// Running peak of attractor particle speed, used to normalize speed-based
// colour. Fast attack so a burst registers immediately, slow release so the
// palette does not breathe between phrases.
let attractorSpeedReference = 1;
let previousActiveCount = 0;
// Short decaying kick on top of the smoothed loudness envelope. The envelope's
// 320 ms release deliberately suppresses per-hit chatter, which also makes
// individual beats invisible; this restores them without destabilising shape.
let beatImpulse = 0;
// Vertical FOV actually pushed to the camera, tracked so updateProjectionMatrix
// is only called when the framing genuinely changes.
let appliedCameraFov = BASE_CAMERA_FOV;

const ATTRACTOR_TYPES = new Set([
  "lorenz",
  "rossler",
  "halvorsen",
  "aizawa",
  "thomas",
  "dadras"
]);

// Concentric Sphere is a structural particle layout rather than a force-field
// simulation. Each particle belongs to one of these circular cross-sections;
// taken together, the rings describe the surface of a sphere.
const CONCENTRIC_SPHERE_RING_COUNT = SPHERE_RING_COUNT;
const CONCENTRIC_SPHERE_GOLDEN_OFFSET = 0.6180339887498949;
const CONCENTRIC_SPHERE_PHASES = new Float32Array(PARTICLE_POOL);

function radicalInverseBase2(value) {
  let result = 0;
  let fraction = 0.5;
  let remaining = value >>> 0;
  while (remaining > 0) {
    result += (remaining & 1) * fraction;
    remaining >>>= 1;
    fraction *= 0.5;
  }
  return result;
}

for (let index = 0; index < PARTICLE_POOL; index += 1) {
  const ringIndex = index % CONCENTRIC_SPHERE_RING_COUNT;
  const pointIndex = Math.floor(index / CONCENTRIC_SPHERE_RING_COUNT);
  CONCENTRIC_SPHERE_PHASES[index] =
    (radicalInverseBase2(pointIndex) +
      ringIndex * CONCENTRIC_SPHERE_GOLDEN_OFFSET) % 1;
}

// Display-only rotations chosen so each attractor presents its characteristic
// structure to the default front camera. Simulation coordinates are untouched.
const ATTRACTOR_ORIENTATION = Object.freeze({
  lorenz: [-Math.PI / 2, 0, 0],
  rossler: [-0.22, 0.08, 0],
  halvorsen: [-0.48, 0.62, 0],
  aizawa: [-0.34, 0.12, 0],
  thomas: [-0.5, 0.62, 0],
  dadras: [-1.22, 0.18, 0]
});

// Morph/attractors has no single field to seed from; Lorenz is the basin used
// for the initial blob because it is the first entry in the morph rotation.
const ATTRACTOR_SEED_MORPH_TYPE = "lorenz";

state.beatHistory = new Float32Array(BEAT_HISTORY);

/** Clear all time-varying simulation state. */
export function resetSimulation() {
  simulationAccumulator = 0;
  flashPhase = 1;
  state.time = 0;
  state.cmapA = 0;
  state.cmapB = 1;
  state.cmapMix = 0;
  state.smoothedBloom = 0.55;
  state.activeCount = state.minParticles;
  state.beatHistory.fill(0);
  state.beatHistoryIndex = 0;
  state.beatCooldown = 0;
  state.flashAlpha = 0;
  state.cameraFollowAzimuth = 0;
  smoothedAttractorEnergy = 0;
  attractorSpeedReference = 1;
  previousActiveCount = 0;
  beatImpulse = 0;
  appliedCameraFov = BASE_CAMERA_FOV;
  camera.fov = BASE_CAMERA_FOV;
  camera.updateProjectionMatrix();
  resetTrails();
}

function triggerBeatFlash() {
  if (!state.beatFlashEnabled) return;
  flashPhase = 0;
}

function advanceFlash(deltaTime) {
  if (flashPhase >= 1) {
    state.flashAlpha = 0;
    return;
  }
  flashPhase = Math.min(1, flashPhase + deltaTime / FLASH_DURATION);
  // Matches the original CSS keyframes: rise to full at 8%, then fall to 0.
  const curve =
    flashPhase < 0.08 ? flashPhase / 0.08 : 1 - (flashPhase - 0.08) / 0.92;
  state.flashAlpha =
    clamp(curve, 0, 1) * (state.beatFlashIntensity / 100);
}

function detectBeat(magnitudes, reactivity) {
  const bassEnergy = magnitudes[0] * 0.5 + magnitudes[1] * 0.5;
  state.beatHistory[state.beatHistoryIndex] = bassEnergy;
  state.beatHistoryIndex = (state.beatHistoryIndex + 1) % BEAT_HISTORY;

  let sum = 0;
  for (let index = 0; index < BEAT_HISTORY; index += 1) {
    sum += state.beatHistory[index];
  }
  const average = sum / BEAT_HISTORY;
  const threshold = average * (state.beatSensitivity - reactivity * 0.1);

  state.beatCooldown = Math.max(0, state.beatCooldown - 1);
  if (bassEnergy > threshold && bassEnergy > 0.25 && state.beatCooldown === 0) {
    triggerBeatFlash();
    // Deliberately not gated on beatFlashEnabled: turning off the white flash
    // is not a request to turn off beat-reactive motion.
    beatImpulse = 1;
    state.beatCooldown = BEAT_COOLDOWN_FRAMES;
  }
}

const IDENTITY_QUATERNION = Object.freeze([0, 0, 0, 1]);
const ORIENTATION_QUATERNIONS = (() => {
  const table = {};
  for (const [type, euler] of Object.entries(ATTRACTOR_ORIENTATION)) {
    table[type] = eulerToQuaternion(euler[0], euler[1], euler[2]);
  }
  return Object.freeze(table);
})();

// Reusable buffers — the display rotation is recomputed once per frame.
const DISPLAY_QUATERNION = new Float64Array(4);
const SLERP_A = new Float64Array(4);
const SLERP_B = new Float64Array(4);
// Morph blends several systems with different natural centroids. Keep the
// *presentation* anchored without altering simulation coordinates.
const DISPLAY_CENTER = new Float64Array(3);

/**
 * Euler triple to quaternion, matching the order the display rotation is
 * applied in: about X, then Y, then Z, i.e. R = Rz·Ry·Rx, so q = qz·qy·qx.
 */
function eulerToQuaternion(rotationX, rotationY, rotationZ) {
  const halfX = rotationX * 0.5;
  const halfY = rotationY * 0.5;
  const halfZ = rotationZ * 0.5;
  const sinX = Math.sin(halfX);
  const cosX = Math.cos(halfX);
  const sinY = Math.sin(halfY);
  const cosY = Math.cos(halfY);
  const sinZ = Math.sin(halfZ);
  const cosZ = Math.cos(halfZ);

  return [
    sinX * cosY * cosZ - cosX * sinY * sinZ,
    cosX * sinY * cosZ + sinX * cosY * sinZ,
    cosX * cosY * sinZ - sinX * sinY * cosZ,
    cosX * cosY * cosZ + sinX * sinY * sinZ
  ];
}

function copyQuaternion(output, source) {
  output[0] = source[0];
  output[1] = source[1];
  output[2] = source[2];
  output[3] = source[3];
}

/** Shortest-arc slerp. Component-wise lerp of Euler angles tumbles on wrap. */
function slerpQuaternion(output, a, b, t) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bx = b[0];
  let by = b[1];
  let bz = b[2];
  let bw = b[3];

  // Negate one end when the dot product is negative, or the interpolation
  // takes the long way round and the whole visualization visibly tumbles.
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }

  let weightA;
  let weightB;
  if (dot > 0.9995) {
    // Nearly parallel — slerp is numerically unstable here, and a plain lerp
    // is indistinguishable at this angle.
    weightA = 1 - t;
    weightB = t;
  } else {
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    weightA = Math.sin((1 - t) * theta) / sinTheta;
    weightB = Math.sin(t * theta) / sinTheta;
  }

  let x = a[0] * weightA + bx * weightB;
  let y = a[1] * weightA + by * weightB;
  let z = a[2] * weightA + bz * weightB;
  let w = a[3] * weightA + bw * weightB;

  const length = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
  output[0] = x / length;
  output[1] = y / length;
  output[2] = z / length;
  output[3] = w / length;
}

/**
 * Resolve the display rotation for the current frame into DISPLAY_QUATERNION.
 *
 * Morph previously received no rotation at all, because ATTRACTOR_ORIENTATION
 * has no "morph" key — so every attractor was presented in raw simulation
 * coordinates, which is close to edge-on for Lorenz.
 */
function updateDisplayQuaternion() {
  if (state.boidType !== "morph") {
    copyQuaternion(
      DISPLAY_QUATERNION,
      ORIENTATION_QUATERNIONS[state.boidType] || IDENTITY_QUATERNION
    );
    return;
  }

  const blend = getMorphBlend(state.morphScope, state.time, state.morphSpeed);
  // Boid members of the rotation contribute identity, so morphing from a boid
  // simulation into an attractor rotates the presentation in smoothly.
  copyQuaternion(
    SLERP_A,
    ORIENTATION_QUATERNIONS[blend.typeA] || IDENTITY_QUATERNION
  );
  copyQuaternion(
    SLERP_B,
    ORIENTATION_QUATERNIONS[blend.typeB] || IDENTITY_QUATERNION
  );
  slerpQuaternion(DISPLAY_QUATERNION, SLERP_A, SLERP_B, blend.mix);
}

/** True when the current selection runs the chaotic-attractor integrator. */
function isAttractorMode() {
  return (
    ATTRACTOR_TYPES.has(state.boidType) ||
    (state.boidType === "morph" && state.morphScope === "attractors")
  );
}

/** The movement descriptor handed to Particle.update(). */
function buildMovement(audioMagnitude) {
  return {
    type: state.boidType,
    morphScope: state.morphScope,
    morphSpeed: state.morphSpeed,
    speed: state.movementSpeed,
    amount: state.movementAmount / 100,
    alignment: state.boidAlignment / 100,
    cohesion: state.boidCohesion / 100,
    separation: state.boidSeparation / 100,
    audioMagnitude,
    traversalFloor: state.traversalFloor,
    traversalRange: state.traversalRange,
    traversalCurve: state.traversalCurve,
    beatTraversalBoost: state.beatTraversalBoost / 100,
    beatImpulse
  };
}

/**
 * Walk one leader particle from the seed point and drop the rest of the pool
 * along its path, so every particle starts exactly on the manifold and the
 * attractor is fully formed on the first visible frame.
 *
 * Letting a blob spread on its own is prettier in principle, but it only works
 * where the leading Lyapunov exponent is large. Rossler, Aizawa and Thomas
 * diverge roughly an order of magnitude more slowly than Lorenz and would sit
 * as a bright dot for the better part of a minute. Distributing by arc-time
 * gives the same on-manifold result immediately, for every attractor, and costs
 * one particle's worth of integration instead of the whole pool's.
 */
function prewarmAttractor(boundary) {
  const count = Math.max(1, Math.min(state.maxParticles, PARTICLE_POOL));
  // Neutral descriptor. buildMovement() closes over the live beat impulse, and
  // re-seeding while a beat is still ringing would otherwise warm the leader at
  // a boosted traversal and produce a different manifold each time.
  const movement = { ...buildMovement(0.35), beatImpulse: 0 };
  const noiseScale = state.noiseScale * 0.5;
  const jitter = boundary * 0.006;
  const leader = particles[0];
  let time = 0;

  const stepLeader = () => {
    time += BASE_FRAME_TIME;
    leader.update(
      0,
      particles,
      1,
      time,
      0.35,
      noiseScale,
      boundary,
      state.damping,
      movement
    );
  };

  // Burn-in: get the leader off the seed point and onto the attractor.
  for (let step = 0; step < ATTRACTOR_PREWARM_BURN_IN; step += 1) {
    stepLeader();
  }

  // Then one further step per particle, laying the pool down along the path.
  for (let index = 1; index < count; index += 1) {
    stepLeader();
    copyParticleWithJitter(index, leader, jitter);
  }

  // History accumulated during the warm-up would draw as one long streak.
  resetTrails();
}

/**
 * Re-seed the pool for whatever simulation is selected. Attractor modes get a
 * seed point plus a leader-path pre-warm, so they open as a formed manifold.
 * Every other mode keeps the original uniform sphere seeding exactly.
 */
export function reseedForCurrentMode() {
  const boundary = state.sphereBoundary;
  previousActiveCount = 0;
  beatImpulse = 0;

  if (state.boidType === "sphereRings") {
    seedConcentricSphere(boundary);
    resetTrails();
    return;
  }

  if (!isAttractorMode()) {
    reseedParticles(boundary);
    resetTrails();
    return;
  }

  const type =
    state.boidType === "morph" ? ATTRACTOR_SEED_MORPH_TYPE : state.boidType;
  seedAttractorPoint(boundary, type);
  prewarmAttractor(boundary);
}

/* ---------------------------------------------------------------------------
   Colormap lookup table

   sampleColormap() was called twice per particle per sub-step, each call
   allocating a fresh array — 1.86 ms and 12 M allocations per frame at 20 000
   particles. The A/B blend and brightness are per-frame constants, so they fold
   into a table built once per sub-step and indexed instead.

   Lookup is interpolated rather than nearest: quantisation steps can band
   across the large smooth gradients this visualizer produces, and lerping
   between adjacent entries costs a handful of operations.

   512 entries rather than 256: it halves the worst-case channel error to
   0.24/255 — under one 8-bit quantisation step, which matters because bloom
   multiplies whatever error survives — for 0.02 ms more per sub-step.
--------------------------------------------------------------------------- */
const COLOR_LUT_SIZE = 512;
const COLOR_LUT_MAX = COLOR_LUT_SIZE - 1;
const colorLut = new Float32Array(COLOR_LUT_SIZE * 3);

/**
 * Place one particle on a circular cross-section of a sphere. The rings are
 * perpendicular to the local Z axis, then the complete structure is tilted so
 * the default camera immediately reads it as a three-dimensional sphere.
 *
 * A base-2 radical-inverse sequence means every prefix of the particle pool is
 * distributed around each circle instead of filling it from one side. That
 * keeps the rings complete while the audio-reactive particle count changes.
 */
function writeConcentricSpherePoint(
  output,
  ringIndex,
  angle,
  boundary,
  audioMagnitude,
  movement
) {
  const visibleRingCount = Math.max(1, Math.round(state.ringCount || 100));
  const ringT = (ringIndex + 0.5) / visibleRingCount;
  const depth = ringT * 2 - 1;
  const sphereCrossSection = Math.sqrt(Math.max(0, 1 - depth * depth));
  const reactivity = state.reactivity / 100;
  const bandCount = Math.max(1, state.magnitudes.length);
  const bandMagnitude = Number(state.magnitudes[ringIndex % bandCount]) || 0;
  const movementAmount = Math.max(0, state.rotationAmount / 100);
  const movementSpeed = Math.max(0, state.rotationSpeed);

  // Bass expands the complete sphere, while each spectral band expands one
  // complete circular slice. The radius changes as a unit, so the geometry
  // remains a true circle instead of turning into a noisy particle waveform.
  const spherePulse =
    1 + audioMagnitude * 0.22 * reactivity + beatImpulse * 0.055;
  const ringPulse = 1 + bandMagnitude * 0.22 * reactivity;
  const radius = Math.max(1e-6, boundary) * spherePulse;
  const crossSectionRadius = radius * sphereCrossSection * ringPulse;

  let x = Math.cos(angle) * crossSectionRadius;
  let y = Math.sin(angle) * crossSectionRadius;
  let z = depth * radius * (1 + audioMagnitude * 0.08 * reactivity);

  // Present the stack obliquely so the depth between the concentric circles is
  // visible immediately. Movement controls rotate the complete ring stack as a
  // rigid object; they never distort the individual circles.
  const rotationX = 0.42;
  const rotationY =
    -0.38 +
    state.time * 0.12 * movementSpeed * movementAmount +
    Math.sin(state.time * 0.16 * movementSpeed) * 0.08 * movementAmount;
  const cosX = Math.cos(rotationX);
  const sinX = Math.sin(rotationX);
  const cosY = Math.cos(rotationY);
  const sinY = Math.sin(rotationY);

  const rotatedY = y * cosX - z * sinX;
  const rotatedZ = y * sinX + z * cosX;
  const rotatedX = x * cosY + rotatedZ * sinY;

  output[0] = rotatedX;
  output[1] = rotatedY;
  output[2] = -x * sinY + rotatedZ * cosY;
}

function writeConcentricSphereParticle(
  particle,
  index,
  boundary,
  audioMagnitude,
  movement
) {
  const ringIndex = index % CONCENTRIC_SPHERE_RING_COUNT;
  const spin = state.time * 0.28 * Math.max(0, movement.speed) * Math.max(0, movement.amount);
  const angle = CONCENTRIC_SPHERE_PHASES[index] * Math.PI * 2 + spin;
  writeConcentricSpherePoint(
    DISPLAY_POINT,
    ringIndex,
    angle,
    boundary,
    audioMagnitude,
    movement
  );
  particle.positionX = DISPLAY_POINT[0];
  particle.positionY = DISPLAY_POINT[1];
  particle.positionZ = DISPLAY_POINT[2];
  particle.velocityX = 0;
  particle.velocityY = 0;
  particle.velocityZ = 0;
}

function concentricSphereColorPosition(index) {
  return (index % CONCENTRIC_SPHERE_RING_COUNT) /
    Math.max(1, CONCENTRIC_SPHERE_RING_COUNT - 1);
}

function seedConcentricSphere(boundary) {
  const count = Math.max(
    1,
    Math.min(state.activeCount || state.minParticles, PARTICLE_POOL)
  );
  const movement = buildMovement(0);
  for (let index = 0; index < count; index += 1) {
    const particle = particles[index];
    writeConcentricSphereParticle(particle, index, boundary, 0, movement);
    particle.colorR = 1;
    particle.colorG = 1;
    particle.colorB = 1;
  }
}

function buildColorLut(stopsA, stopsB, mix, brightness) {
  for (let index = 0; index < COLOR_LUT_SIZE; index += 1) {
    const t = index / COLOR_LUT_MAX;
    const colorA = sampleColormap(stopsA, t);
    const colorB = sampleColormap(stopsB, t);
    const offset = index * 3;
    colorLut[offset] =
      (colorA[0] + (colorB[0] - colorA[0]) * mix) * brightness;
    colorLut[offset + 1] =
      (colorA[1] + (colorB[1] - colorA[1]) * mix) * brightness;
    colorLut[offset + 2] =
      (colorA[2] + (colorB[2] - colorA[2]) * mix) * brightness;
  }
}

const DISPLAY_POINT = new Float64Array(3);

/**
 * Rotate a simulation-space point into display space. Trails multiply the
 * number of transformed points per frame, so this allocates nothing.
 *
 * Rotating by the identity quaternion is exact, so modes with no orientation
 * pass through unchanged.
 */
function writeDisplayPoint(output, x, y, z, quaternion) {
  const qx = quaternion[0];
  const qy = quaternion[1];
  const qz = quaternion[2];
  const qw = quaternion[3];

  // t = 2 * (q_vec x v);  v' = v + qw * t + (q_vec x t)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);

  output[0] = x + qw * tx + qy * tz - qz * ty;
  output[1] = y + qw * ty + qz * tx - qx * tz;
  output[2] = z + qw * tz + qx * ty - qy * tx;
}

/**
 * Format-aware composition scale. The user-facing Visualization Size remains
 * the artistic base value; this multiplier only compensates for the available
 * horizontal/vertical field of view of each output format. Preview and export
 * both use camera.aspect, so framing is identical in both paths.
 */
function getViewportVisualizationMultiplier() {
  switch (state.viewportPreset) {
    case "landscape":
      return 1.0;
    case "square":
      return 0.86;
    case "portrait":
      return 0.62;
    default: {
      // Fill Window follows the actual current aspect rather than a fixed
      // preset. Interpolate smoothly between the tested portrait/square/
      // landscape compositions so resizing the browser does not jump in size.
      const aspect = Math.max(0.4, Math.min(2.4, camera.aspect || 1));
      if (aspect >= 1) {
        const t = Math.max(0, Math.min(1, (aspect - 1) / ((16 / 9) - 1)));
        return 0.86 + (1.0 - 0.86) * t;
      }
      const portraitAspect = 9 / 16;
      const t = Math.max(0, Math.min(1, (aspect - portraitAspect) / (1 - portraitAspect)));
      return 0.62 + (0.86 - 0.62) * t;
    }
  }
}

function getEffectiveVisualizationScale() {
  return RENDER_SCALE * (state.sphereSize / 100) * getViewportVisualizationMultiplier();
}

/**
 * Morph can blend simulations whose natural centroids differ. Compute a stable
 * render-only center from an evenly distributed sample so the visual subject
 * stays centered while the underlying particle coordinates remain untouched.
 */
function updateDisplayCenter() {
  DISPLAY_CENTER[0] = 0;
  DISPLAY_CENTER[1] = 0;
  DISPLAY_CENTER[2] = 0;
  if (state.boidType !== "morph" || state.activeCount < 1) return;

  const sampleCount = Math.min(state.activeCount, 1024);
  const stride = state.activeCount / sampleCount;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const particle = particles[Math.min(state.activeCount - 1, Math.floor(sample * stride))];
    writeDisplayPoint(
      DISPLAY_POINT,
      particle.positionX,
      particle.positionY,
      particle.positionZ,
      DISPLAY_QUATERNION
    );
    DISPLAY_CENTER[0] += DISPLAY_POINT[0];
    DISPLAY_CENTER[1] += DISPLAY_POINT[1];
    DISPLAY_CENTER[2] += DISPLAY_POINT[2];
  }
  DISPLAY_CENTER[0] /= sampleCount;
  DISPLAY_CENTER[1] /= sampleCount;
  DISPLAY_CENTER[2] /= sampleCount;
}

function updateParticleGeometry() {
  const activeCount = state.activeCount;
  const visualizationScale = getEffectiveVisualizationScale();
  for (let index = 0; index < activeCount; index += 1) {
    const particle = particles[index];
    const offset = index * 3;
    writeDisplayPoint(
      DISPLAY_POINT,
      particle.positionX,
      particle.positionY,
      particle.positionZ,
      DISPLAY_QUATERNION
    );
    swarm.positions[offset] = (DISPLAY_POINT[0] - DISPLAY_CENTER[0]) * visualizationScale;
    swarm.positions[offset + 1] = (DISPLAY_POINT[1] - DISPLAY_CENTER[1]) * visualizationScale;
    swarm.positions[offset + 2] = (DISPLAY_POINT[2] - DISPLAY_CENTER[2]) * visualizationScale;
    swarm.colors[offset] = particle.colorR;
    swarm.colors[offset + 1] = particle.colorG;
    swarm.colors[offset + 2] = particle.colorB;
  }

  particleGeometry.attributes.position.needsUpdate = true;
  particleGeometry.attributes.color.needsUpdate = true;
  particleGeometry.setDrawRange(0, activeCount);
}

/**
 * Build the visible Concentric Sphere from dense, complete great-circle rings.
 * Every circle has the same center and base radius; distributing their planes
 * through 180° forms a closed spherical shell instead of separated latitude
 * slices with empty bands between them.
 */
function updateConcentricSphereGeometry() {
  sphereRingSystem.visible = true;
  particleSystem.visible = false;

  const visibleRingCount = configureSphereRingLayout(
    state.ringCount || 100,
    state.ringLineWidth || 1
  );
  const reactivity = state.reactivity / 100;
  const audioMagnitude = clamp(state.lowFreqMagnitude * reactivity, 0, 1);
  const movementAmount = Math.max(0, state.rotationAmount / 100);
  const movementSpeed = Math.max(0, state.rotationSpeed);
  const spherePulse =
    1 + audioMagnitude * 0.22 * reactivity + beatImpulse * 0.055;
  const visualizationScale =
    getEffectiveVisualizationScale() * state.sphereRadius * spherePulse;

  // The geometry is a unit sphere. One uniform scale preserves an exact sphere
  // while the whole shell breathes with bass/beat energy. Individual frequency
  // regions remain audio-reactive through color/brightness instead of breaking
  // neighboring rings apart geometrically.
  sphereRingSystem.scale.setScalar(visualizationScale);
  sphereRingSystem.rotation.x = 0.42;
  sphereRingSystem.rotation.y =
    -0.38 +
    state.time * 0.12 * movementSpeed * movementAmount +
    Math.sin(state.time * 0.16 * movementSpeed) * 0.08 * movementAmount;
  sphereRingSystem.rotation.z = 0;

  const stopsA = COLORMAPS[state.cmapA].stops;
  const stopsB = COLORMAPS[state.cmapB].stops;
  const colorMix = clamp(state.cmapMix, 0, 1);
  const baseBrightness = state.brightness / 100;
  const bandCount = Math.max(1, state.magnitudes.length);
  const instanceColors = sphereRingSystem.instanceColor.array;

  for (let ringIndex = 0; ringIndex < visibleRingCount; ringIndex += 1) {
    const ringT = ringIndex / Math.max(1, visibleRingCount - 1);
    const colorA = sampleColormap(stopsA, ringT);
    const colorB = sampleColormap(stopsB, ringT);

    // Spread the available spectrum continuously around the sphere rather than
    // repeating a small band array in visible stripes.
    const bandPosition = ringT * Math.max(0, bandCount - 1);
    const bandA = Math.floor(bandPosition);
    const bandB = Math.min(bandCount - 1, bandA + 1);
    const bandMix = bandPosition - bandA;
    const magnitudeA = Number(state.magnitudes[bandA]) || 0;
    const magnitudeB = Number(state.magnitudes[bandB]) || 0;
    const bandMagnitude = magnitudeA + (magnitudeB - magnitudeA) * bandMix;
    const reactiveBrightness =
      baseBrightness * (0.45 + audioMagnitude * 0.35 + bandMagnitude * reactivity * 0.7);

    const offset = ringIndex * 3;
    instanceColors[offset] =
      (colorA[0] + (colorB[0] - colorA[0]) * colorMix) * reactiveBrightness;
    instanceColors[offset + 1] =
      (colorA[1] + (colorB[1] - colorA[1]) * colorMix) * reactiveBrightness;
    instanceColors[offset + 2] =
      (colorA[2] + (colorB[2] - colorA[2]) * colorMix) * reactiveBrightness;
  }

  sphereRingSystem.instanceColor.needsUpdate = true;
  sphereRingMaterial.opacity = state.ringOpacity / 100;
}

/**
 * Build the trail line segments from the ring buffer, newest sample first.
 * Segment colour tapers toward black with age; under additive blending that
 * reads as a fade, without needing per-vertex alpha.
 */
function updateTrailGeometry() {
  const enabled = state.attractorTrails && isAttractorMode();
  const requestedLength = Math.round(state.trailLength);
  const available = Math.min(trails.length, trails.sampleCount);
  const length = Math.min(Math.max(2, requestedLength), available);

  if (!enabled || length < 2) {
    trailSystem.visible = false;
    trailGeometry.setDrawRange(0, 0);
    return;
  }

  const tracked = Math.min(
    state.activeCount,
    trails.capacity,
    Math.round(state.trailParticles)
  );
  if (tracked < 1) {
    trailSystem.visible = false;
    trailGeometry.setDrawRange(0, 0);
    return;
  }

  const segments = length - 1;
  const visualizationScale = getEffectiveVisualizationScale();
  const positions = trailBuffers.positions;
  const colors = trailBuffers.colors;
  const history = trails.history;
  const stride = trails.length;
  const newest = (trails.writeIndex - 1 + stride) % stride;

  let vertex = 0;
  for (let index = 0; index < tracked; index += 1) {
    const particle = particles[index];
    const base = index * stride * 3;
    let previousX = 0;
    let previousY = 0;
    let previousZ = 0;

    for (let step = 0; step < length; step += 1) {
      const slot = (newest - step + stride * 2) % stride;
      const offset = base + slot * 3;
      writeDisplayPoint(
        DISPLAY_POINT,
        history[offset],
        history[offset + 1],
        history[offset + 2],
        DISPLAY_QUATERNION
      );
      const pointX = (DISPLAY_POINT[0] - DISPLAY_CENTER[0]) * visualizationScale;
      const pointY = (DISPLAY_POINT[1] - DISPLAY_CENTER[1]) * visualizationScale;
      const pointZ = (DISPLAY_POINT[2] - DISPLAY_CENTER[2]) * visualizationScale;

      if (step > 0) {
        // Squared falloff keeps the head bright and lets the tail die quickly,
        // which stops dense regions from smearing into a solid block.
        const nearFade = 1 - (step - 1) / segments;
        const farFade = 1 - step / segments;
        const nearWeight = nearFade * nearFade;
        const farWeight = farFade * farFade;

        let writeOffset = vertex * 3;
        positions[writeOffset] = previousX;
        positions[writeOffset + 1] = previousY;
        positions[writeOffset + 2] = previousZ;
        colors[writeOffset] = particle.colorR * nearWeight;
        colors[writeOffset + 1] = particle.colorG * nearWeight;
        colors[writeOffset + 2] = particle.colorB * nearWeight;
        vertex += 1;

        writeOffset = vertex * 3;
        positions[writeOffset] = pointX;
        positions[writeOffset + 1] = pointY;
        positions[writeOffset + 2] = pointZ;
        colors[writeOffset] = particle.colorR * farWeight;
        colors[writeOffset + 1] = particle.colorG * farWeight;
        colors[writeOffset + 2] = particle.colorB * farWeight;
        vertex += 1;
      }

      previousX = pointX;
      previousY = pointY;
      previousZ = pointZ;
    }
  }

  markAttributeRange(trailGeometry.attributes.position, vertex * 3);
  markAttributeRange(trailGeometry.attributes.color, vertex * 3);
  trailGeometry.setDrawRange(0, vertex);
  trailMaterial.opacity = state.trailOpacity / 100;
  trailSystem.visible = vertex > 0;
}

/**
 * Advance the swarm, the colormap cycle and beat detection by one fixed
 * sub-step. Everything here ran once per animation frame in the original.
 */
function stepSimulation(stepTime, context) {
  const {
    isActive,
    avgMagnitude,
    sphereMagnitude,
    trajectoryMagnitude,
    reactivity,
    brightness
  } = context;

  state.time += stepTime;

  // Decayed in simulation time, not frame time, so the impulse envelope is
  // identical at 24 fps export and 60 fps preview.
  beatImpulse *= Math.exp(-stepTime / BEAT_IMPULSE_DECAY);
  if (beatImpulse < 1e-4) beatImpulse = 0;

  // Colormap cycling.
  const cycleRate = isActive ? 0.08 + sphereMagnitude * 0.42 : 0.06;
  if (isActive && state.lockedCmapIndex < 0) {
    state.cmapMix += stepTime * cycleRate * state.cycleSpeed;
    while (state.cmapMix >= 1) {
      state.cmapMix -= 1;
      state.cmapA = state.cmapB;
      state.cmapB = (state.cmapB + 1) % COLORMAPS.length;
    }
  } else if (state.lockedCmapIndex >= 0) {
    state.cmapA = state.lockedCmapIndex;
    state.cmapB = state.lockedCmapIndex;
    state.cmapMix = 0;
  }

  // The standalone concentric-sphere project does not advance the inherited
  // particle/boid simulation. Audio analysis, beat detection, color cycling
  // and the deterministic clock are the only simulation state required by the
  // ring renderer.
  detectBeat(state.magnitudes, reactivity);
  return;

  // Legacy particle code below is intentionally unreachable and retained only
  // to minimize risk to shared helper behavior inherited from the reference.
  // Particle count follows the average magnitude.
  const targetCount = isActive
    ? Math.floor(
        state.minParticles +
          avgMagnitude * reactivity * (state.maxParticles - state.minParticles)
      )
    : state.minParticles;
  state.activeCount = Math.floor(
    state.activeCount + (targetCount - state.activeCount) * 0.05
  );
  state.activeCount = clamp(
    state.activeCount,
    state.minParticles,
    state.maxParticles
  );
  const grownBy = state.activeCount - previousActiveCount;

  if (!isActive) {
    previousActiveCount = state.activeCount;
    return;
  }

  const amplitude = clamp(sphereMagnitude, 0, 1);
  const dynamicNoiseScale = state.noiseScale * (0.125 + sphereMagnitude * 1.125);
  const dynamicSphereBoundary =
    state.sphereBoundary * (1.0 + sphereMagnitude * 0.7);
  const usesConcentricSphere = state.boidType === "sphereRings";
  const usesAttractorSimulation =
    ATTRACTOR_TYPES.has(state.boidType) ||
    (state.boidType === "morph" && state.morphScope === "attractors");
  // Do not let bass-driven container expansion rescale the mathematical state
  // space. That changes the equations' effective coordinates and deforms the
  // attractor. Boid/liquid modes keep the existing reactive boundary.
  const simulationBoundary = usesAttractorSimulation || usesConcentricSphere
    ? state.sphereBoundary
    : dynamicSphereBoundary;

  buildColorLut(
    COLORMAPS[state.cmapA].stops,
    COLORMAPS[state.cmapB].stops,
    state.cmapMix,
    brightness
  );

  const movement = buildMovement(trajectoryMagnitude);

  // Newly activated particles otherwise pop in wherever they were left. Seed
  // them from a particle already on the manifold so a rising particle count
  // reads as the attractor densifying rather than debris flying in.
  if (usesAttractorSimulation && grownBy > 0 && previousActiveCount > 0) {
    for (
      let index = previousActiveCount;
      index < state.activeCount;
      index += 1
    ) {
      spawnFromManifold(index, previousActiveCount, simulationBoundary);
    }
  }
  previousActiveCount = state.activeCount;

  const colorSource = usesAttractorSimulation
    ? state.attractorColorSource
    : "radius";
  const lobeScale = Math.max(simulationBoundary * 0.45, 1e-6);
  const speedScale = Math.max(attractorSpeedReference, 1e-4);
  let frameMaxSpeed = 0;

  for (let index = 0; index < state.activeCount; index += 1) {
    const particle = particles[index];
    if (usesConcentricSphere) {
      writeConcentricSphereParticle(
        particle,
        index,
        simulationBoundary,
        amplitude,
        movement
      );
    } else {
      particle.update(
        index,
        particles,
        state.activeCount,
        state.time,
        amplitude,
        dynamicNoiseScale,
        simulationBoundary,
        state.damping,
        movement
      );
    }

    const distance = Math.sqrt(
      particle.positionX * particle.positionX +
        particle.positionY * particle.positionY +
        particle.positionZ * particle.positionZ
    );
    const normalizedDistance = Math.min(distance / simulationBoundary, 1.0);

    // Radial distance is the right colour channel for boids, but on an
    // attractor it paints concentric shells: Lorenz's two wings sit at nearly
    // identical radii, so they receive identical colour and the structure
    // disappears. Speed and lobe membership both track the actual geometry.
    let colorPosition = usesConcentricSphere
      ? concentricSphereColorPosition(index)
      : normalizedDistance;
    if (!usesConcentricSphere && colorSource === "speed") {
      const speed = Math.sqrt(
        particle.velocityX * particle.velocityX +
          particle.velocityY * particle.velocityY +
          particle.velocityZ * particle.velocityZ
      );
      if (speed > frameMaxSpeed) frameMaxSpeed = speed;
      colorPosition = clamp(speed / speedScale, 0, 1);
    } else if (!usesConcentricSphere && colorSource === "lobe") {
      colorPosition = clamp(
        0.5 + 0.5 * Math.tanh(particle.positionX / lobeScale),
        0,
        1
      );
    }

    const lutPosition = colorPosition * COLOR_LUT_MAX;
    const lutLow = lutPosition | 0;
    const lutHigh = lutLow < COLOR_LUT_MAX ? lutLow + 1 : COLOR_LUT_MAX;
    const lutBlend = lutPosition - lutLow;
    const lowOffset = lutLow * 3;
    const highOffset = lutHigh * 3;

    const lowR = colorLut[lowOffset];
    const lowG = colorLut[lowOffset + 1];
    const lowB = colorLut[lowOffset + 2];

    particle.colorR = lowR + (colorLut[highOffset] - lowR) * lutBlend;
    particle.colorG = lowG + (colorLut[highOffset + 1] - lowG) * lutBlend;
    particle.colorB = lowB + (colorLut[highOffset + 2] - lowB) * lutBlend;
  }

  if (colorSource === "speed") {
    // One sub-step of lag, which is imperceptible and keeps this to a single
    // pass over the pool.
    const target = Math.max(frameMaxSpeed, 1e-4);
    const rate = target > attractorSpeedReference ? 0.25 : 0.02;
    attractorSpeedReference += (target - attractorSpeedReference) * rate;
  }

  // Sampled inside the fixed sub-step, never once per rendered frame, so trail
  // spacing is identical at 24 fps export and 60 fps preview.
  if (state.attractorTrails && usesAttractorSimulation) {
    sampleTrails(state.activeCount);
  }

  detectBeat(state.magnitudes, reactivity);
}

/**
 * Update the camera from the selected movement preset. Static reproduces the
 * previous fixed camera exactly; movement presets are deterministic so preview
 * and export use the same camera path.
 */
/**
 * Widen the vertical FOV in portrait formats so the visualization still fits.
 *
 * fitViewport() recomposes the canvas for four aspect ratios but the camera's
 * vertical FOV was fixed at 75 degrees, so the horizontal extent shrank with the
 * aspect: portrait 9:16 clipped the swarm by about 20 percent.
 *
 * Landscape and square are deliberately left alone. They already fit, and
 * narrowing the FOV to tighten their generous margin would recompose every
 * existing preset — a separate decision from fixing the clipping.
 *
 * Framing is derived from the nominal cameraDistance rather than the animated
 * camera position, so presets that dolly (pushPull, drift) do not induce a
 * breathing dolly-zoom.
 */
function updateCameraFraming() {
  const aspect = camera.aspect || 1;
  let fov = BASE_CAMERA_FOV;

  if (aspect < 1) {
    const bound = isAttractorMode() ? 1.35 : 1.0;
    const subjectRadius =
      getEffectiveVisualizationScale() * state.sphereRadius * bound;
    const distance = Math.max(1, state.cameraDistance);
    const required =
      (2 * Math.atan(subjectRadius / aspect / distance) * 180) / Math.PI;
    fov = Math.min(MAX_CAMERA_FOV, Math.max(BASE_CAMERA_FOV, required));
  }

  if (Math.abs(fov - appliedCameraFov) > 1e-4) {
    appliedCameraFov = fov;
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
}

function updateCamera(deltaTime, playing) {
  updateCameraFraming();

  const distance = state.cameraDistance;
  const amount = state.cameraAmount / 100;
  const speed = state.cameraSpeed;
  const time = state.time * speed;
  const radius = distance * 0.42 * amount;

  let x = 0;
  let y = 0;
  let z = distance;

  switch (state.cameraPreset) {
    case "orbit": {
      const angle = time * 0.55;
      x = Math.cos(angle) * radius;
      y = Math.sin(angle) * radius;
      break;
    }
    case "horizontalOrbit": {
      const angle = time * 0.42;
      const orbitAmount = clamp(amount, 0, 2);
      x = Math.sin(angle) * distance * orbitAmount;
      z = distance * (1 - orbitAmount) + Math.cos(angle) * distance * orbitAmount;
      y = Math.sin(time * 0.21) * distance * 0.08 * orbitAmount;
      break;
    }
    case "verticalArc": {
      const angle = Math.sin(time * 0.38) * Math.PI * 0.34 * clamp(amount, 0, 2);
      y = Math.sin(angle) * distance;
      z = Math.max(5, Math.cos(angle) * distance);
      x = Math.sin(time * 0.19) * radius * 0.25;
      break;
    }
    case "helix": {
      const angle = time * 0.4;
      const orbitAmount = clamp(amount, 0, 2);
      x = Math.sin(angle) * distance * orbitAmount;
      z = distance * (1 - orbitAmount) + Math.cos(angle) * distance * orbitAmount;
      y = Math.sin(time * 0.18) * distance * 0.3 * orbitAmount;
      break;
    }
    case "pendulum": {
      x = Math.sin(time * 0.52) * radius * 1.15;
      y = Math.sin(time * 0.26 + 0.8) * radius * 0.28;
      z = Math.max(5, distance + Math.cos(time * 0.52) * radius * 0.18);
      break;
    }
    case "cinematicSweep": {
      x = Math.sin(time * 0.22) * radius * 1.35;
      y = Math.sin(time * 0.15 + 1.1) * radius * 0.42;
      z = Math.max(5, distance + Math.cos(time * 0.27) * radius * 0.34);
      break;
    }
    case "figure8": {
      const angle = time * 0.5;
      x = Math.sin(angle) * radius;
      y = Math.sin(angle * 2) * radius * 0.5;
      break;
    }
    case "pushPull": {
      const depthRange = distance * 0.35 * amount;
      z = Math.max(5, distance + Math.sin(time * 0.7) * depthRange);
      break;
    }
    case "drift": {
      x = Math.sin(time * 0.42) * radius;
      y = Math.sin(time * 0.31 + 1.35) * radius * 0.6;
      z = Math.max(5, distance + Math.sin(time * 0.23 + 2.1) * radius * 0.45);
      break;
    }
    case "spectralCentroid": {
      const energy = clamp(state.spectralEnergy || 0, 0, 1);
      const centroidOffset = energy > 0.02
        ? (clamp(state.spectralCentroid || 0.5, 0, 1) - 0.5) * 100 * amount
        : 0;
      const response = playing
        ? 1 - Math.exp(-Math.max(0.001, deltaTime) * (1.5 + speed * 2.5))
        : 0;
      state.cameraFollowAzimuth += (centroidOffset - state.cameraFollowAzimuth) * response;
      const angle = state.cameraFollowAzimuth * Math.PI / 180;
      x = Math.sin(angle) * distance;
      z = Math.cos(angle) * distance;
      y = (energy - 0.5) * distance * 0.08 * amount;
      break;
    }
    case "static":
    default:
      break;
  }

  // Apply user camera orientation as spherical angular offsets around the
  // visualization. Zero elevation/azimuth preserves every preset exactly.
  const sphericalRadius = Math.hypot(x, y, z);
  if (sphericalRadius > 0) {
    const baseAzimuth = Math.atan2(x, z);
    const normalizedY = clamp(y / sphericalRadius, -1, 1);
    const baseElevation = Math.asin(normalizedY);
    const azimuth = baseAzimuth + state.cameraAzimuth * Math.PI / 180;
    const elevation = clamp(
      baseElevation + state.cameraElevation * Math.PI / 180,
      -89 * Math.PI / 180,
      89 * Math.PI / 180
    );
    const horizontalRadius = sphericalRadius * Math.cos(elevation);

    x = Math.sin(azimuth) * horizontalRadius;
    y = Math.sin(elevation) * sphericalRadius;
    z = Math.cos(azimuth) * horizontalRadius;
  }

  camera.position.set(x, y, z);
  camera.lookAt(0, 0, 0);
}

/**
 * Render one frame.
 * @param {number} deltaTime seconds since the previous frame
 * @param {boolean} playing whether the transport is running
 */
export function renderFrame(deltaTime, playing) {
  const isActive = playing && (state.hasAudio ? state.analysisReady : true);
  const reactivity = state.reactivity / 100;

  let rawAverage = 0;
  for (let index = 0; index < state.magnitudes.length; index += 1) {
    rawAverage += state.magnitudes[index];
  }
  rawAverage /= state.magnitudes.length;

  const avgMagnitude = Math.min(1, rawAverage * reactivity);
  const sphereMagnitude = Math.min(1, state.lowFreqMagnitude * reactivity);
  // Chaotic attractors use smoothed full-spectrum energy as a bounded time
  // dilation signal. Attack is quick enough to feel musical; release is slower
  // so particle speed does not chatter frame-to-frame and destroy the shape.
  const trajectoryTarget = clamp(
    Math.max(0, Number(state.attractorEnergy) || 0) * reactivity,
    0,
    1
  );
  const trajectoryTimeConstant =
    trajectoryTarget > smoothedAttractorEnergy ? 0.08 : 0.32;
  const trajectoryResponse =
    1 - Math.exp(-Math.max(0.001, deltaTime) / trajectoryTimeConstant);
  smoothedAttractorEnergy +=
    (trajectoryTarget - smoothedAttractorEnergy) * trajectoryResponse;
  const trajectoryMagnitude = clamp(smoothedAttractorEnergy, 0, 1);
  const brightness =
    (isActive ? 0.25 + sphereMagnitude * 0.95 : 0.25) *
    (state.brightness / 100);

  if (playing) {
    simulationAccumulator += deltaTime;
    let guard = 0;
    while (simulationAccumulator >= BASE_FRAME_TIME && guard < 8) {
      stepSimulation(BASE_FRAME_TIME, {
        isActive,
        avgMagnitude,
        sphereMagnitude,
        trajectoryMagnitude,
        reactivity,
        brightness
      });
      simulationAccumulator -= BASE_FRAME_TIME;
      guard += 1;
    }
    if (guard >= 8) simulationAccumulator = 0;
  }

  advanceFlash(playing ? deltaTime : 0);

  particleMaterial.size =
    state.particleSize * (1.0 + sphereMagnitude * reactivity * 2.2);
  particleMaterial.opacity = state.particleOpacity / 100;

  const bloomTarget = state.hasAudio
    ? state.bloomBase + avgMagnitude * reactivity * state.bloomGain
    : 0.55;
  state.smoothedBloom += (bloomTarget - state.smoothedBloom) * 0.08;
  bloomPass.strength = state.smoothedBloom;
  bloomPass.radius = state.bloomRadius;
  bloomPass.threshold = state.bloomThreshold;

  // The standalone project renders only the concentric ring sphere.
  updateConcentricSphereGeometry();
  updateCamera(deltaTime, playing);
  renderScene();
}
