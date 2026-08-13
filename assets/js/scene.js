/**
 * scene.js — Three.js scene construction.
 * Geometry, materials, camera and the selective-bloom composer chain.
 */
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

import { defaults, engine } from "./config.js";
import { elements } from "./core.js";

const {
  BLOOM_LAYER,
  PARTICLE_POOL,
  TRAIL_MAX_LENGTH,
  TRAIL_PARTICLE_CAP
} = engine;

export const canvas = elements.canvas;

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

export const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  15000
);
camera.position.set(0, 0, 50);

export const renderer = new THREE.WebGLRenderer({
  canvas,
  // Deliberately NOT antialias: true. Every frame is composited through
  // EffectComposer, whose render targets carry no MSAA, and the pass that
  // reaches the default framebuffer is a fullscreen quad with no internal
  // edges. The flag allocated a multisampled backbuffer that antialiased
  // nothing. Geometry antialiasing is done on the composer target instead.
  alpha: true,
  // Required so PNG export can read the framebuffer after a render.
  preserveDrawingBuffer: true
});
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

/* ---------------------------------------------------------------------------
   Selective bloom (swarm layer)
--------------------------------------------------------------------------- */
/**
 * Multisampled target for the pass that actually resolves to screen. WebGL2
 * only; on WebGL1 this returns null and the composer falls back to its default
 * single-sampled target, i.e. the previous behaviour.
 *
 * Only the final composer gets MSAA. The bloom chain is heavily blurred, so
 * antialiasing its source buys nothing for the bandwidth.
 */
function createMultisampleTarget(width, height) {
  if (!renderer.capabilities.isWebGL2) return null;
  const target = new THREE.WebGLMultisampleRenderTarget(width, height, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat
  });
  target.samples = 4;
  return target;
}

const initialTargetWidth = Math.max(
  1,
  Math.floor(window.innerWidth * Math.min(window.devicePixelRatio, 2))
);
const initialTargetHeight = Math.max(
  1,
  Math.floor(window.innerHeight * Math.min(window.devicePixelRatio, 2))
);

export const bloomComposer = new EffectComposer(renderer);
bloomComposer.renderToScreen = false;
bloomComposer.addPass(new RenderPass(scene, camera));

export const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.9,
  defaults.bloomRadius,
  defaults.bloomThreshold
);
bloomComposer.addPass(bloomPass);

const finalTarget = createMultisampleTarget(
  initialTargetWidth,
  initialTargetHeight
);

export const finalComposer = finalTarget
  ? new EffectComposer(renderer, finalTarget)
  : new EffectComposer(renderer);
// Passing an explicit target makes EffectComposer set its internal pixel ratio
// to 1, so setSize() must then be given device pixels rather than CSS pixels.
export const finalComposerUsesDeviceSize = Boolean(finalTarget);
finalComposer.addPass(new RenderPass(scene, camera));

