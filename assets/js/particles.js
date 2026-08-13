/**
 * particles.js — particle simulation engine.
 *
 * "flow" preserves the original noise-field motion exactly at default values.
 * Boid, liquid, and chaotic-attractor simulations reuse the same particle pool
 * and deterministic simulation clock so preview and export stay in sync.
 */
import { engine } from "./config.js";
import { SimplexNoise } from "./noise.js";

const {
  DT,
  PARTICLE_POOL,
  TRAIL_MAX_LENGTH,
  TRAIL_PARTICLE_CAP,
  ATTRACTOR_MAX_POSITION_STEP,
  ATTRACTOR_MAX_SUBSTEPS
} = engine;
const FLOCK_NEIGHBOR_OFFSETS = Object.freeze([1, 7, 31, 127]);
const LIQUID_NEIGHBOR_OFFSETS = Object.freeze([1, 7, 31, 127, 509, 2039, 8191, 16381]);
const BOID_SIMULATION_TYPES = Object.freeze(["flow", "flock", "swarm", "vortex", "orbit", "liquid"]);
const ATTRACTOR_TYPES = Object.freeze(["lorenz", "rossler", "halvorsen", "aizawa", "thomas", "dadras"]);
const ATTRACTOR_TYPE_SET = new Set(ATTRACTOR_TYPES);
const ALL_MORPH_TYPES = Object.freeze([...BOID_SIMULATION_TYPES, ...ATTRACTOR_TYPES]);
const MORPH_TYPE_GROUPS = Object.freeze({
  all: ALL_MORPH_TYPES,
  boids: BOID_SIMULATION_TYPES,
  attractors: ATTRACTOR_TYPES
});
const MORPH_SECONDS_PER_TYPE = 4;
const ATTRACTOR_MORPH_SECONDS_PER_TYPE = 2.2;
const ATTRACTOR_MORPH_HOLD_FRACTION = 0.18;

/**
 * Which two simulation types Morph is currently blending, and how far between
 * them. Exported so the renderer can interpolate display orientation across the
 * same blend the simulation is running — duplicating the phase expression in
 * two files would let them drift apart.
 */
export function getMorphBlend(morphScope, time, morphSpeed) {
  const morphTypes = MORPH_TYPE_GROUPS[morphScope] || ALL_MORPH_TYPES;
  const secondsPerType =
    morphScope === "attractors"
      ? ATTRACTOR_MORPH_SECONDS_PER_TYPE
      : MORPH_SECONDS_PER_TYPE;
  const rawPhase = (time * morphSpeed) / secondsPerType;
  const wrappedPhase =
    ((rawPhase % morphTypes.length) + morphTypes.length) % morphTypes.length;
  const typeIndex = Math.floor(wrappedPhase);
  const linearMix = wrappedPhase - typeIndex;

  let mix;
  if (morphScope === "attractors") {
    // Give each chaotic attractor a short fully-resolved presentation before
    // and after the transition. The old full-duration smoothstep spent nearly
    // the entire four-second phase in a hybrid vector field, so the individual
    // Lorenz/Rossler/etc. structures never read as clearly as they should.
    // Attractor-only Morph now cycles faster and confines the actual morph to
    // the middle of the phase while still remaining continuous.
    const hold = ATTRACTOR_MORPH_HOLD_FRACTION;
    const transition = Math.max(1e-6, 1 - hold * 2);
    const transitionPhase = Math.max(
      0,
      Math.min(1, (linearMix - hold) / transition)
    );
    // Smootherstep keeps zero slope at both ends, avoiding a visible snap when
    // the phase enters or leaves its identity hold.
    mix =
      transitionPhase *
      transitionPhase *
      transitionPhase *
      (transitionPhase * (transitionPhase * 6 - 15) + 10);
  } else {
    mix = linearMix * linearMix * (3 - 2 * linearMix);
  }

  return {
    typeA: morphTypes[typeIndex],
    typeB: morphTypes[(typeIndex + 1) % morphTypes.length],
    mix
  };
}
const MORPH_ACCEL_A = new Float64Array(3);
const MORPH_ACCEL_B = new Float64Array(3);
const LIQUID_ACCEL = new Float64Array(3);
const ATTRACTOR_ACCEL = new Float64Array(3);

/**
 * Deterministic 32-bit integer hash in [0, 1). Used everywhere a particle needs
 * a "random" offset, because Math.random() would desynchronise the video export
 * pass from the preview it is supposed to reproduce.
 */
