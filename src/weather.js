import * as THREE from 'three';
import { heightAt } from './heightfield.js';

/**
 * Dynamic weather for the island: GPU rain, procedural lightning and the
 * storm / wave / wind / fog envelope.
 *
 * Responsibility split (see environment.js):
 *  - weather.js owns (and publishes) stormMix, rain / rainAmount, lightning,
 *    cloudCover, cloudSpeed, windStrength, windDir, waveScale and fogDensity.
 *  - sky.js owns celestial lighting, sky colours, exposure and bloom.
 *
 * Export:
 *   const weather = createWeather(scene, camera);
 *   weather.update(dt, state, env);
 *   weather.setPreset('clear' | 'storm' | 'night');
 *   weather.triggerLightning();
 *   weather.rainCount === 14000
 */

const RAIN_COUNT = 14000;
const RAIN_HALF_XZ = 44;
const RAIN_HALF_Y = 30;

/** Exponential time constant for preset transitions (~4s to settle). */
const STORM_TAU = 1.05;

const BOLT_POOL_SIZE = 4;
const BOLT_MAX_SEGMENTS = 220;
const BOLT_LIFE = 0.16;

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Rain shader (all motion is computed in the vertex shader: no CPU updates)
// ---------------------------------------------------------------------------

const RAIN_VERTEX = /* glsl */ `
attribute float aSpeed;
attribute float aLength;
attribute float aTip;

uniform float uTime;
uniform float uHide;
uniform vec2 uWind;
uniform vec3 uVolume;
uniform vec3 uCamPos;

varying float vFade;
varying vec3 vWorldPos;
varying float vHead;

void main() {
  // Reflection / helper passes use a different camera: skip the draw entirely.
  if (uHide > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vWorldPos = vec3(0.0);
    vFade = 0.0;
    vHead = 0.0;
    return;
  }

  // position is a per-streak seed in [0,1]^3 (identical for both vertices).
  vec3 seed = position;
  // Decrease with time -> drops fall. fract() wraps them inside the volume.
  float fall = fract(seed.y - uTime * aSpeed);

  vec3 p;
  p.x = (seed.x - 0.5) * 2.0 * uVolume.x;
  p.z = (seed.z - 0.5) * 2.0 * uVolume.z;
  p.y = mix(-uVolume.y, uVolume.y, fall);

  // Wind pushes the falling drops sideways.
  float drift = 1.0 - fall;
  p.x += uWind.x * drift * uVolume.y * 0.32;
  p.z += uWind.y * drift * uVolume.y * 0.32;

  // Streak aligned with the velocity vector.
  vec3 slide = normalize(vec3(uWind.x * 1.15, -1.0, uWind.y * 1.15));
  p += slide * (aLength * aTip);

  vec4 world = modelMatrix * vec4(p, 1.0);
  vWorldPos = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;

  float dist = length(world.xyz - uCamPos);
  float horiz = length(world.xz - uCamPos.xz);
  float nearFade = smoothstep(2.5, 12.0, dist);
  float edgeFade = 1.0 - smoothstep(uVolume.x * 0.82, uVolume.x * 1.32, horiz);
  float topFade = 1.0 - smoothstep(uVolume.y * 0.72, uVolume.y, p.y);
  vFade = nearFade * edgeFade * topFade;
  vHead = 1.0 - aTip;
}
`;

const RAIN_FRAGMENT = /* glsl */ `
uniform vec3 uColorSky;
uniform vec3 uColorSea;
uniform vec3 uCamPos;
uniform float uOpacity;

varying float vFade;
varying vec3 vWorldPos;
varying float vHead;

void main() {
  if (vFade <= 0.004) discard;

  // Two-tone rain: dark against a bright sky, pale against a dark sea.
  vec3 viewDir = normalize(vWorldPos - uCamPos);
  float skyFactor = smoothstep(-0.35, 0.25, viewDir.y);
  vec3 col = mix(uColorSea, uColorSky, skyFactor);
  // Slightly brighter heads imply motion.
  col *= 0.85 + 0.35 * vHead;

  // Linear HDR; the host composer handles ACES + sRGB once.
  gl_FragColor = vec4(col, vFade * uOpacity);
}
`;

