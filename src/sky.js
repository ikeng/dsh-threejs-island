import * as THREE from 'three';

/**
 * Cinematic, fully procedural sky for the island scene.
 *
 * Responsibility split (see environment.js):
 *  - weather.js owns stormMix / rain / lightning / cloudCover / cloudSpeed /
 *    windStrength / windDir / waveScale / fogDensity.
 *  - sky.js owns the celestial geometry + lighting + grading: sunDir, moonDir,
 *    sun/moon colours + intensities, day/night/twilight factors, skyZenith,
 *    skyHorizon, fogColor, exposure, bloomStrength, sunColorVec, skyHorizonVec.
 *
 * The dome is a large BackSide sphere that is re-centred on the camera each
 * frame. Its ShaderMaterial renders everything (gradient, twilight scattering,
 * sun disc, phased moon, stars, Milky Way, FBM cumulus + cirrus, lightning
 * flash). No textures are used.
 *
 * Export:
 *   const sky = createSky(scene);
 *   sky.update(dt, state, env, camera);
 *   sky.skyMesh, sky.sunLight, sky.moonLight
 */

const TAU = Math.PI * 2;
const SKY_RADIUS = 800;

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;

void main() {
  // The sphere is centred on the camera, so the local position is the view ray.
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAGMENT = /* glsl */ `
varying vec3 vDir;

uniform vec3  uSunDir;
uniform vec3  uMoonDir;
uniform vec3  uSunColor;
uniform vec3  uMoonColor;
uniform vec3  uZenithColor;
uniform vec3  uHorizonColor;
uniform vec3  uFogColor;
uniform vec3  uGroundColor;
uniform vec3  uMilkyNormal;
uniform vec2  uCloudOffset;
uniform float uDay;
uniform float uNight;
uniform float uTwilight;
uniform float uStorm;
uniform float uCloudCover;
uniform float uCloudSpeed;
uniform float uTime;
uniform float uLightning;
uniform float uStarAmount;
uniform float uSunDisc;
uniform float uMoonDisc;
uniform float uMoonPhase;

// ---------------------------------------------------------------------------
// Hash / noise / FBM
// ---------------------------------------------------------------------------

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

vec2 hash22(vec2 p) {
  return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453123);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm4(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    v += amp * valueNoise(p);
    p = vec2(p.x * 1.6 - p.y * 1.2, p.x * 1.2 + p.y * 1.6) + vec2(17.1, -9.7);
    amp *= 0.5;
  }
  return v / 0.9375;
}

float fbm5(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    v += amp * valueNoise(p);
    p = vec2(p.x * 1.6 - p.y * 1.2, p.x * 1.2 + p.y * 1.6) + vec2(17.1, -9.7);
    amp *= 0.5;
  }
  return v / 0.96875;
}

// ---------------------------------------------------------------------------
// Night sky
// ---------------------------------------------------------------------------

/** Sparse hash-grid stars, twinkling, one layer (varied size/brightness). */
float starLayer(vec3 dir, float scale, float coverage, float seed) {
  vec2 sph = vec2(atan(dir.z, dir.x), asin(clamp(dir.y, -1.0, 1.0)));
  vec2 sp = sph * scale + seed;
  vec2 id = floor(sp);
  vec2 f = fract(sp) - 0.5;
  float rnd = hash21(id);
  vec2 jitter = (hash22(id + 7.31) - 0.5) * 0.62;
  float d = length(f - jitter);
  float present = step(1.0 - coverage, rnd);
  float bright = pow(hash21(id + 11.37), 2.0);
  float twinkle = 0.72 + 0.28 * sin(uTime * (1.1 + rnd * 2.3) + rnd * 47.0);
  return present * (1.0 - smoothstep(0.0, 0.17, d)) * (0.22 + bright * 2.4) * twinkle;
}

/** Soft Milky Way band with FBM dust lanes. */
vec3 milkyWay(vec3 dir) {
  float band = exp(-pow(dot(dir, uMilkyNormal) / 0.20, 2.0));
  if (band < 0.002) return vec3(0.0);
  vec2 sph = vec2(atan(dir.z, dir.x), asin(clamp(dir.y, -1.0, 1.0)));
  float dust = fbm4(sph * 2.7 + vec2(11.3, -4.7));
  float fine = fbm4(sph * 8.0 + vec2(-3.1, 7.9));
  float lane = smoothstep(0.38, 0.72, dust) * (0.6 + 0.4 * smoothstep(0.30, 0.70, fine));
  vec3 col = mix(vec3(0.030, 0.036, 0.060), vec3(0.135, 0.150, 0.220), lane);
  float core = smoothstep(0.25, 0.95, 1.0 - abs(dot(dir, uMilkyNormal)));
  return col * band * (0.35 + 0.65 * lane) * (0.5 + 0.8 * core);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

void main() {
  vec3 dir = normalize(vDir);
  float up = dir.y;
  float sunAmount = max(dot(dir, uSunDir), 0.0);

  // ---- atmosphere gradient -------------------------------------------------
  float horizonT = pow(clamp(1.0 - max(up, 0.0), 0.0, 1.0), 3.5);
  vec3 col = mix(uZenithColor, uHorizonColor, horizonT);

  // Warm forward-scattering lobes that hug the sun near sunrise / sunset.
  float lobe = pow(sunAmount, 3.5) * 0.55
             + pow(sunAmount, 14.0) * 0.40
             + pow(sunAmount, 70.0) * 0.55;
  col += uSunColor * lobe * uTwilight * (0.35 + 0.9 * horizonT);

  // Daytime Mie haze around the sun.
  col += uSunColor * pow(sunAmount, 8.0) * 0.06 * uDay;

  // ---- sun disc + halo -----------------------------------------------------
  float sunAng = acos(clamp(dot(dir, uSunDir), -1.0, 1.0));
  float sunCore = 1.0 - smoothstep(0.0060, 0.0110, sunAng);
  float sunHalo = exp(-sunAng * 48.0) * 0.50 + exp(-sunAng * 420.0) * 1.4;
  col += uSunColor * (sunCore * 16.0 + sunHalo) * uSunDisc;

  // ---- moon disc (simple phase terminator) + glow --------------------------
  float moonAng = acos(clamp(dot(dir, uMoonDir), -1.0, 1.0));
  float moonCore = 1.0 - smoothstep(0.0140, 0.0200, moonAng);
  vec3 moonA = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)) + vec3(0.0001, 0.0, 0.0));
  vec3 moonB = cross(uMoonDir, moonA);
  vec2 moff = vec2(dot(dir, moonA), dot(dir, moonB)) / 0.0200;
  float mdist = max(length(moff), 0.0001);
  float terminator = dot(moff / mdist, vec2(cos(uMoonPhase), sin(uMoonPhase)));
  float moonLit = smoothstep(-0.55, 0.45, terminator) * 0.85 + 0.15;
  float limb = 1.0 - 0.35 * clamp(mdist, 0.0, 1.0);
  float moonGlow = exp(-moonAng * 16.0) * 0.20 + exp(-moonAng * 120.0) * 0.75;
  col += uMoonColor * (moonCore * moonLit * limb * 3.4 + moonGlow) * uMoonDisc;

  // ---- stars + Milky Way ---------------------------------------------------
  float starFade = smoothstep(-0.05, 0.16, up);
  float stars = starLayer(dir, 105.0, 0.020, 0.0)
              + starLayer(dir, 52.0, 0.060, 37.0) * 1.7;
  col += vec3(0.80, 0.87, 1.0) * stars * uStarAmount * starFade;
  col += milkyWay(dir) * uStarAmount * starFade;

  // ---- FBM cloud deck ------------------------------------------------------
  // Perspective projection onto a virtual cloud plane: features converge
  // towards the horizon. Wind advects the domain, uTime slowly morphs it.
  vec2 domeUv = dir.xz / max(up, 0.045);
  vec2 drift = uCloudOffset + vec2(uTime * 0.0045, uTime * 0.0016) * uCloudSpeed;
  vec2 cuv = domeUv * 0.78 + drift;

  float base = fbm5(cuv * 0.82);
  float detail = fbm4(cuv * 2.6 + vec2(13.7, -8.1));
  float cl = base * 0.80 + detail * 0.20;

  float th = mix(0.62, 0.08, uCloudCover);
  float softness = mix(0.22, 0.46, uStorm);
  float cloud = smoothstep(th, th + softness, cl);

  // Thin high cirrus wisps, mostly a fair-weather feature.
  float cirrus = fbm4(cuv * 0.33 + vec2(4.2, 9.3) + drift * 0.35);
  float wisp = smoothstep(0.52, 0.80, cirrus) * (0.26 - 0.16 * uStorm);

  float cloudA = clamp(cloud * 1.1 + wisp * (1.0 - cloud), 0.0, 1.0);
  cloudA *= smoothstep(-0.01, 0.10, up);
  cloudA *= mix(0.25, 1.0, smoothstep(0.02, 0.22, up));

  // Sun-lit cumulus. In a storm the deck is dense and dark grey.
  float lit = clamp(0.32 + 0.95 * cl + 0.45 * pow(sunAmount, 4.0), 0.0, 1.5);
  vec3 dayShadow = mix(vec3(0.36, 0.40, 0.48), vec3(0.045, 0.052, 0.062), uStorm);
  vec3 dayLit = mix(vec3(1.05, 1.03, 0.97), vec3(0.26, 0.28, 0.31), uStorm);
  vec3 dayCol = mix(dayShadow, dayLit, clamp(lit, 0.0, 1.0));
  dayCol += uSunColor * pow(sunAmount, 18.0) * 0.85 * (1.0 - 0.75 * uStorm);
  dayCol += uSunColor * uTwilight * pow(sunAmount * 0.5 + 0.5, 5.0) * 0.18;

  // Moonlit cloud at night.
  float moonAmount = max(dot(dir, uMoonDir), 0.0);
  vec3 nightShadow = vec3(0.008, 0.011, 0.020);
  vec3 nightLit = vec3(0.045, 0.055, 0.090) + uMoonColor * pow(moonAmount, 3.0) * 0.09;
  vec3 nightCol = mix(nightShadow, nightLit, clamp(lit, 0.0, 1.0));
  nightCol += uMoonColor * pow(moonAmount, 10.0) * 0.12;

  vec3 cloudCol = mix(nightCol, dayCol, uDay);
  cloudCol += uSunColor * uTwilight * cloud * 0.10;
  // Lightning lights the cloud deck from inside.
  cloudCol += uLightning * (0.55 + cloudA) * vec3(0.45, 0.55, 0.90) * 0.9;

  col = mix(col, cloudCol, cloudA);

  // Full-sky lightning flash.
  col += uLightning * vec3(0.05, 0.065, 0.11) * (0.5 + 0.9 * uStorm);

  // ---- horizon haze (must match scene.fog) ---------------------------------
  float hazeBand = 1.0 - smoothstep(-0.02, 0.12, up);
  col = mix(col, uFogColor, hazeBand * 0.68);

  float below = 1.0 - smoothstep(-0.10, 0.0, up);
  vec3 belowCol = mix(uFogColor, uGroundColor, 1.0 - smoothstep(-0.35, -0.02, up));
  col = mix(col, belowCol, below);

  // Fine dither to break gradient banding on subtle night gradients.
  col += (hash21(gl_FragCoord.xy) - 0.5) * (1.0 / 255.0);

  // Linear HDR out: the host's post chain owns tone mapping + sRGB conversion.
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

// ---------------------------------------------------------------------------
// Palette (THREE.Color stores linear-sRGB when constructed from CSS strings)
// ---------------------------------------------------------------------------

const PALETTE = {
  zenithDay: new THREE.Color('#15488c'),
  zenithDusk: new THREE.Color('#2a3358'),
  zenithNight: new THREE.Color('#070d1a'),
  zenithStorm: new THREE.Color('#3a454d'),

  horizonDay: new THREE.Color('#b7d4df'),
  horizonDusk: new THREE.Color('#ff9a5e'),
  horizonNight: new THREE.Color('#101c30'),
  horizonStorm: new THREE.Color('#8a969d'),

  fogNight: new THREE.Color('#08101b'),
  fogStorm: new THREE.Color('#79848b'),

  sunLow: new THREE.Color('#ff8a3d'),
  sunHigh: new THREE.Color('#fff4dd'),
  sunStorm: new THREE.Color('#aeb9c4'),
  moon: new THREE.Color('#9fb7ff'),

  hemiSkyDay: new THREE.Color('#b9d7ff'),
  hemiSkyDusk: new THREE.Color('#ffb98a'),
  hemiSkyNight: new THREE.Color('#233658'),
  hemiSkyStorm: new THREE.Color('#5c6a74'),
  hemiGroundDay: new THREE.Color('#3c4a35'),
  hemiGroundNight: new THREE.Color('#05070b'),
  hemiGroundStorm: new THREE.Color('#202830'),
};

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function smoothstep01(x, edge0, edge1) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** out = day * wDay + dusk * wTw + night * wNight (weights must sum to 1). */
function mixPalette(out, cDay, cDusk, cNight, wDay, wTw, wNight) {
  out.r = cDay.r * wDay + cDusk.r * wTw + cNight.r * wNight;
  out.g = cDay.g * wDay + cDusk.g * wTw + cNight.g * wNight;
  out.b = cDay.b * wDay + cDusk.b * wTw + cNight.b * wNight;
  return out;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSky(scene) {
  // Smoothed published colours (also bound straight into the dome uniforms).
  const zenithColor = PALETTE.zenithDay.clone();
  const horizonColor = PALETTE.horizonDay.clone();
  const fogColor = new THREE.Color('#bfd9e2');
  const sunColor = PALETTE.sunHigh.clone();
  const moonColor = PALETTE.moon.clone();
  const hemiSkyColor = PALETTE.hemiSkyDay.clone();
  const hemiGroundColor = PALETTE.hemiGroundDay.clone();

  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0.35, 0.82, 0.45).normalize() },
    uMoonDir: { value: new THREE.Vector3(-0.35, -0.82, -0.45).normalize() },
    uSunColor: { value: sunColor },
    uMoonColor: { value: moonColor },
    uZenithColor: { value: zenithColor },
    uHorizonColor: { value: horizonColor },
    uFogColor: { value: fogColor },
    uGroundColor: { value: new THREE.Color(0.1, 0.12, 0.14) },
    uMilkyNormal: { value: new THREE.Vector3(0.35, 0.55, 0.75).normalize() },
    uCloudOffset: { value: new THREE.Vector2() },
    uDay: { value: 1 },
    uNight: { value: 0 },
    uTwilight: { value: 0 },
    uStorm: { value: 0 },
    uCloudCover: { value: 0.38 },
    uCloudSpeed: { value: 1 },
    uTime: { value: 0 },
    uLightning: { value: 0 },
    uStarAmount: { value: 0 },
    uSunDisc: { value: 1 },
    uMoonDisc: { value: 0 },
    uMoonPhase: { value: 0.75 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    toneMapped: true,
  });
  material.name = 'SkyDomeMaterial';

  const geometry = new THREE.SphereGeometry(SKY_RADIUS, 48, 32);
  const skyMesh = new THREE.Mesh(geometry, material);
  skyMesh.name = 'SkyDome';
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = -10;
  scene.add(skyMesh);

  // --- sun ---------------------------------------------------------------
  const sunLight = new THREE.DirectionalLight(0xfff1d0, 2.7);
  sunLight.name = 'SunLight';
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  const sunShadowCam = sunLight.shadow.camera;
  sunShadowCam.left = -70;
  sunShadowCam.right = 70;
  sunShadowCam.top = 70;
  sunShadowCam.bottom = -70;
  sunShadowCam.near = 1;
  sunShadowCam.far = 400;
  sunShadowCam.updateProjectionMatrix();
  sunLight.shadow.bias = -0.0005;
  sunLight.shadow.normalBias = 0.035;
  scene.add(sunLight);
  scene.add(sunLight.target);
  sunLight.target.position.set(0, 0, 0);

  // --- moon --------------------------------------------------------------
  const moonLight = new THREE.DirectionalLight(0x9fb7ff, 0.0);
  moonLight.name = 'MoonLight';
  moonLight.castShadow = false;
  scene.add(moonLight);
  scene.add(moonLight.target);
  moonLight.target.position.set(0, 0, 0);

  // --- bounce light ------------------------------------------------------
  const hemiLight = new THREE.HemisphereLight(0xbfd7ff, 0x3c4a35, 0.6);
  hemiLight.name = 'SkyHemisphere';
  scene.add(hemiLight);

  const ambientLight = new THREE.AmbientLight(0x8fa3bd, 0.05);
  ambientLight.name = 'SkyAmbient';
  scene.add(ambientLight);

  // --- scratch state -----------------------------------------------------
  const sunDir = new THREE.Vector3();
  const moonDir = new THREE.Vector3();
  const cloudOffset = new THREE.Vector2();

  const tmpZenith = new THREE.Color();
  const tmpHorizon = new THREE.Color();
  const tmpFog = new THREE.Color();
  const tmpSun = new THREE.Color();
  const tmpStormZenith = new THREE.Color();
  const tmpStormHorizon = new THREE.Color();
  const tmpStormFog = new THREE.Color();
  const tmpHemiSky = new THREE.Color();
  const tmpHemiGround = new THREE.Color();
  const tmpStormHemiSky = new THREE.Color();
  const tmpStormHemiGround = new THREE.Color();

  let elapsed = 0;

  function update(dt, state, env, camera) {
    // Sky must be robust to a missing env on the very first frame.
    if (!env) return;

    const d = Math.min(Math.max(Number.isFinite(dt) ? dt : 0, 0), 0.1);
    elapsed += d;

    const time = state && Number.isFinite(state.timeOfDay) ? state.timeOfDay : 12;

    // ------------------------------------------------------------------
    // Celestial geometry from the 24h clock.
    // theta = (time - 6) / 24 * TAU  ->  sun rises in the east at 06:00,
    // is overhead at 12:00, sets west at 18:00 and is below at night.
    // ------------------------------------------------------------------
    const theta = ((time - 6) / 24) * TAU;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    sunDir.set(cosT, sinT, 0.35).normalize();
    // Moon roughly opposite the sun with a tilt so it is not a perfect antipode.
    moonDir
      .set(-cosT * 0.92 + 0.16, -sinT * 0.92 + 0.20, 0.62)
      .normalize();

    const sunElev = sunDir.y;
    const moonElev = moonDir.y;

    // Continuous time-of-day factors (no popping at sunrise/sunset).
    const dayFactor = smoothstep01(sunElev, 0.02, 0.30);
    const nightFactor = 1 - smoothstep01(sunElev, -0.16, 0.06);
    const twilightFactor = Math.exp(-(sunElev * sunElev) / 0.018);

    // ------------------------------------------------------------------
    // Read the weather-owned values (weather.update runs before sky.update).
    // ------------------------------------------------------------------
    const storm = clamp01(env.stormMix || 0);
    const lightning = clamp01(env.lightning || 0);
    const cloudCover = clamp01(Number.isFinite(env.cloudCover) ? env.cloudCover : 0.38);
    const cloudSpeed = Math.max(Number.isFinite(env.cloudSpeed) ? env.cloudSpeed : 1, 0.15);
    const windDir = env.windDir && env.windDir.isVector2 ? env.windDir : FALLBACK_WIND;
    const windStrength = Math.max(Number.isFinite(env.windStrength) ? env.windStrength : 0.35, 0);

    // ------------------------------------------------------------------
    // Palette weights: day / dusk / night, normalised.
    // ------------------------------------------------------------------
    const wDay = dayFactor;
    const wNight = nightFactor;
    const wTw = twilightFactor * (1 - dayFactor * 0.65);
    const wInv = 1 / Math.max(wDay + wNight + wTw, 1e-4);
    const nDay = wDay * wInv;
    const nNight = wNight * wInv;
    const nTw = wTw * wInv;

    const daylight = clamp01(dayFactor + twilightFactor * 0.55);

    mixPalette(
      tmpZenith,
      PALETTE.zenithDay,
      PALETTE.zenithDusk,
      PALETTE.zenithNight,
      nDay,
      nTw,
      nNight,
    );
    mixPalette(
      tmpHorizon,
      PALETTE.horizonDay,
      PALETTE.horizonDusk,
      PALETTE.horizonNight,
      nDay,
      nTw,
      nNight,
    );

    // Storm overrides: grey by day, near-black by night.
    tmpStormZenith.copy(PALETTE.zenithNight).lerp(PALETTE.zenithStorm, daylight);
    tmpStormHorizon.copy(PALETTE.horizonNight).lerp(PALETTE.horizonStorm, daylight);
    tmpStormFog.copy(PALETTE.fogNight).lerp(PALETTE.fogStorm, daylight);

    tmpZenith.lerp(tmpStormZenith, storm * 0.92);
    tmpHorizon.lerp(tmpStormHorizon, storm * 0.90);

    // Fog colour = horizon colour, desaturated with grey during a storm.
    tmpFog.copy(tmpHorizon).lerp(tmpStormFog, storm * 0.55);

    // Warm low sun -> white high sun; storms desaturate the direct light.
    const warm = smoothstep01(sunElev, 0.02, 0.55);
    tmpSun.copy(PALETTE.sunLow).lerp(PALETTE.sunHigh, warm);
    tmpSun.lerp(PALETTE.sunStorm, storm * 0.55);

    // Smooth the published colours so fast clock jumps never pop.
    const kColor = 1 - Math.exp(-3.2 * d);
    zenithColor.lerp(tmpZenith, kColor);
    horizonColor.lerp(tmpHorizon, kColor);
    fogColor.lerp(tmpFog, kColor);
    sunColor.lerp(tmpSun, 1 - Math.exp(-6.0 * d));

    // ------------------------------------------------------------------
    // Intensities / grading.
    // ------------------------------------------------------------------
    const sunVisible = smoothstep01(sunElev, -0.035, 0.02);
    const sunHeight = smoothstep01(sunElev, 0.0, 0.40);
    const baseSun = sunVisible * (0.45 + 0.55 * sunHeight) * 2.9 * (1 - 0.82 * storm);
    const flash = lightning;

    const sunIntensity = baseSun + flash * 1.35 * (1 - nightFactor * 0.6);

    const moonVisible = smoothstep01(moonElev, -0.02, 0.08);
    const moonIntensity =
      nightFactor * moonVisible * 0.82 * (1 - 0.72 * storm) + flash * 0.35;

    const hemiIntensity =
      (0.10 + 0.50 * dayFactor + 0.22 * twilightFactor + 0.09 * nightFactor) *
        (1 - 0.45 * storm) +
      flash * 1.6;
    const ambientIntensity = 0.03 + 0.04 * dayFactor + 0.025 * nightFactor + flash * 0.40;

    const baseExposure = lerp(lerp(0.88, 1.22, nightFactor), 0.96, storm);
    const exposure = baseExposure + twilightFactor * 0.015;
    const bloomStrength =
      lerp(lerp(0.34, 0.78, nightFactor), 0.40, storm) + flash * 1.0;
    const bloomThreshold = lerp(lerp(1.12, 0.72, nightFactor), 0.92, storm);

    // ------------------------------------------------------------------
    // Publish to env (single source of truth for every other module).
    // ------------------------------------------------------------------
    env.timeOfDay = time;
    env.sunDir.copy(sunDir);
    env.moonDir.copy(moonDir);
    env.sunColor.copy(sunColor);
    env.moonColor.copy(moonColor);
    env.sunIntensity = sunIntensity;
    env.moonIntensity = moonIntensity;
    env.dayFactor = dayFactor;
    env.nightFactor = nightFactor;
    env.twilightFactor = twilightFactor;
    env.skyZenith.copy(zenithColor);
    env.skyHorizon.copy(horizonColor);
    env.fogColor.copy(fogColor);
    env.exposure = exposure;
    env.bloomStrength = bloomStrength;
    env.bloomThreshold = bloomThreshold;
    env.sunColorVec.set(sunColor.r, sunColor.g, sunColor.b);
    env.skyHorizonVec.set(horizonColor.r, horizonColor.g, horizonColor.b);

    // ------------------------------------------------------------------
    // Lights.
    // ------------------------------------------------------------------
    sunLight.position.copy(sunDir).multiplyScalar(160);
    sunLight.color.copy(sunColor);
    sunLight.intensity = sunIntensity;
    sunLight.castShadow = sunElev > 0.0 && sunIntensity > 0.25;

    moonLight.position.copy(moonDir).multiplyScalar(160);
    moonLight.color.copy(moonColor);
    moonLight.intensity = moonIntensity;

    // Hemisphere + ambient bounce: warm day, cool night, dim under storms.
    mixPalette(
      tmpHemiSky,
      PALETTE.hemiSkyDay,
      PALETTE.hemiSkyDusk,
      PALETTE.hemiSkyNight,
      nDay,
      nTw,
      nNight,
    );
    tmpHemiGround.copy(PALETTE.hemiGroundDay).lerp(PALETTE.hemiGroundNight, nightFactor);
    tmpStormHemiSky.copy(PALETTE.hemiSkyNight).lerp(PALETTE.hemiSkyStorm, daylight);
    tmpStormHemiGround.copy(PALETTE.hemiGroundNight).lerp(PALETTE.hemiGroundStorm, daylight);
    tmpHemiSky.lerp(tmpStormHemiSky, storm * 0.70);
    tmpHemiGround.lerp(tmpStormHemiGround, storm * 0.60);

    hemiSkyColor.lerp(tmpHemiSky, kColor);
    hemiGroundColor.lerp(tmpHemiGround, kColor);
    hemiLight.color.copy(hemiSkyColor);
    hemiLight.groundColor.copy(hemiGroundColor);
    hemiLight.intensity = hemiIntensity;

    ambientLight.intensity = ambientIntensity;

    // ------------------------------------------------------------------
    // Dome uniforms.
    // ------------------------------------------------------------------
    uniforms.uSunDir.value.copy(sunDir);
    uniforms.uMoonDir.value.copy(moonDir);
    uniforms.uSunColor.value.copy(sunColor);
    uniforms.uMoonColor.value.copy(moonColor);
    uniforms.uDay.value = dayFactor;
    uniforms.uNight.value = nightFactor;
    uniforms.uTwilight.value = twilightFactor;
    uniforms.uStorm.value = storm;
    uniforms.uCloudCover.value = cloudCover;
    uniforms.uCloudSpeed.value = cloudSpeed;
    uniforms.uTime.value = elapsed;
    uniforms.uLightning.value = lightning;
    // Stars only appear once the sun is well below the horizon.
    uniforms.uStarAmount.value =
      smoothstep01(nightFactor, 0.55, 0.96) * (1 - storm * 0.9);
    uniforms.uSunDisc.value =
      smoothstep01(sunElev, -0.035, 0.02) * (1 - storm * 0.88);
    uniforms.uMoonDisc.value =
      nightFactor * smoothstep01(moonElev, -0.02, 0.08) * (1 - storm * 0.85);

    // Below-horizon dome colour: dark haze that matches the scene fog.
    uniforms.uGroundColor.value
      .copy(fogColor)
      .multiplyScalar(0.45);
    uniforms.uGroundColor.value.b += 0.006;

    // Wind-driven cloud march (the shader adds its own slow morph via uTime).
    const drift = 0.02 * windStrength * cloudSpeed * d;
    cloudOffset.x += windDir.x * drift + 0.0004 * d;
    cloudOffset.y += windDir.y * drift;
    uniforms.uCloudOffset.value.copy(cloudOffset);

    // Keep the dome centred on the camera so the horizon never parallaxes away.
    if (camera && camera.position) {
      skyMesh.position.copy(camera.position);
    }
  }

  return { update, skyMesh, sunLight, moonLight, hemiLight, ambientLight };
}

const FALLBACK_WIND = new THREE.Vector2(1, 0.35).normalize();
