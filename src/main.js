import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import {
  state,
  env,
  updateClock,
  formatClock,
  setWeatherPreset,
  WEATHER_PRESETS,
} from './environment.js';
import { createIsland } from './island.js';
import { createWater } from './water.js';
import { createVegetation } from './vegetation.js';
import { createSky } from './sky.js';
import { createWeather } from './weather.js';
import { createStructures } from './structures.js';
import { createPostFX } from './postfx.js';

// ---------------------------------------------------------------------------
// Renderer + scene
// ---------------------------------------------------------------------------

const canvas = document.querySelector('#scene');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  stencil: false,
  powerPreference: 'high-performance',
});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
// Real-time shadow maps are deliberately disabled: the post-processing HDR
// path on this renderer/model combination rejects the shadow depth sampler.
// Grounding comes from baked terrain AO, contact shading and fog instead.
renderer.shadowMap.enabled = false;
renderer.setClearColor(0x071217, 1);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xbfd6de, 0.0024);

const camera = new THREE.PerspectiveCamera(
  46,
  window.innerWidth / window.innerHeight,
  0.1,
  3200,
);
camera.position.set(42, 15, 49);
const isPortrait = window.innerWidth / Math.max(window.innerHeight, 1) < 0.82;
if (isPortrait) {
  // A narrow phone screen needs a longer lens distance to keep the whole
  // island and lighthouse in frame behind the HUD.
  camera.fov = 52;
  camera.position.set(76, 27, 89);
  camera.updateProjectionMatrix();
}

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, isPortrait ? 6.6 : 6.0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.055;
controls.rotateSpeed = 0.62;
controls.zoomSpeed = 0.82;
controls.panSpeed = 0.65;
controls.minDistance = 17;
controls.maxDistance = 138;
controls.minPolarAngle = 0.18;
controls.maxPolarAngle = Math.PI * 0.495;
controls.screenSpacePanning = false;
controls.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.PAN,
};
controls.touches = {
  ONE: THREE.TOUCH.ROTATE,
  TWO: THREE.TOUCH.DOLLY_PAN,
};
controls.update();

// ---------------------------------------------------------------------------
// Procedural world
// ---------------------------------------------------------------------------

const world = {
  island: null,
  water: null,
  vegetation: null,
  sky: null,
  weather: null,
  structures: null,
};

function buildWorld() {
  const attempts = [
    ['island', () => createIsland(scene)],
    ['structures', () => createStructures(scene)],
    ['vegetation', () => createVegetation(scene)],
    ['water', () => createWater(scene, renderer)],
    ['sky', () => createSky(scene)],
    ['weather', () => createWeather(scene, camera)],
  ];
  for (const [name, factory] of attempts) {
    try {
      world[name] = factory();
      console.info(`[isla] ${name} ready`);
    } catch (error) {
      console.error(`[isla] failed to build ${name}`, error);
    }
  }
  if (world.weather && typeof world.weather.setPreset === 'function') {
    world.weather.setPreset(state.weather);
  }
}

buildWorld();

const post = createPostFX(renderer, scene, camera);

// ---------------------------------------------------------------------------
// Quality / adaptive resolution
// ---------------------------------------------------------------------------

const nativeDpr = Math.min(window.devicePixelRatio || 1, 1.5);
const QUALITY_LEVELS = [
  { dpr: nativeDpr, reflection: 0.5, label: '反射 1/2' },
  { dpr: Math.max(0.9, nativeDpr * 0.82), reflection: 0.4, label: '反射 2/5' },
  { dpr: Math.max(0.8, nativeDpr * 0.66), reflection: 0.32, label: '反射 1/3' },
];
let qualityIndex = 0;

function applyQuality(index) {
  qualityIndex = THREE.MathUtils.clamp(index, 0, QUALITY_LEVELS.length - 1);
  state.quality = qualityIndex;
  const level = QUALITY_LEVELS[qualityIndex];
  renderer.setPixelRatio(level.dpr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  post.setSize(window.innerWidth, window.innerHeight, level.dpr);
  if (world.water) {
    if (typeof world.water.resize === 'function') world.water.resize();
    if (typeof world.water.setReflectionScale === 'function') {
      world.water.setReflectionScale(level.reflection);
    }
  }
  const label = document.querySelector('#qualityLabel');
  if (label) label.textContent = level.label;
}

applyQuality(0);

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(QUALITY_LEVELS[qualityIndex].dpr);
  renderer.setSize(width, height);
  post.setSize(width, height, QUALITY_LEVELS[qualityIndex].dpr);
  if (world.water && typeof world.water.resize === 'function') world.water.resize();
}