// ---------------------------------------------------------------------------
// Rain colours (linear via THREE.Color). Kept in the same tiny luminance band
// so the streaks read against both a bright sky and a dark storm sea.
// ---------------------------------------------------------------------------

const RAIN_SEA_DAY = new THREE.Color('#dfe9f0');
const RAIN_SKY_DAY = new THREE.Color('#66788a');
const RAIN_SEA_NIGHT = new THREE.Color('#8799b8');
const RAIN_SKY_NIGHT = new THREE.Color('#2c3a52');
const RAIN_SEA_STORM = new THREE.Color('#b9c9d6');
const RAIN_SKY_STORM = new THREE.Color('#5d6b78');

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWeather(scene, camera) {
  const weatherRoot = new THREE.Group();
  weatherRoot.name = 'WeatherSystem';
  scene.add(weatherRoot);

  const rainGroup = new THREE.Group();
  rainGroup.name = 'RainVolume';
  rainGroup.renderOrder = 8;
  weatherRoot.add(rainGroup);

  const boltGroup = new THREE.Group();
  boltGroup.name = 'LightningBolts';
  weatherRoot.add(boltGroup);

  // ------------------------------------------------------------------
  // Rain geometry: one LineSegments, 2 vertices per streak, 14000 streaks.
  // ------------------------------------------------------------------
  const seeds = new Float32Array(RAIN_COUNT * 2 * 3);
  const speeds = new Float32Array(RAIN_COUNT * 2);
  const lengths = new Float32Array(RAIN_COUNT * 2);
  const tips = new Float32Array(RAIN_COUNT * 2);

  for (let i = 0; i < RAIN_COUNT; i++) {
    const sx = Math.random();
    const sy = Math.random();
    const sz = Math.random();
    // Volume-heights per second (volume is ~60 units tall -> ~18-40 u/s).
    const speed = 0.30 + Math.random() * 0.36;
    const length = 0.25 + speed * 1.5 + Math.random() * 0.3;
    for (let k = 0; k < 2; k++) {
      const v = i * 2 + k;
      const j = v * 3;
      seeds[j] = sx;
      seeds[j + 1] = sy;
      seeds[j + 2] = sz;
      speeds[v] = speed;
      lengths[v] = length;
      tips[v] = k; // 0 = leading vertex, 1 = trailing vertex
    }
  }

  const rainGeometry = new THREE.BufferGeometry();
  rainGeometry.setAttribute('position', new THREE.BufferAttribute(seeds, 3));
  rainGeometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
  rainGeometry.setAttribute('aLength', new THREE.BufferAttribute(lengths, 1));
  rainGeometry.setAttribute('aTip', new THREE.BufferAttribute(tips, 1));
  rainGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 400);

  const rainColorSky = RAIN_SKY_DAY.clone();
  const rainColorSea = RAIN_SEA_DAY.clone();

  const rainUniforms = {
    uTime: { value: 0 },
    uHide: { value: 0 },
    uWind: { value: new THREE.Vector2(0.35, 0.12) },
    uVolume: { value: new THREE.Vector3(RAIN_HALF_XZ, RAIN_HALF_Y, RAIN_HALF_XZ) },
    uCamPos: { value: new THREE.Vector3() },
    uColorSky: { value: rainColorSky },
    uColorSea: { value: rainColorSea },
    uOpacity: { value: 0 },
  };

  const rainMaterial = new THREE.ShaderMaterial({
    uniforms: rainUniforms,
    vertexShader: RAIN_VERTEX,
    fragmentShader: RAIN_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
  });
  rainMaterial.name = 'RainMaterial';

  const rainMesh = new THREE.LineSegments(rainGeometry, rainMaterial);
  rainMesh.name = 'RainMesh';
  rainMesh.frustumCulled = false;
  rainMesh.renderOrder = 8;
  rainMesh.visible = false;
  // Water renders a planar reflection with a mirrored camera. Hide the rain
  // volume there (it follows the main camera, so it would smear the mirror).
  rainMesh.onBeforeRender = (rendererRef, sceneRef, cameraRef) => {
    rainUniforms.uHide.value = cameraRef === camera ? 0 : 1;
  };
  rainGroup.add(rainMesh);

  // ------------------------------------------------------------------
  // Lightning: a small pool of prebuilt forked bolts, no per-frame allocs.
  // ------------------------------------------------------------------
  const boltMaterial = new THREE.LineBasicMaterial({
    // HDR emissive line so the bloom pass picks the bolt up.
    color: new THREE.Color().setRGB(1.6, 1.9, 2.6),
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    fog: false,
    toneMapped: false,
  });
  boltMaterial.name = 'LightningBoltMaterial';

  const bolts = [];
  for (let i = 0; i < BOLT_POOL_SIZE; i++) {
    const positions = new Float32Array(BOLT_MAX_SEGMENTS * 2 * 3);
    const attribute = new THREE.BufferAttribute(positions, 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', attribute);
    geometry.setDrawRange(0, 0);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 80, 0), 600);

    const mesh = new THREE.LineSegments(geometry, boltMaterial);
    mesh.name = `LightningBolt${i}`;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 9;
    boltGroup.add(mesh);

    bolts.push({
      geometry,
      attribute,
      positions,
      mesh,
      life: 0,
      strikeX: 0,
      strikeY: 40,
      strikeZ: 0,
    });
  }

  const flashLight = new THREE.PointLight(0xc8dcff, 0, 420, 2);
  flashLight.name = 'LightningFlashLight';
  flashLight.castShadow = false;
  weatherRoot.add(flashLight);

  // ------------------------------------------------------------------
  // Internal state
  // ------------------------------------------------------------------
  let time = 0;

  let stormTarget = 0;
  let stormMix = 0;
  let lastStateWeather = null;
  let explicitPreset = false;

  let rain = 0;

  let lightning = 0;
  let flashTimer = -1; // seconds since strike, -1 = idle
  let strikeTimer = 2.5 + Math.random() * 3.0;
  let boltCursor = 0;

  let windPhase = Math.random() * 10;

  const scratchSea = new THREE.Color();
  const scratchSky = new THREE.Color();
  const scratchVec2 = new THREE.Vector2();

  // ------------------------------------------------------------------
  // Bolt generation (only on a strike; buffers are preallocated).
  // ------------------------------------------------------------------
  function buildBolt(bolt) {
    const arr = bolt.positions;
    let w = 0;

    const push = (ax, ay, az, bx, by, bz) => {
      if (w + 6 > arr.length) return;
      arr[w++] = ax;
      arr[w++] = ay;
      arr[w++] = az;
      arr[w++] = bx;
      arr[w++] = by;
      arr[w++] = bz;
    };

    // Prefer striking land near the island.
    let sx = 0;
    let sz = 0;
    let ground = 0.4;
    for (let attempt = 0; attempt < 12; attempt++) {
      const angle = Math.random() * TAU;
      const radius = 8 + Math.random() * 58;
      const px = Math.cos(angle) * radius;
      const pz = Math.sin(angle) * radius;
      const h = heightAt(px, pz);
      if (h > 0.8) {
        sx = px;
        sz = pz;
        ground = h;
        break;
      }
    }
    ground = Math.max(ground, 0.4);

    const topY = ground + 120 + Math.random() * 80;
    const midX = sx + (Math.random() - 0.5) * 8;
    const midZ = sz + (Math.random() - 0.5) * 8;

    // Main channel: a downward random walk that ends on the ground.
    let px = midX;
    let py = topY;
    let pz = midZ;
    const steps = 26;

    for (let i = 0; i < steps; i++) {
      const t = (i + 1) / steps;
      const jitter = 5 + 10 * (1 - t);
      const nx = lerp(midX, sx, t * t) + (Math.random() - 0.5) * jitter;
      const ny = lerp(topY, ground, t);
      const nz = lerp(midZ, sz, t * t) + (Math.random() - 0.5) * jitter;
      push(px, py, pz, nx, ny, nz);

      // Occasional fork.
      if (i > 1 && i < steps - 2 && Math.random() < 0.16) {
        const dir = Math.random() * TAU;
        const len = 14 + Math.random() * 26;
        const drop = 18 + Math.random() * 22;
        const bsegs = 5 + ((Math.random() * 3) | 0);
        let bx = nx;
        let by = ny;
        let bz = nz;
        for (let k = 0; k < bsegs; k++) {
          const tt = (k + 1) / bsegs;
          const ex = nx + Math.cos(dir) * len * tt + (Math.random() - 0.5) * 6;
          const ey = ny - drop * tt * (0.5 + 0.5 * tt);
          const ez = nz + Math.sin(dir) * len * tt + (Math.random() - 0.5) * 6;
          push(bx, by, bz, ex, ey, ez);
          bx = ex;
          by = ey;
          bz = ez;
        }
      }

      px = nx;
      py = ny;
      pz = nz;
    }

    bolt.attribute.needsUpdate = true;
    bolt.geometry.setDrawRange(0, w / 3);
    bolt.geometry.boundingSphere.center.set((sx + midX) * 0.5, (topY + ground) * 0.5, (sz + midZ) * 0.5);
    bolt.geometry.boundingSphere.radius = 320;
    bolt.strikeX = sx;
    bolt.strikeY = ground + 40;
    bolt.strikeZ = sz;
    bolt.life = BOLT_LIFE;
  }

  function fireLightning() {
    const bolt = bolts[boltCursor];
    boltCursor = (boltCursor + 1) % bolts.length;

    buildBolt(bolt);
    bolt.mesh.visible = true;
    flashTimer = 0;
    flashLight.position.set(bolt.strikeX, bolt.strikeY, bolt.strikeZ);
  }

  function scheduleNextStrike() {
    strikeTimer = 4 + Math.random() * 7; // 4-11s between strikes
  }

  // ------------------------------------------------------------------
  // Preset handling
  // ------------------------------------------------------------------
  function resetRainNow() {
    rain = 0;
    rainUniforms.uOpacity.value = 0;
    rainMesh.visible = false;
  }

  function setPreset(name) {
    explicitPreset = true;
    stormTarget = name === 'storm' ? 1 : 0;
    if (name !== 'storm') {
      // Immediately hide rain for clear / night; the rest eases out.
      resetRainNow();
    } else if (strikeTimer > 6) {
      strikeTimer = 2.5 + Math.random() * 2.5;
    }
  }

  // ------------------------------------------------------------------
  // Per-frame update
  // ------------------------------------------------------------------
  function update(dt, state, env) {
    if (!env) return;

    const d = Math.min(Math.max(Number.isFinite(dt) ? dt : 0, 0), 0.1);
    time += d;

    const weatherName =
      state && typeof state.weather === 'string' ? state.weather : 'clear';

    // Main may set state.weather directly (environment.setWeatherPreset); follow
    // it, and also respect an explicit weather.setPreset() call.
    if (lastStateWeather === null) {
      lastStateWeather = weatherName;
      if (!explicitPreset) {
        stormTarget = weatherName === 'storm' ? 1 : 0;
      }
    } else if (weatherName !== lastStateWeather) {
      lastStateWeather = weatherName;
      stormTarget = weatherName === 'storm' ? 1 : 0;
      if (weatherName !== 'storm') resetRainNow();
    }

    // ---- storm envelope (eased over ~4s) ------------------------------
    stormMix += (stormTarget - stormMix) * (1 - Math.exp(-d / STORM_TAU));
    if (Math.abs(stormTarget - stormMix) < 0.0005) stormMix = stormTarget;

    // ---- rain amount: rushes in with the storm, hidden instantly on exit
    const rainTarget = stormTarget * stormMix;
    const rainRate = rainTarget > rain ? 1.8 : 3.4;
    rain += (rainTarget - rain) * (1 - Math.exp(-d * rainRate));
    if (rainTarget < 0.0005 && rain < 0.004) rain = 0;

    // ---- lightning ----------------------------------------------------
    lightning = 0;
    if (stormTarget === 1 && stormMix > 0.5 && flashTimer < 0) {
      strikeTimer -= d;
      if (strikeTimer <= 0) {
        fireLightning();
        scheduleNextStrike();
      }
    }

    if (flashTimer >= 0) {
      flashTimer += d;
      // Two quick pulses: main return stroke + a fainter after-flash.
      const p1 = Math.exp(-Math.pow((flashTimer - 0.015) / 0.055, 2));
      const p2 = Math.exp(-Math.pow((flashTimer - 0.20) / 0.10, 2)) * 0.55;
      lightning = Math.min(1, Math.max(p1, p2));
      if (flashTimer > 0.65) {
        flashTimer = -1;
        lightning = 0;
      }
    }

    for (let i = 0; i < bolts.length; i++) {
      const bolt = bolts[i];
      if (bolt.life > 0) {
        bolt.life -= d;
        if (bolt.life <= 0) {
          bolt.life = 0;
          bolt.mesh.visible = false;
        }
      }
    }
    flashLight.intensity = lightning * 4200;

    // ---- environment envelope ----------------------------------------
    const nightFactor = clamp01(env.nightFactor || 0);
    const dayFactor = clamp01(env.dayFactor || 0);

    const baseFog = 0.0018 + 0.0004 * nightFactor; // clear: 0.0018 day / 0.0022 night
    const fogDensity = lerp(baseFog, 0.0065, stormMix);

    // Clear weather should read as genuinely clear: only a few small
    // fair-weather cumulus remain, and almost no cirrus veil.
    const baseCover = lerp(0.085, 0.10, nightFactor);
    const cloudCover = lerp(baseCover, 0.95, stormMix);

    const baseCloudSpeed = lerp(1.0, 0.85, nightFactor);
    const cloudSpeed = lerp(baseCloudSpeed, 2.6, stormMix);

    const baseWind = lerp(0.35, 0.28, nightFactor);
    const windStrength = lerp(baseWind, 1.2, stormMix);

    const waveScale = 1 + 0.9 * stormMix;

    // Slowly meandering wind direction, shifted by the storm.
    windPhase += d * (0.04 + 0.03 * (0.5 + 0.5 * Math.sin(time * 0.13)));
    const windAngle = 0.4 + Math.sin(windPhase) * 0.8 + stormMix * 0.55;
    env.windDir.set(Math.cos(windAngle), Math.sin(windAngle)).normalize();

    env.stormMix = stormMix;
    env.rain = rain;
    env.rainAmount = rain;
    env.lightning = lightning;
    env.cloudCover = cloudCover;
    env.cloudSpeed = cloudSpeed;
    env.windStrength = windStrength;
    env.waveScale = waveScale;
    env.fogDensity = fogDensity;

    // ---- rain uniforms -----------------------------------------------
    const cam = camera;
    const camX = cam && cam.position ? cam.position.x : 0;
    const camY = cam && cam.position ? cam.position.y : 8;
    const camZ = cam && cam.position ? cam.position.z : 0;

    rainGroup.position.set(camX, camY, camZ);
    rainUniforms.uCamPos.value.set(camX, camY, camZ);
    rainUniforms.uTime.value = time;
    scratchVec2.copy(env.windDir).multiplyScalar(windStrength * 1.1);
    rainUniforms.uWind.value.copy(scratchVec2);

    // Rain tone follows the time of day and the storm mix.
    scratchSea
      .copy(RAIN_SEA_DAY)
      .lerp(RAIN_SEA_NIGHT, nightFactor)
      .lerp(RAIN_SEA_STORM, stormMix);
    scratchSky
      .copy(RAIN_SKY_DAY)
      .lerp(RAIN_SKY_NIGHT, nightFactor)
      .lerp(RAIN_SKY_STORM, stormMix);
    const kRainColor = 1 - Math.exp(-4 * d);
    rainColorSea.lerp(scratchSea, kRainColor);
    rainColorSky.lerp(scratchSky, kRainColor);

    rainUniforms.uOpacity.value =
      rain * (0.32 + 0.16 * stormMix) * (1 + 0.25 * nightFactor) * (0.85 + 0.15 * dayFactor);
    rainMesh.visible = rain > 0.01;
  }

  function triggerLightning() {
    fireLightning();
    scheduleNextStrike();
  }

  return {
    update,
    setPreset,
    triggerLightning,
    rainCount: RAIN_COUNT,
    // Extras for the Lead / debug tooling (safe to ignore).
    rainMesh,
    rainGroup,
    boltGroup,
    weatherRoot,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}