const finalPass = new ShaderPass(
  new THREE.ShaderMaterial({
    uniforms: {
      baseTexture: { value: null },
      bloomTexture: { value: bloomComposer.renderTarget2.texture }
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D baseTexture;
      uniform sampler2D bloomTexture;
      varying vec2 vUv;
      void main() {
        vec4 base  = texture2D(baseTexture, vUv);
        vec4 bloom = texture2D(bloomTexture, vUv);
        gl_FragColor = base + bloom;
      }
    `,
    transparent: true
  }),
  "baseTexture"
);
finalComposer.addPass(finalPass);

/* ---------------------------------------------------------------------------
   No lighting

   Nothing in this scene is lit. PointsMaterial and LineBasicMaterial are both
   unlit, so the AmbientLight and PointLight that used to live here had no
   effect on anything rendered — they only implied a lever that does not exist.
   Colour comes entirely from the per-vertex colormap and the bloom chain.
--------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
   Circular particle sprite
--------------------------------------------------------------------------- */
function createCircleTexture() {
  const circleCanvas = document.createElement("canvas");
  circleCanvas.width = 64;
  circleCanvas.height = 64;
  const context = circleCanvas.getContext("2d");
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0.0, "rgba(255,255,255,1.0)");
  gradient.addColorStop(0.5, "rgba(255,255,255,0.8)");
  gradient.addColorStop(1.0, "rgba(255,255,255,0.0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(circleCanvas);
}

export const circleTexture = createCircleTexture();

/* ---------------------------------------------------------------------------
   Particle swarm buffers
--------------------------------------------------------------------------- */
export const swarm = {
  positions: new Float32Array(PARTICLE_POOL * 3),
  colors: new Float32Array(PARTICLE_POOL * 3)
};

export const particleGeometry = new THREE.BufferGeometry();
particleGeometry.setAttribute("position", new THREE.BufferAttribute(swarm.positions, 3));
particleGeometry.setAttribute("color", new THREE.BufferAttribute(swarm.colors, 3));
particleGeometry.setDrawRange(0, defaults.minParticles);

export const particleMaterial = new THREE.PointsMaterial({
  size: defaults.particleSize,
  map: circleTexture,
  vertexColors: true,
  transparent: true,
  opacity: defaults.particleOpacity / 100,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  sizeAttenuation: true
});

export const particleSystem = new THREE.Points(particleGeometry, particleMaterial);
particleSystem.layers.enable(BLOOM_LAYER);
scene.add(particleSystem);

/* ---------------------------------------------------------------------------
   Attractor trail ribbons

   An attractor is a trajectory; a point cloud only samples it. These line
   segments carry the curve itself. Buffers are allocated once for the worst
   case — the trail controls only change how much of them is walked per frame,
   and setDrawRange keeps the rest out of the draw call.
--------------------------------------------------------------------------- */
const TRAIL_VERTEX_CAPACITY = TRAIL_PARTICLE_CAP * (TRAIL_MAX_LENGTH - 1) * 2;

export const trailBuffers = {
  positions: new Float32Array(TRAIL_VERTEX_CAPACITY * 3),
  colors: new Float32Array(TRAIL_VERTEX_CAPACITY * 3)
};

export const trailGeometry = new THREE.BufferGeometry();
trailGeometry.setAttribute(
  "position",
  new THREE.BufferAttribute(trailBuffers.positions, 3)
);
trailGeometry.setAttribute(
  "color",
  new THREE.BufferAttribute(trailBuffers.colors, 3)
);
trailGeometry.setDrawRange(0, 0);

export const trailMaterial = new THREE.LineBasicMaterial({
  vertexColors: true,
  transparent: true,
  opacity: defaults.trailOpacity / 100,
  blending: THREE.AdditiveBlending,
  depthWrite: false
});

export const trailSystem = new THREE.LineSegments(trailGeometry, trailMaterial);
trailSystem.layers.enable(BLOOM_LAYER);
// Positions are rewritten every frame, so a cached bounding sphere would cull
// the whole object as soon as the swarm moves.
trailSystem.frustumCulled = false;
trailSystem.visible = false;
scene.add(trailSystem);

/* ---------------------------------------------------------------------------
   Sizing
--------------------------------------------------------------------------- */
export function resizeRenderer(width, height, pixelRatio) {
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  // EffectComposer caches the renderer's pixel ratio at construction and never
  // re-reads it, so without this the bloom targets keep whatever ratio was
  // current at page load. Changing the Performance preset's pixel-ratio limit
  // then leaves bloom rendering at the wrong resolution — oversampled when the
  // limit drops, and blurrier than intended when it rises.
  bloomComposer.setPixelRatio(pixelRatio);
  bloomComposer.setSize(width, height);
  if (finalComposerUsesDeviceSize) {
    finalComposer.setSize(
      Math.max(1, Math.floor(width * pixelRatio)),
      Math.max(1, Math.floor(height * pixelRatio))
    );
  } else {
    finalComposer.setSize(width, height);
  }
  bloomPass.resolution.set(width, height);
}

/** Render the selective-bloom pass, then composite over the full scene. */
export function renderScene() {
  camera.layers.set(BLOOM_LAYER);
  bloomComposer.render();
  camera.layers.set(0);
  finalComposer.render();
}