window.addEventListener('resize', resize);

// ---------------------------------------------------------------------------
// HUD / controls
// ---------------------------------------------------------------------------

const clockEl = document.querySelector('#clock');
const slider = document.querySelector('#timeSlider');
const daypartEl = document.querySelector('#daypart');
const autoBtn = document.querySelector('#autoBtn');
const weatherButtons = [...document.querySelectorAll('.weather-btn')];
const fpsEl = document.querySelector('#fps');
const timeFootMood = document.querySelector('.time-foot span:last-child');
const intro = document.querySelector('#intro');

let scrubbing = false;

function daypartFor(hours) {
  if (hours < 4.6) return ['深夜', 'MIDNIGHT'];
  if (hours < 7.0) return ['黎明', 'DAWN'];
  if (hours < 11.2) return ['上午', 'MORNING'];
  if (hours < 13.6) return ['正午', 'HIGH NOON'];
  if (hours < 16.6) return ['下午', 'AFTERNOON'];
  if (hours < 19.3) return ['黄昏', 'BLUE HOUR'];
  if (hours < 21.5) return ['暮色', 'DUSK'];
  return ['深夜', 'NIGHT'];
}

function moodFor(hours) {
  if (hours < 5.2) return 'MOONLIGHT';
  if (hours < 7.4) return 'FIRST LIGHT';
  if (hours < 11.0) return 'SOFT SUNLIGHT';
  if (hours < 14.0) return 'HARD SUN';
  if (hours < 17.5) return 'WARM HAZE';
  if (hours < 19.6) return 'GOLDEN HOUR';
  if (hours < 21.5) return 'LAST LIGHT';
  return 'MOONLIGHT';
}

function setWeather(name) {
  if (!WEATHER_PRESETS[name]) return;
  setWeatherPreset(name);
  if (world.weather && typeof world.weather.setPreset === 'function') {
    world.weather.setPreset(name);
  }
  for (const button of weatherButtons) {
    const active = button.dataset.weather === name;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  syncAutoButton();
}

function syncAutoButton() {
  if (!autoBtn) return;
  autoBtn.classList.toggle('is-on', state.autoTime);
  autoBtn.setAttribute('aria-pressed', String(state.autoTime));
  const label = autoBtn.querySelector('span:last-child');
  if (label) label.textContent = state.autoTime ? '自动流转' : '已暂停';
}

function updateHud(fps) {
  if (clockEl) clockEl.textContent = formatClock(state.timeOfDay);
  if (slider && !scrubbing) {
    slider.value = String(state.timeTarget);
    slider.style.setProperty('--pct', `${(state.timeTarget / 24) * 100}%`);
  }
  if (daypartEl) {
    const [cn, en] = daypartFor(state.timeOfDay);
    daypartEl.textContent = `${cn} · ${en}`;
  }
  if (timeFootMood) timeFootMood.textContent = moodFor(state.timeOfDay);
  if (fpsEl && fps !== undefined) fpsEl.textContent = String(Math.round(fps));
}

for (const button of weatherButtons) {
  button.addEventListener('click', () => setWeather(button.dataset.weather));
}

if (autoBtn) {
  autoBtn.addEventListener('click', () => {
    state.autoTime = !state.autoTime;
    if (state.autoTime) {
      // Avoid a sudden 12-hour jump when re-enabling the clock.
      state.timeTarget = state.timeOfDay;
    }
    syncAutoButton();
  });
}

if (slider) {
  slider.addEventListener('pointerdown', () => {
    scrubbing = true;
  });
  const stopScrubbing = () => {
    scrubbing = false;
  };
  slider.addEventListener('pointerup', stopScrubbing);
  slider.addEventListener('pointercancel', stopScrubbing);
  slider.addEventListener('input', () => {
    const value = Number(slider.value);
    state.autoTime = false;
    state.timeTarget = value;
    slider.style.setProperty('--pct', `${(value / 24) * 100}%`);
    syncAutoButton();
  });
}

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === '1') setWeather('clear');
  if (event.key === '2') setWeather('storm');
  if (event.key === '3') setWeather('night');
  if (event.code === 'Space') {
    event.preventDefault();
    state.autoTime = !state.autoTime;
    if (state.autoTime) state.timeTarget = state.timeOfDay;
    syncAutoButton();
  }
});

