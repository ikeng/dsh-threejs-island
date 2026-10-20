import * as THREE from 'three';

/**
 * Shared, mutable state for the whole island.
 *
 * `state` is driven by the UI / main loop (time, weather preset, quality).
 * `env` is published every frame by the atmosphere layer and is read by the
 * ocean, terrain, vegetation, structures and post-processing. Keeping it in one
 * place is what guarantees the waterline, lighting and weather all agree.
 */
export const state = {
  /** Eased clock used for lighting, 0..24 (hours). */
  timeOfDay: 9.6,
  /** The clock the UI is easing towards (and auto-flow advances). */
  timeTarget: 9.6,
  /** Whether the clock advances by itself. */
  autoTime: true,
  /** Hours per real second when auto-flow is on. A full day takes ~20 min. */
  timeSpeed: 0.02,
  /** 'clear' | 'storm' | 'night' — the three requested weather presets. */
  weather: 'clear',
  /** Overall quality scale used by adaptive resolution (main loop). */
  quality: 1,
  paused: false,
};

export const WEATHER_PRESETS = {
  clear: { label: '晴天', icon: 'sun', time: 9.6 },
  storm: { label: '暴雨', icon: 'storm', time: 16.25 },
  night: { label: '夜晚', icon: 'moon', time: 22.4 },
};

export const env = {
  timeOfDay: state.timeOfDay,

  // Celestial geometry, published by sky.js.
  sunDir: new THREE.Vector3(0.35, 0.82, 0.45).normalize(),
  moonDir: new THREE.Vector3(-0.35, -0.82, -0.45).normalize(),
  sunColor: new THREE.Color('#fff1d0'),
  moonColor: new THREE.Color('#9fb7ff'),
  sunIntensity: 2.7,
  moonIntensity: 0,

  // 0 = no daylight, 1 = full day. Crepuscular values ease through twilight.
  dayFactor: 1,
  nightFactor: 0,
  twilightFactor: 0,

  // Weather mixes, both eased by weather.js over several seconds.
  stormMix: 0,
  rain: 0,
  lightning: 0,
  cloudCover: 0.38,
  cloudSpeed: 1,
  windStrength: 0.35,
  windDir: new THREE.Vector2(1, 0.35).normalize(),
  waveScale: 1,
  rainAmount: 0,

  // Atmosphere / grading values, published by sky.js and weather.js.
  skyZenith: new THREE.Color('#3b79bd'),
  skyHorizon: new THREE.Color('#cfe4ed'),
  fogColor: new THREE.Color('#bed8e2'),
  fogDensity: 0.0024,
  exposure: 1.0,
  bloomStrength: 0.5,
  bloomThreshold: 0.82,

  // Fine-grained values for shaders that cannot read THREE.Color uniforms directly.
  sunColorVec: new THREE.Vector3(1, 0.94, 0.82),
  skyHorizonVec: new THREE.Vector3(0.81, 0.89, 0.93),
};

/** Convenience accessor used by UI + keyboard shortcuts. */
export function setWeatherPreset(name) {
  const preset = WEATHER_PRESETS[name];
  if (!preset) return;
  state.weather = name;
  state.autoTime = false;
  state.timeTarget = preset.time;
}

export function setTimeOfDay(hours) {
  state.autoTime = false;
  state.timeTarget = THREE.MathUtils.euclideanModulo(hours, 24);
}

/** Smoothly move the displayed clock towards the requested clock. */
export function updateClock(dt) {
  if (state.autoTime) {
    state.timeTarget = THREE.MathUtils.euclideanModulo(
      state.timeTarget + dt * state.timeSpeed,
      24,
    );
  }
  // Shortest path around the 24h dial.
  let delta = state.timeTarget - state.timeOfDay;
  if (delta > 12) delta -= 24;
  if (delta < -12) delta += 24;
  const maxStep = dt * 5.0; // hours per second while easing
  state.timeOfDay = THREE.MathUtils.euclideanModulo(
    state.timeOfDay + THREE.MathUtils.clamp(delta, -maxStep, maxStep),
    24,
  );
}

export function formatClock(hours) {
  const h = Math.floor(hours) % 24;
  const m = Math.floor((hours - Math.floor(hours)) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export const clamp = THREE.MathUtils.clamp;
export const lerp = THREE.MathUtils.lerp;
export const smoothstep = THREE.MathUtils.smoothstep;

export { THREE };