function hash01(value) {
  let x = Math.imul(value ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/* ---------------------------------------------------------------------------
   Trail history

   One flat ring buffer for the first TRAIL_PARTICLE_CAP particles. All tracked
   particles share a single write cursor because sampleTrails() appends one
   sample for all of them at once, from inside the fixed simulation sub-step —
   which is what keeps a 24 fps export identical to a 60 fps preview.
--------------------------------------------------------------------------- */
export const trails = {
  history: new Float32Array(TRAIL_PARTICLE_CAP * TRAIL_MAX_LENGTH * 3),
  writeIndex: 0,
  sampleCount: 0,
  capacity: TRAIL_PARTICLE_CAP,
  length: TRAIL_MAX_LENGTH
};

/** Drop all trail history. Trails rebuild over the next TRAIL_MAX_LENGTH steps. */
export function resetTrails() {
  trails.history.fill(0);
  trails.writeIndex = 0;
  trails.sampleCount = 0;
}

/**
 * Collapse one particle's whole history onto a single point, so a particle that
 * teleports (respawn, manifold spawn) does not draw a streak across the frame.
 */
export function collapseTrailTo(index, x, y, z) {
  if (index >= TRAIL_PARTICLE_CAP) return;
  const base = index * TRAIL_MAX_LENGTH * 3;
  for (let slot = 0; slot < TRAIL_MAX_LENGTH; slot += 1) {
    const offset = base + slot * 3;
    trails.history[offset] = x;
    trails.history[offset + 1] = y;
    trails.history[offset + 2] = z;
  }
}

/** Append one position sample per tracked particle. One call per sub-step. */
export function sampleTrails(activeCount) {
  const tracked = Math.min(activeCount, TRAIL_PARTICLE_CAP);
  const slot = trails.writeIndex;
  for (let index = 0; index < tracked; index += 1) {
    const particle = particles[index];
    const offset = (index * TRAIL_MAX_LENGTH + slot) * 3;
    trails.history[offset] = particle.positionX;
    trails.history[offset + 1] = particle.positionY;
    trails.history[offset + 2] = particle.positionZ;
  }
  trails.writeIndex = (slot + 1) % TRAIL_MAX_LENGTH;
  trails.sampleCount = Math.min(trails.sampleCount + 1, TRAIL_MAX_LENGTH);
}

/**
 * Seed points in normalized state-space coordinates, chosen to sit inside each
 * attractor's basin so the pre-warm converges instead of diverging.
 */
const ATTRACTOR_SEED_POINTS = Object.freeze({
  lorenz: [0.05, 0.05, 0.08],
  rossler: [0.18, 0.02, -0.90],
  halvorsen: [-0.10, 0.05, 0.02],
  aizawa: [0.08, 0.02, -0.60],
  thomas: [0.20, 0.14, -0.05],
  dadras: [0.10, 0.06, -0.70]
});

/**
 * Collapse the whole pool onto one point inside the attractor's basin. This is
 * only the starting condition for the leader walk in render.js — a blob left to
 * spread on its own works for Lorenz and Halvorsen but not for Rossler, Aizawa
 * or Thomas, whose leading Lyapunov exponents are an order of magnitude
 * smaller. Those would sit as a bright dot for the better part of a minute.
 */
export function seedAttractorPoint(sphereBoundary, type) {
  const seed = ATTRACTOR_SEED_POINTS[type] || [0.06, 0.04, 0.02];
  const jitter = sphereBoundary * 0.004;
  for (let index = 0; index < PARTICLE_POOL; index += 1) {
    const particle = particles[index];
    particle.positionX =
      seed[0] * sphereBoundary + (hash01(index * 3 + 1) - 0.5) * jitter;
    particle.positionY =
      seed[1] * sphereBoundary + (hash01(index * 3 + 2) - 0.5) * jitter;
    particle.positionZ =
      seed[2] * sphereBoundary + (hash01(index * 3 + 3) - 0.5) * jitter;
    particle.velocityX = 0;
    particle.velocityY = 0;
    particle.velocityZ = 0;
  }
  resetTrails();
}

/**
 * Copy a source particle's state onto another with a small deterministic
 * transverse offset, so the manifold reads as a filament with thickness rather
 * than a perfect one-dimensional wire.
 */
export function copyParticleWithJitter(targetIndex, source, jitterScale) {
  if (targetIndex >= PARTICLE_POOL) return;
  const particle = particles[targetIndex];
  particle.positionX =
    source.positionX + (hash01(targetIndex * 13 + 1) - 0.5) * jitterScale;
  particle.positionY =
    source.positionY + (hash01(targetIndex * 13 + 2) - 0.5) * jitterScale;
  particle.positionZ =
    source.positionZ + (hash01(targetIndex * 13 + 3) - 0.5) * jitterScale;
  particle.velocityX = source.velocityX;
  particle.velocityY = source.velocityY;
  particle.velocityZ = source.velocityZ;
}

/**
 * Re-seed a newly activated particle from one already on the manifold. Without
 * this, a rising particle count pops stale off-manifold positions into view.
 */
export function spawnFromManifold(targetIndex, sourceCount, sphereBoundary) {
  if (sourceCount <= 0 || targetIndex >= PARTICLE_POOL) return;
  const particle = particles[targetIndex];
  const sourceIndex = (Math.imul(targetIndex, 2654435761) >>> 0) % sourceCount;
  const source = particles[sourceIndex];
  if (source === particle) return;

  const jitter = sphereBoundary * 0.012;
  particle.positionX =
    source.positionX + (hash01(targetIndex * 7 + 1) - 0.5) * jitter;
  particle.positionY =
    source.positionY + (hash01(targetIndex * 7 + 2) - 0.5) * jitter;
  particle.positionZ =
    source.positionZ + (hash01(targetIndex * 7 + 3) - 0.5) * jitter;
  particle.velocityX = source.velocityX;
  particle.velocityY = source.velocityY;
  particle.velocityZ = source.velocityZ;
  collapseTrailTo(
    targetIndex,
    particle.positionX,
    particle.positionY,
    particle.positionZ
  );
}

/**
 * Return an escaped particle to the manifold instead of bouncing it off the
 * bounding box. A state space has no walls, and the old elastic bounce piled
 * escapees into flat planes that read as straight lines belonging to no
 * equation — most obvious on Rössler and Dadras.
 */
function respawnOnManifold(particle, index, pool, activeCount, limit, jitterScale) {
  let source = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (activeCount <= 0) break;
    const candidateIndex =
      (Math.imul(index + attempt * 7919, 2654435761) >>> 0) % activeCount;
    const candidate = pool[candidateIndex];
    if (
      candidate !== particle &&
      Math.abs(candidate.positionX) <= limit &&
      Math.abs(candidate.positionY) <= limit &&
      Math.abs(candidate.positionZ) <= limit
    ) {
      source = candidate;
      break;
    }
  }

  if (source) {
    const jitter = jitterScale * 0.012;
    particle.positionX =
      source.positionX + (hash01(index * 11 + 1) - 0.5) * jitter;
    particle.positionY =
      source.positionY + (hash01(index * 11 + 2) - 0.5) * jitter;
    particle.positionZ =
      source.positionZ + (hash01(index * 11 + 3) - 0.5) * jitter;
    particle.velocityX = source.velocityX;
    particle.velocityY = source.velocityY;
    particle.velocityZ = source.velocityZ;
  } else {
    // Nothing healthy to copy yet (first steps after a seed). Fall back to
    // pulling the particle back toward the origin with most of its energy gone.
    particle.positionX *= 0.25;
    particle.positionY *= 0.25;
    particle.positionZ *= 0.25;
    particle.velocityX *= 0.1;
    particle.velocityY *= 0.1;
    particle.velocityZ *= 0.1;
  }

  collapseTrailTo(
    index,
    particle.positionX,
    particle.positionY,
    particle.positionZ
  );
}


function writeLiquidAcceleration(
  output,
  index,
  pool,
  activeCount,
  x,
  y,
  z,
  velocityX,
  velocityY,
  velocityZ,
  movementTime,
  sphereBoundary,
  movement,
  audioMagnitude,
  noiseX,
  noiseY,
  noiseZ
) {
  let pressureX = 0;
  let pressureY = 0;
  let pressureZ = 0;
  let centerX = 0;
  let centerY = 0;
  let centerZ = 0;
  let averageVelocityX = 0;
  let averageVelocityY = 0;
  let averageVelocityZ = 0;
  let weightTotal = 0;

  // Sampled-neighbor SPH-style pressure/viscosity. Unlike the previous
  // zero-gravity droplet behavior, this mode has a real down direction and a
  // hydrostatic restoring force so the liquid settles into the lower portion
  // of the spherical container and develops a horizontal free surface.
  const interactionRadius = Math.max(0.08, sphereBoundary * 0.38);
  const inverseInteractionRadius = 1 / interactionRadius;

  if (activeCount > 1) {
    for (const offset of LIQUID_NEIGHBOR_OFFSETS) {
      const neighborIndex = (index + offset) % activeCount;
      if (neighborIndex === index) continue;
      const neighbor = pool[neighborIndex];
      const dx = neighbor.positionX - x;
      const dy = neighbor.positionY - y;
      const dz = neighbor.positionZ - z;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      if (distanceSquared <= 1e-8) continue;

      const distance = Math.sqrt(distanceSquared);
      if (distance >= interactionRadius) continue;

      const q = 1 - distance * inverseInteractionRadius;
      const weight = q * q;
      const inverseDistance = 1 / distance;
      const pressure = weight * (0.32 + movement.separation * 1.1);

      pressureX -= dx * inverseDistance * pressure;
      pressureY -= dy * inverseDistance * pressure;
      pressureZ -= dz * inverseDistance * pressure;

      centerX += neighbor.positionX * weight;
      centerY += neighbor.positionY * weight;
      centerZ += neighbor.positionZ * weight;
      averageVelocityX += neighbor.velocityX * weight;
      averageVelocityY += neighbor.velocityY * weight;
      averageVelocityZ += neighbor.velocityZ * weight;
      weightTotal += weight;
    }
  }

  let surfaceX = 0;
  let surfaceY = 0;
  let surfaceZ = 0;
  let viscosityX = 0;
  let viscosityY = 0;
  let viscosityZ = 0;

  if (weightTotal > 1e-6) {
    const inverseWeight = 1 / weightTotal;
    centerX *= inverseWeight;
    centerY *= inverseWeight;
    centerZ *= inverseWeight;
    averageVelocityX *= inverseWeight;
    averageVelocityY *= inverseWeight;
    averageVelocityZ *= inverseWeight;

    const surfaceStrength = movement.cohesion * 0.34;
    surfaceX = (centerX - x) * surfaceStrength;
    surfaceY = (centerY - y) * surfaceStrength;
    surfaceZ = (centerZ - z) * surfaceStrength;

    const viscosityStrength = 1.15 + movement.alignment * 1.15;
    viscosityX = (averageVelocityX - velocityX) * viscosityStrength;
    viscosityY = (averageVelocityY - velocityY) * viscosityStrength;
    viscosityZ = (averageVelocityZ - velocityZ) * viscosityStrength;
  }

  const freeSurfaceY = -sphereBoundary * 0.04;
  const depth = Math.max(0, freeSurfaceY - y) / Math.max(sphereBoundary, 1e-6);
  const hydrostaticSupport = depth * (1.35 + movement.separation * 0.45);
  const gravity = 0.82;

  // Audio magnitude drives the liquid's container motion and turbulence. Quiet
  // passages settle under gravity; louder passages slosh harder and develop
  // visibly stronger local currents without removing the fixed down direction.
  const audioEnergy = Math.max(0, Math.min(1, audioMagnitude));
  const turbulenceEnergy = Math.pow(audioEnergy, 0.82);
  const sloshStrength = 0.025 + turbulenceEnergy * 0.58;
  const sloshRate = 0.66 + turbulenceEnergy * 1.18;
  const sloshX = Math.sin(movementTime * sloshRate) * sloshStrength;
  const sloshZ =
    Math.cos(movementTime * (sloshRate * 0.79) + 0.8) * sloshStrength * 0.76;
  const horizontalContainment = 0.2 + movement.cohesion * 0.12;
  const surfaceWave =
    Math.sin(
      (x - z) * 4.2 / Math.max(sphereBoundary, 1e-6) +
        movementTime * (1.05 + turbulenceEnergy * 1.7)
    ) *
    Math.max(0, 1 - depth) *
    (0.012 + turbulenceEnergy * 0.085);

  // The same simplex field already used by the visualizer becomes liquid
  // turbulence here. Horizontal churn is intentionally stronger than vertical
  // churn so the simulation still reads as water under gravity.
  const horizontalTurbulence = 0.018 + turbulenceEnergy * 0.42;
  const verticalTurbulence = 0.008 + turbulenceEnergy * 0.16;
  const eddyPhase = movementTime * (1.7 + turbulenceEnergy * 2.4) + index * 0.019;
  const eddyX = Math.sin(eddyPhase + z * 0.75) * turbulenceEnergy * 0.09;
  const eddyZ = Math.cos(eddyPhase * 0.87 + x * 0.75) * turbulenceEnergy * 0.09;

  output[0] =
    pressureX +
    surfaceX +
    viscosityX +
    sloshX +
    eddyX -
    x * horizontalContainment +
    noiseX * horizontalTurbulence;
  output[1] =
    pressureY +
    surfaceY +
    viscosityY -
    gravity +
    hydrostaticSupport +
    surfaceWave +
    noiseY * verticalTurbulence;
  output[2] =
    pressureZ +
    surfaceZ +
    viscosityZ +
    sloshZ +
    eddyZ -
    z * horizontalContainment +
    noiseZ * horizontalTurbulence;
}

/**
 * Soft knee limiter. Below `knee` the vector passes through untouched; above it
 * the magnitude compresses smoothly toward `ceiling`. Derivative is 1 at the
 * knee, so there is no visible kink.
 *
 * The previous hard clamp truncated the fastest sections of every field, which
 * is exactly the speed contrast that makes a lobe transition legible — and that
 * contrast now drives particle colour.
 */
function softLimitVector(x, y, z, knee, ceiling) {
  const length = Math.sqrt(x * x + y * y + z * z);
  if (length <= knee || length <= 1e-9) return [x, y, z];
  const range = Math.max(ceiling - knee, 1e-6);
  const compressed = knee + range * (1 - Math.exp(-(length - knee) / range));
  const scale = compressed / length;
  return [x * scale, y * scale, z * scale];
}

function writeAttractorAcceleration(
  output,
  type,
  index,
  x,
  y,
  z,
  velocityX,
  velocityY,
  velocityZ,
  sphereBoundary,
  movement,
  audioMagnitude,
  noiseX,
  noiseY,
  noiseZ
) {
  const boundary = Math.max(sphereBoundary, 1e-6);
  const nx = x / boundary;
  const ny = y / boundary;
  const nz = z / boundary;

  let dx = 0;
  let dy = 0;
  let dz = 0;

  if (type === "lorenz") {
    const X = nx * 20;
    const Y = ny * 30;
    const Z = (nz + 1) * 25;
    const sigma = 10;
    const rho = 28;
    const beta = 8 / 3;
    dx = (sigma * (Y - X)) / 20;
    dy = (X * (rho - Z) - Y) / 30;
    dz = (X * Y - beta * Z) / 25;
  } else if (type === "rossler") {
    const X = nx * 28;
    const Y = ny * 28;
    const Z = (nz + 1) * 18;
    const a = 0.2;
    const b = 0.2;
    const c = 5.7;
    dx = (-Y - Z) / 28;
    dy = (X + a * Y) / 28;
    dz = (b + Z * (X - c)) / 18;
  } else if (type === "halvorsen") {
    const X = nx * 15;
    const Y = ny * 15;
    const Z = nz * 15;
    const a = 1.4;
    dx = (-a * X - 4 * Y - 4 * Z - Y * Y) / 15;
    dy = (-a * Y - 4 * Z - 4 * X - Z * Z) / 15;
    dz = (-a * Z - 4 * X - 4 * Y - X * X) / 15;
  } else if (type === "aizawa") {
    const X = nx * 1.5;
    const Y = ny * 1.5;
    const Z = (nz + 1) * 1.0;
    const a = 0.95;
    const b = 0.7;
    const c = 0.6;
    const d = 3.5;
    const e = 0.25;
    const f = 0.1;
    dx = ((Z - b) * X - d * Y) / 1.5;
    dy = (d * X + (Z - b) * Y) / 1.5;
    dz =
      c +
      a * Z -
      (Z * Z * Z) / 3 -
      (X * X + Y * Y) * (1 + e * Z) +
      f * Z * X * X * X;
  } else if (type === "thomas") {
    const X = nx * 6;
    const Y = ny * 6;
    const Z = nz * 6;
    const b = 0.208186;
    dx = (Math.sin(Y) - b * X) / 6;
    dy = (Math.sin(Z) - b * Y) / 6;
    dz = (Math.sin(X) - b * Z) / 6;
  } else if (type === "dadras") {
    const X = nx * 9;
    const Y = ny * 9;
    const Z = (nz + 1) * 7;
    const a = 3;
    const b = 2.7;
    const c = 1.7;
    const d = 2;
    const e = 9;
    dx = (Y - a * X + b * Y * Z) / 9;
    dy = (c * Y - X * Z + Z) / 9;
    dz = (d * X * Y - e * Z) / 7;
  }

  [dx, dy, dz] = softLimitVector(dx, dy, dz, 2.6, 6.8);

  // Treat the mathematical vector field as a desired first-order velocity.
  // Steering toward that velocity preserves each attractor's characteristic
  // path while still fitting the visualizer's existing damping/audio-reactive
  // integration model and allowing smooth interpolation in Morph mode.
  const attractorSpeedScale = {
    lorenz: 0.55,
    rossler: 0.28,
    halvorsen: 0.14,
    aizawa: 0.16,
    thomas: 0.9,
    dadras: 0.18
  }[type] || 0.35;
  // Keep the attractor vector field itself independent of loudness. Audio
  // controls traversal later in the integration step, so changing magnitude
  // cannot reshape the Lorenz/Rössler/etc. field or alter its characteristic
  // geometry.
  const fieldGain =
    boundary *
    (0.18 + movement.cohesion * 0.025) *
    attractorSpeedScale;
  const desiredVelocityX = dx * fieldGain;
  const desiredVelocityY = dy * fieldGain;
  const desiredVelocityZ = dz * fieldGain;
  // Keep steering independent of loudness. Audio should time-dilate traversal,
  // not change how strongly particles are pulled toward the field, because the
  // latter visibly deforms the attractor at high levels.
  const steering = 1.2 + movement.alignment * 0.4;
  const particleOffset = ((index % 97) / 96 - 0.5) * 0.004;
  const normalizedRadius = Math.sqrt(nx * nx + ny * ny + nz * nz);
  const softContainment = Math.max(0, normalizedRadius - 1.08) * 1.9;

  output[0] =
    (desiredVelocityX - velocityX) * steering +
    noiseX * 0.004 +
    particleOffset -
    nx * softContainment;
  output[1] =
    (desiredVelocityY - velocityY) * steering +
    noiseY * 0.004 -
    particleOffset * 0.5 -
    ny * softContainment;
  output[2] =
    (desiredVelocityZ - velocityZ) * steering +
    noiseZ * 0.004 +
    particleOffset * 0.35 -
    nz * softContainment;
}

function writeModeAcceleration(
  output,
  type,
  index,
  pool,
  activeCount,
  x,
  y,
  z,
  velocityX,
  velocityY,
  velocityZ,
  movementTime,
  sphereBoundary,
  movement,
  audioMagnitude,
  noiseX,
  noiseY,
  noiseZ
) {
  let ax = noiseX;
  let ay = noiseY;
  let az = noiseZ;

  if (type === "flock" && activeCount > 1) {
    let averageX = 0;
    let averageY = 0;
    let averageZ = 0;
    let averageVelocityX = 0;
    let averageVelocityY = 0;
    let averageVelocityZ = 0;
    let separationX = 0;
    let separationY = 0;
    let separationZ = 0;
    let samples = 0;

    const separationRadius = Math.max(0.05, sphereBoundary * 0.34);
    const separationRadiusSquared = separationRadius * separationRadius;

    for (const offset of FLOCK_NEIGHBOR_OFFSETS) {
      const neighborIndex = (index + offset) % activeCount;
      if (neighborIndex === index) continue;
      const neighbor = pool[neighborIndex];
      averageX += neighbor.positionX;
      averageY += neighbor.positionY;
      averageZ += neighbor.positionZ;
      averageVelocityX += neighbor.velocityX;
      averageVelocityY += neighbor.velocityY;
      averageVelocityZ += neighbor.velocityZ;
      samples += 1;

      const dx = x - neighbor.positionX;
      const dy = y - neighbor.positionY;
      const dz = z - neighbor.positionZ;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      if (distanceSquared > 1e-6 && distanceSquared < separationRadiusSquared) {
        const inverse = 1 / distanceSquared;
        separationX += dx * inverse;
        separationY += dy * inverse;
        separationZ += dz * inverse;
      }
    }

    if (samples > 0) {
      const inverseSamples = 1 / samples;
      averageX *= inverseSamples;
      averageY *= inverseSamples;
      averageZ *= inverseSamples;
      averageVelocityX *= inverseSamples;
      averageVelocityY *= inverseSamples;
      averageVelocityZ *= inverseSamples;

      ax =
        noiseX * 0.32 +
        (averageVelocityX - velocityX) * movement.alignment * 0.72 +
        (averageX - x) * movement.cohesion * 0.62 +
        separationX * movement.separation * 0.12;
      ay =
        noiseY * 0.32 +
        (averageVelocityY - velocityY) * movement.alignment * 0.72 +
        (averageY - y) * movement.cohesion * 0.62 +
        separationY * movement.separation * 0.12;
      az =
        noiseZ * 0.32 +
        (averageVelocityZ - velocityZ) * movement.alignment * 0.72 +
        (averageZ - z) * movement.cohesion * 0.62 +
        separationZ * movement.separation * 0.12;
    }
  } else if (type === "swarm") {
    const targetRadius = sphereBoundary * 0.48;
    const targetX = Math.sin(movementTime * 0.83) * targetRadius;
    const targetY = Math.sin(movementTime * 0.57 + 1.7) * targetRadius * 0.62;
    const targetZ = Math.cos(movementTime * 0.71) * targetRadius;
    const radius = Math.sqrt(x * x + y * y + z * z);
    const inverseRadius = radius > 1e-6 ? 1 / radius : 0;
    const nx = x * inverseRadius;
    const ny = y * inverseRadius;
    const nz = z * inverseRadius;
    const crowding = Math.max(
      0,
      1 - radius / Math.max(sphereBoundary * 0.52, 1e-6)
    );

    ax =
      noiseX * (0.72 + movement.alignment * 0.14) +
      (targetX - x) * movement.cohesion * 0.95 +
      nx * crowding * movement.separation * 0.72;
    ay =
      noiseY * (0.72 + movement.alignment * 0.14) +
      (targetY - y) * movement.cohesion * 0.95 +
      ny * crowding * movement.separation * 0.72;
    az =
      noiseZ * (0.72 + movement.alignment * 0.14) +
      (targetZ - z) * movement.cohesion * 0.95 +
      nz * crowding * movement.separation * 0.72;
  } else if (type === "vortex") {
    const radial = Math.sqrt(x * x + z * z);
    const inverseRadial = radial > 1e-6 ? 1 / radial : 0;
    const tangentX = -z * inverseRadial;
    const tangentZ = x * inverseRadial;
    const innerPush = Math.max(
      0,
      1 - radial / Math.max(sphereBoundary * 0.42, 1e-6)
    );

    ax =
      tangentX * (0.75 + movement.alignment * 1.05) -
      x * movement.cohesion * 0.32 +
      x * innerPush * movement.separation * 0.7 +
      noiseX * 0.24;
    ay =
      Math.sin(movementTime * 1.7 + index * 0.013) *
        (0.18 + movement.alignment * 0.2) -
      y * movement.cohesion * 0.2 +
      noiseY * 0.2;
    az =
      tangentZ * (0.75 + movement.alignment * 1.05) -
      z * movement.cohesion * 0.32 +
      z * innerPush * movement.separation * 0.7 +
      noiseZ * 0.24;
  } else if (type === "orbit") {
    const phase = index * 0.017453292519943295;
    const axisX = Math.sin(phase) * 0.58;
    const axisY = 0.72;
    const axisZ = Math.cos(phase) * 0.58;

    let tangentX = axisY * z - axisZ * y;
    let tangentY = axisZ * x - axisX * z;
    let tangentZ = axisX * y - axisY * x;
    const tangentLength = Math.sqrt(
      tangentX * tangentX + tangentY * tangentY + tangentZ * tangentZ
    );
    const inverseTangent = tangentLength > 1e-6 ? 1 / tangentLength : 0;
    tangentX *= inverseTangent;
    tangentY *= inverseTangent;
    tangentZ *= inverseTangent;

    const targetRadius = sphereBoundary * 0.62;
    const positionRadius = Math.sqrt(x * x + y * y + z * z);
    const inversePosition = positionRadius > 1e-6 ? 1 / positionRadius : 0;
    const positionX = x * inversePosition;
    const positionY = y * inversePosition;
    const positionZ = z * inversePosition;
    const radialError = targetRadius - positionRadius;

    ax =
      tangentX * (0.7 + movement.alignment * 0.98) +
      positionX * radialError * movement.cohesion * 0.85 +
      positionX * movement.separation * 0.06 +
      noiseX * 0.18;
    ay =
      tangentY * (0.7 + movement.alignment * 0.98) +
      positionY * radialError * movement.cohesion * 0.85 +
      positionY * movement.separation * 0.06 +
      noiseY * 0.18;
    az =
      tangentZ * (0.7 + movement.alignment * 0.98) +
      positionZ * radialError * movement.cohesion * 0.85 +
      positionZ * movement.separation * 0.06 +
      noiseZ * 0.18;
  } else if (type === "liquid") {
    writeLiquidAcceleration(
      output,
      index,
      pool,
      activeCount,
      x,
      y,
      z,
      velocityX,
      velocityY,
      velocityZ,
      movementTime,
      sphereBoundary,
      movement,
      audioMagnitude,
      noiseX,
      noiseY,
      noiseZ
    );
    return;
  } else if (ATTRACTOR_TYPE_SET.has(type)) {
    writeAttractorAcceleration(
      output,
      type,
      index,
      x,
      y,
      z,
      velocityX,
      velocityY,
      velocityZ,
      sphereBoundary,
      movement,
      movement.audioMagnitude ?? audioMagnitude,
      noiseX,
      noiseY,
      noiseZ
    );
    return;
  }

  output[0] = ax;
  output[1] = ay;
  output[2] = az;
}

export const noise = new SimplexNoise(Math.random());

export class Particle {
  constructor(sphereBoundary = 1.0) {
    this.positionX = 0;
    this.positionY = 0;
    this.positionZ = 0;
    this.velocityX = 0;
    this.velocityY = 0;
    this.velocityZ = 0;
    this.colorR = 1;
    this.colorG = 1;
    this.colorB = 1;
    this.reset(sphereBoundary);
  }

  reset(sphereBoundary = 1.0) {
    // Uniform distribution through the sphere volume (cube root of random).
    const radius = Math.cbrt(Math.random()) * sphereBoundary;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);

    this.positionX = radius * Math.sin(phi) * Math.cos(theta);
    this.positionY = radius * Math.sin(phi) * Math.sin(theta);
    this.positionZ = radius * Math.cos(phi);

    this.velocityX = 0;
    this.velocityY = 0;
    this.velocityZ = 0;
  }

  update(
    index,
    pool,
    activeCount,
    time,
    amplitude,
    noiseScale,
    sphereBoundary,
    damping,
    movement
  ) {
    const x = this.positionX;
    const y = this.positionY;
    const z = this.positionZ;
    const speed = movement.speed;
    const amount = movement.amount;
    const movementTime = time * speed;

    // Original 4D noise field with axis decorrelation offsets.
    const noiseX = noise.noise4D(
      x * noiseScale,
      y * noiseScale,
      z * noiseScale,
      movementTime
    );
    const noiseY = noise.noise4D(
      (x + 100) * noiseScale,
      (y + 100) * noiseScale,
      (z + 100) * noiseScale,
      movementTime
    );
    const noiseZ = noise.noise4D(
      (x + 200) * noiseScale,
      (y + 200) * noiseScale,
      (z + 200) * noiseScale,
      movementTime
    );

    let ax = noiseX;
    let ay = noiseY;
    let az = noiseZ;

    if (movement.type === "morph") {
      const blend = getMorphBlend(
        movement.morphScope,
        time,
        movement.morphSpeed
      );
      const smoothMix = blend.mix;

      writeModeAcceleration(
        MORPH_ACCEL_A,
        blend.typeA,
        index,
        pool,
        activeCount,
        x,
        y,
        z,
        this.velocityX,
        this.velocityY,
        this.velocityZ,
        movementTime,
        sphereBoundary,
        movement,
        amplitude,
        noiseX,
        noiseY,
        noiseZ
      );
      writeModeAcceleration(
        MORPH_ACCEL_B,
        blend.typeB,
        index,
        pool,
        activeCount,
        x,
        y,
        z,
        this.velocityX,
        this.velocityY,
        this.velocityZ,
        movementTime,
        sphereBoundary,
        movement,
        amplitude,
        noiseX,
        noiseY,
        noiseZ
      );

      ax = MORPH_ACCEL_A[0] + (MORPH_ACCEL_B[0] - MORPH_ACCEL_A[0]) * smoothMix;
      ay = MORPH_ACCEL_A[1] + (MORPH_ACCEL_B[1] - MORPH_ACCEL_A[1]) * smoothMix;
      az = MORPH_ACCEL_A[2] + (MORPH_ACCEL_B[2] - MORPH_ACCEL_A[2]) * smoothMix;
    } else if (movement.type === "flock" && activeCount > 1) {
      let averageX = 0;
      let averageY = 0;
      let averageZ = 0;
      let averageVelocityX = 0;
      let averageVelocityY = 0;
      let averageVelocityZ = 0;
      let separationX = 0;
      let separationY = 0;
      let separationZ = 0;
      let samples = 0;

      const separationRadius = Math.max(0.05, sphereBoundary * 0.34);
      const separationRadiusSquared = separationRadius * separationRadius;

      for (const offset of FLOCK_NEIGHBOR_OFFSETS) {
        const neighborIndex = (index + offset) % activeCount;
        if (neighborIndex === index) continue;
        const neighbor = pool[neighborIndex];
        averageX += neighbor.positionX;
        averageY += neighbor.positionY;
        averageZ += neighbor.positionZ;
        averageVelocityX += neighbor.velocityX;
        averageVelocityY += neighbor.velocityY;
        averageVelocityZ += neighbor.velocityZ;
        samples += 1;

        const dx = x - neighbor.positionX;
        const dy = y - neighbor.positionY;
        const dz = z - neighbor.positionZ;
        const distanceSquared = dx * dx + dy * dy + dz * dz;
        if (distanceSquared > 1e-6 && distanceSquared < separationRadiusSquared) {
          const inverse = 1 / distanceSquared;
          separationX += dx * inverse;
          separationY += dy * inverse;
          separationZ += dz * inverse;
        }
      }

      if (samples > 0) {
        const inverseSamples = 1 / samples;
        averageX *= inverseSamples;
        averageY *= inverseSamples;
        averageZ *= inverseSamples;
        averageVelocityX *= inverseSamples;
        averageVelocityY *= inverseSamples;
        averageVelocityZ *= inverseSamples;

        const alignment = movement.alignment;
        const cohesion = movement.cohesion;
        const separation = movement.separation;

        ax =
          noiseX * 0.32 +
          (averageVelocityX - this.velocityX) * alignment * 0.72 +
          (averageX - x) * cohesion * 0.62 +
          separationX * separation * 0.12;
        ay =
          noiseY * 0.32 +
          (averageVelocityY - this.velocityY) * alignment * 0.72 +
          (averageY - y) * cohesion * 0.62 +
          separationY * separation * 0.12;
        az =
          noiseZ * 0.32 +
          (averageVelocityZ - this.velocityZ) * alignment * 0.72 +
          (averageZ - z) * cohesion * 0.62 +
          separationZ * separation * 0.12;
      }
    } else if (movement.type === "swarm") {
      const targetRadius = sphereBoundary * 0.48;
      const targetX = Math.sin(movementTime * 0.83) * targetRadius;
      const targetY = Math.sin(movementTime * 0.57 + 1.7) * targetRadius * 0.62;
      const targetZ = Math.cos(movementTime * 0.71) * targetRadius;
      const radius = Math.sqrt(x * x + y * y + z * z);
      const inverseRadius = radius > 1e-6 ? 1 / radius : 0;
      const nx = x * inverseRadius;
      const ny = y * inverseRadius;
      const nz = z * inverseRadius;
      const crowding = Math.max(0, 1 - radius / Math.max(sphereBoundary * 0.52, 1e-6));

      ax =
        noiseX * (0.72 + movement.alignment * 0.14) +
        (targetX - x) * movement.cohesion * 0.95 +
        nx * crowding * movement.separation * 0.72;
      ay =
        noiseY * (0.72 + movement.alignment * 0.14) +
        (targetY - y) * movement.cohesion * 0.95 +
        ny * crowding * movement.separation * 0.72;
      az =
        noiseZ * (0.72 + movement.alignment * 0.14) +
        (targetZ - z) * movement.cohesion * 0.95 +
        nz * crowding * movement.separation * 0.72;
    } else if (movement.type === "vortex") {
      const radial = Math.sqrt(x * x + z * z);
      const inverseRadial = radial > 1e-6 ? 1 / radial : 0;
      const tangentX = -z * inverseRadial;
      const tangentZ = x * inverseRadial;
      const innerPush = Math.max(
        0,
        1 - radial / Math.max(sphereBoundary * 0.42, 1e-6)
      );

      ax =
        tangentX * (0.75 + movement.alignment * 1.05) -
        x * movement.cohesion * 0.32 +
        x * innerPush * movement.separation * 0.7 +
        noiseX * 0.24;
      ay =
        Math.sin(movementTime * 1.7 + index * 0.013) *
          (0.18 + movement.alignment * 0.2) -
        y * movement.cohesion * 0.2 +
        noiseY * 0.2;
      az =
        tangentZ * (0.75 + movement.alignment * 1.05) -
        z * movement.cohesion * 0.32 +
        z * innerPush * movement.separation * 0.7 +
        noiseZ * 0.24;
    } else if (movement.type === "orbit") {
      const phase = index * 0.017453292519943295;
      const axisX = Math.sin(phase) * 0.58;
      const axisY = 0.72;
      const axisZ = Math.cos(phase) * 0.58;

      // Cross(axis, position) gives a tangential orbital direction.
      let tangentX = axisY * z - axisZ * y;
      let tangentY = axisZ * x - axisX * z;
      let tangentZ = axisX * y - axisY * x;
      const tangentLength = Math.sqrt(
        tangentX * tangentX + tangentY * tangentY + tangentZ * tangentZ
      );
      const inverseTangent = tangentLength > 1e-6 ? 1 / tangentLength : 0;
      tangentX *= inverseTangent;
      tangentY *= inverseTangent;
      tangentZ *= inverseTangent;

      const targetRadius = sphereBoundary * 0.62;
      const positionRadius = Math.sqrt(x * x + y * y + z * z);
      const inversePosition = positionRadius > 1e-6 ? 1 / positionRadius : 0;
      const positionX = x * inversePosition;
      const positionY = y * inversePosition;
      const positionZ = z * inversePosition;
      const radialError = targetRadius - positionRadius;

      ax =
        tangentX * (0.7 + movement.alignment * 0.98) +
        positionX * radialError * movement.cohesion * 0.85 +
        positionX * movement.separation * 0.06 +
        noiseX * 0.18;
      ay =
        tangentY * (0.7 + movement.alignment * 0.98) +
        positionY * radialError * movement.cohesion * 0.85 +
        positionY * movement.separation * 0.06 +
        noiseY * 0.18;
      az =
        tangentZ * (0.7 + movement.alignment * 0.98) +
        positionZ * radialError * movement.cohesion * 0.85 +
        positionZ * movement.separation * 0.06 +
        noiseZ * 0.18;
    } else if (movement.type === "liquid") {
      writeLiquidAcceleration(
        LIQUID_ACCEL,
        index,
        pool,
        activeCount,
        x,
        y,
        z,
        this.velocityX,
        this.velocityY,
        this.velocityZ,
        movementTime,
        sphereBoundary,
        movement,
        amplitude,
        noiseX,
        noiseY,
        noiseZ
      );
      ax = LIQUID_ACCEL[0];
      ay = LIQUID_ACCEL[1];
      az = LIQUID_ACCEL[2];
    } else if (ATTRACTOR_TYPE_SET.has(movement.type)) {
      writeAttractorAcceleration(
        ATTRACTOR_ACCEL,
        movement.type,
        index,
        x,
        y,
        z,
        this.velocityX,
        this.velocityY,
        this.velocityZ,
        sphereBoundary,
        movement,
        movement.audioMagnitude ?? amplitude,
        noiseX,
        noiseY,
        noiseZ
      );
      ax = ATTRACTOR_ACCEL[0];
      ay = ATTRACTOR_ACCEL[1];
      az = ATTRACTOR_ACCEL[2];
    }

    // At the defaults, Flow uses the original gain expression exactly.
    // Attractor modes carry loudness in their target velocity instead, so do
    // not multiply them again by the bass-only amplitude term.
    const usesDirectAttractorTraversal =
      ATTRACTOR_TYPE_SET.has(movement.type) ||
      (movement.type === "morph" && movement.morphScope === "attractors");
    const attractorEnergy = Math.max(
      0,
      Math.min(1, movement.audioMagnitude ?? amplitude)
    );
    // Make loudness affect the distance travelled along the already-computed
    // attractor tangent, not the field itself, so the equations and their
    // orientation are never deformed by level.
    //
    // The curve is a gamma rather than the previous smoothstep. Smoothstep has
    // zero derivative at both ends, so it was least sensitive exactly where the
    // signal spends most of its time — a 4x amplitude jump between sections
    // produced only a 1.63x traversal jump. An exponent above 1 expands loud
    // contrast; below 1 expands quiet detail.
    const traversalCurve = Math.max(0.05, movement.traversalCurve ?? 1.8);
    const energyCurve = Math.pow(attractorEnergy, traversalCurve);
    const beatBoost =
      (movement.beatImpulse ?? 0) * (movement.beatTraversalBoost ?? 0);
    const attractorTraversal = usesDirectAttractorTraversal
      ? Math.max(
          0,
          (movement.traversalFloor ?? 0.25) +
            energyCurve * (movement.traversalRange ?? 8) +
            beatBoost
        )
      : 1;
    // For chaotic attractors, Movement Amount controls only how tightly the
    // particle steers toward the mathematical vector field. Movement Speed is
    // deliberately excluded here so it is not applied twice. The manual speed
    // control is applied exactly once in the final trajectory traversal step
    // below, alongside the audio-derived time-dilation multiplier.
    const gain =
      DT *
      (usesDirectAttractorTraversal ? 1 : 0.25 + amplitude * 1.75) *
      amount *
      (usesDirectAttractorTraversal ? 1 : speed);

    // Chaotic-attractor traversal rate = attractor field baseline × manual
    // Movement Speed × audio traversal multiplier. The field baseline is
    // already encoded in writeAttractorAcceleration(); this is the only place
    // Movement Speed changes how quickly attractor particles advance.
    const positionStep = DT * speed * attractorTraversal;

    // Loud passages advance the position so far per step that the steered
    // velocity lags the field, and the manifold visibly swells — measured at
    // 1.7x mean radius from quiet to loud on the unmodified build. This is not
    // Euler truncation error; it is the steering model, so the fix is to hold
    // velocity relaxations per unit of path advanced constant rather than to
    // subdivide for accuracy.
    const needsSubStepping =
      ATTRACTOR_TYPE_SET.has(movement.type) &&
      positionStep > ATTRACTOR_MAX_POSITION_STEP;

    if (needsSubStepping) {
      const subSteps = Math.min(
        ATTRACTOR_MAX_SUBSTEPS,
        Math.ceil(positionStep / ATTRACTOR_MAX_POSITION_STEP)
      );
      // Full gain and full damping per sub-step — deliberately NOT divided.
      // The quantity that shapes the manifold is velocity relaxations per unit
      // of path advanced. Dividing them would preserve the ratio that causes
      // the deformation; keeping them at full strength restores one relaxation
      // per nominal step of travel, which is what holds the geometry fixed.
      const subGain = gain;
      const subPositionStep = positionStep / subSteps;
      const subDamping = damping;

      for (let subStep = 0; subStep < subSteps; subStep += 1) {
        writeAttractorAcceleration(
          ATTRACTOR_ACCEL,
          movement.type,
          index,
          this.positionX,
          this.positionY,
          this.positionZ,
          this.velocityX,
          this.velocityY,
          this.velocityZ,
          sphereBoundary,
          movement,
          movement.audioMagnitude ?? amplitude,
          noiseX,
          noiseY,
          noiseZ
        );

        this.velocityX =
          this.velocityX * subDamping + ATTRACTOR_ACCEL[0] * subGain;
        this.velocityY =
          this.velocityY * subDamping + ATTRACTOR_ACCEL[1] * subGain;
        this.velocityZ =
          this.velocityZ * subDamping + ATTRACTOR_ACCEL[2] * subGain;

        this.positionX += this.velocityX * subPositionStep;
        this.positionY += this.velocityY * subPositionStep;
        this.positionZ += this.velocityZ * subPositionStep;
      }
    } else {
      this.velocityX = this.velocityX * damping + ax * gain;
      this.velocityY = this.velocityY * damping + ay * gain;
      this.velocityZ = this.velocityZ * damping + az * gain;

      this.positionX += this.velocityX * positionStep;
      this.positionY += this.velocityY * positionStep;
      this.positionZ += this.velocityZ * positionStep;
    }

    const usesAttractorBounds =
      ATTRACTOR_TYPE_SET.has(movement.type) ||
      (movement.type === "morph" && movement.morphScope === "attractors");

    if (usesAttractorBounds) {
      // Chaotic attractors are defined in Cartesian state spaces. A spherical
      // projection clips their lobes and rings, so keep them inside the same
      // nominal size with per-axis bounds instead. Anything that escapes is
      // re-seeded onto the manifold rather than bounced off the box.
      const limit = sphereBoundary * 1.35;
      if (
        this.positionX > limit ||
        this.positionX < -limit ||
        this.positionY > limit ||
        this.positionY < -limit ||
        this.positionZ > limit ||
        this.positionZ < -limit
      ) {
        respawnOnManifold(this, index, pool, activeCount, limit, sphereBoundary);
      }
    } else {
      // Boid simulations retain the original spherical confinement model.
      const distanceSquared =
        this.positionX * this.positionX +
        this.positionY * this.positionY +
        this.positionZ * this.positionZ;
      const distance = Math.sqrt(distanceSquared);

      if (distance > sphereBoundary) {
        const factor = sphereBoundary / distance;
        this.positionX *= factor;
        this.positionY *= factor;
        this.positionZ *= factor;

        const nx = this.positionX / sphereBoundary;
        const ny = this.positionY / sphereBoundary;
        const nz = this.positionZ / sphereBoundary;
        const dot =
          this.velocityX * nx + this.velocityY * ny + this.velocityZ * nz;

        if (movement.type === "liquid") {
          // Water loses energy against the container instead of elastically
          // ricocheting around it. Keep tangential motion for visible sloshing
          // while heavily damping the outward normal component.
          if (dot > 0) {
            const restitution = 0.08;
            this.velocityX -= (1 + restitution) * dot * nx;
            this.velocityY -= (1 + restitution) * dot * ny;
            this.velocityZ -= (1 + restitution) * dot * nz;
          }
          this.velocityX *= 0.86;
          this.velocityY *= 0.72;
          this.velocityZ *= 0.86;
        } else {
          this.velocityX -= 2 * dot * nx;
          this.velocityY -= 2 * dot * ny;
          this.velocityZ -= 2 * dot * nz;
        }
      }
    }
  }
}

export const particles = [];
for (let index = 0; index < PARTICLE_POOL; index += 1) {
  particles.push(new Particle(1.0));
}

/** Re-seed the whole pool — used by Reset and by a sphere-boundary change. */
export function reseedParticles(sphereBoundary) {
  for (let index = 0; index < PARTICLE_POOL; index += 1) {
    particles[index].reset(sphereBoundary);
  }
}