syncAutoButton();
updateHud();

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

const timer = new THREE.Timer();
timer.connect(document);
let elapsed = 0;
let frameCount = 0;
let fps = 60;
let fpsFrames = 0;
let fpsWindowStart = performance.now();
let qualityTimer = 0;
let firstFrameRendered = false;
let introHidden = false;
let hasUserInteracted = false;

controls.addEventListener('start', () => {
  hasUserInteracted = true;
});

function hideIntroSoon() {
  if (introHidden) return;
  introHidden = true;
  window.setTimeout(() => {
    if (intro) intro.classList.add('is-hidden');
  }, 420);
}

function handleAdaptiveQuality(dt) {
  if (elapsed < 7 || qualityIndex >= QUALITY_LEVELS.length - 1) return;
  qualityTimer += dt;
  if (qualityTimer < 3.2) return;
  qualityTimer = 0;
  // Ignore the initial shader-compile frames and tab-back stalls.
  if (fps > 0 && fps < 38) {
    console.info(`[isla] low fps (${fps.toFixed(1)}), reducing resolution tier`);
    applyQuality(qualityIndex + 1);
  }
}

function animate() {
  requestAnimationFrame(animate);
  if (window.__ISLA_PAUSED__) return;

  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05);
  elapsed += dt;

  updateClock(dt);

  for (const controlsTick of [controls]) controlsTick.update();
  if (world.weather) world.weather.update(dt, state, env);
  if (world.sky) world.sky.update(dt, state, env, camera);

  if (scene.fog) {
    scene.fog.color.copy(env.fogColor);
    scene.fog.density = env.fogDensity;
  }
  renderer.toneMappingExposure = env.exposure;
  renderer.setClearColor(env.fogColor, 1);

  if (world.island) world.island.update(dt, env);
  if (world.vegetation) world.vegetation.update(dt, env);
  if (world.structures) world.structures.update(dt, env);
  if (world.water) world.water.update(dt, camera, env);

  post.update(dt, env);
  post.render(dt);

  frameCount++;
  fpsFrames++;
  const now = performance.now();
  if (now - fpsWindowStart > 520) {
    fps = (fpsFrames * 1000) / (now - fpsWindowStart);
    fpsWindowStart = now;
    fpsFrames = 0;
    updateHud(fps);
  } else {
    updateHud();
  }

  handleAdaptiveQuality(dt);

  if (!firstFrameRendered) {
    firstFrameRendered = true;
    hideIntroSoon();
  }
}

if (world.water && typeof world.water.resize === 'function') world.water.resize();
requestAnimationFrame(animate);

// ---------------------------------------------------------------------------
// Small debug / QA API (also useful for automated screenshots)
// ---------------------------------------------------------------------------

window.ISLA = {
  THREE,
  scene,
  camera,
  renderer,
  controls,
  state,
  env,
  world,
  post,
  qualityLevels: QUALITY_LEVELS,
  setTime(hours) {
    state.autoTime = false;
    state.timeTarget = THREE.MathUtils.euclideanModulo(Number(hours) || 0, 24);
    syncAutoButton();
  },
  setWeather,
  setAutoTime(value) {
    state.autoTime = Boolean(value);
    if (state.autoTime) state.timeTarget = state.timeOfDay;
    syncAutoButton();
  },
  setQuality(index) {
    applyQuality(index);
  },
  setCamera(position, target) {
    if (Array.isArray(position)) camera.position.set(...position);
    if (Array.isArray(target)) controls.target.set(...target);
    controls.update();
  },
  snapshot() {
    return {
      fps,
      quality: qualityIndex,
      qualityLabel: QUALITY_LEVELS[qualityIndex].label,
      timeOfDay: state.timeOfDay,
      timeTarget: state.timeTarget,
      weather: state.weather,
      autoTime: state.autoTime,
      stormMix: env.stormMix,
      dayFactor: env.dayFactor,
      nightFactor: env.nightFactor,
      sunDir: env.sunDir.toArray(),
      counts: {
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        palms: world.vegetation?.palmCount,
        grass: world.vegetation?.grassCount,
        rain: world.weather?.rainCount,
      },
    };
  },
};

// Surface fatal runtime errors instead of a silent black canvas.
window.addEventListener('error', (event) => {
  console.error('[isla] runtime error', event.error || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[isla] unhandled rejection', event.reason);
});
