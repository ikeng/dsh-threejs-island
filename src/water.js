import * as THREE from 'three';
import { createSeabedTexture, SEABED_COVERAGE } from './heightfield.js';

/**
 * Ocean — stylised-realistic tropical coast.
 *
 * One draw call: a large, radially-warped Gerstner height field plus a custom
 * shader. The same mesh renders:
 *
 *   - six-layer Gerstner displacement with analytic (tangent / binormal) normals
 *   - shoaling: wave amplitude is capped against the baked seabed depth, so the
 *     swell dies out cleanly at the beach and never pokes through the sand
 *   - a half-resolution planar reflection (mirror camera + oblique near plane,
 *     Reflector technique) rendered into an HDR render target every frame
 *   - Fresnel reflection with normal distortion, GGX sun glitter, moon glitter,
 *     depth-graded turquoise / deep teal water, backlit crest translucency,
 *     shore foam lace, offshore whitecaps and three.js-compatible exp2 fog.
 *
 * Integration contract (owned by main.js):
 *
 *   const water = createWater(scene, renderer);
 *   // each frame, BEFORE the renderer draws the main view:
 *   water.update(dt, camera, env);
 *   // on resize / pixel-ratio change:
 *   water.resize();
 *   // optional quality control:
 *   water.setReflectionScale(0.5);
 *
 * All lighting state comes from the shared `env` object published by
 * environment.js (sun/moon directions, intensities, weather mixes, fog). This
 * module never creates its own sun or time-of-day system; the only clock it
 * owns is a monotonic wave-animation time accumulated from `dt`.
 *
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 * @returns {{
 *   mesh: THREE.Mesh,
 *   reflectionTarget: THREE.WebGLRenderTarget,
 *   update: (dt: number, camera: THREE.Camera, env: object) => void,
 *   setReflectionScale: (scale: number) => void,
 *   resize: () => void,
 * }}
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Full extent of the water plane. Fog hides the far edge from the island. */
const WATER_SIZE = 1600;
/** Grid resolution. Vertices are warped towards the island (see warpAxis). */
const WATER_SEGMENTS = 360;
/** Water surface sits at y = 0; the terrain waterline is defined the same way. */
const SEA_LEVEL_Y = 0;
/** Fraction of the seabed map R channel: 0..1 maps to 0..30 m of water. */
const SEA_DEPTH_METRES = 30;
/** Default reflection resolution relative to the drawing buffer. */
const REFLECTION_SCALE_DEFAULT = 0.5;
const REFLECTION_SCALE_MIN = 0.25;
const REFLECTION_SCALE_MAX = 0.75;
/** Tiny nudge of the oblique near plane to avoid z-fighting at the waterline. */
const CLIP_BIAS = 0.002;
/** Below this camera height the planar reflection is skipped / clamped. */
const MIN_REFLECTION_EYE_HEIGHT = 0.25;
/** Vertical warp: concentrate triangles where the shoreline detail lives. */
const WARP_LINEAR = 0.42;
const WARP_POWER = 2.5;

/**
 * Six-layer Gerstner spectrum.
 *
 * Directions are spread around the compass so the surface never looks like a
 * striped sine field. Wavelengths run from long ocean swell down to short chop;
 * amplitudes fall off with wavelength and the chop factor is kept low enough
 * that the surface never loops (sum(k * amp * chop) ~= 0.18 << 1).
 */
const WAVES = [
  // direction (degrees around +X/+Z), wavelength (m), amplitude (m), chop, speed, phase
  { dir: 12, length: 96, amp: 0.74, chop: 1.0, speed: 0.62, phase: 0.0 },
  { dir: 66, length: 63, amp: 0.48, chop: 0.96, speed: 0.66, phase: 1.7 },
  { dir: 131, length: 41, amp: 0.32, chop: 0.9, speed: 0.72, phase: 3.1 },
  { dir: 188, length: 29, amp: 0.2, chop: 0.84, speed: 0.78, phase: 4.4 },
  { dir: 247, length: 21, amp: 0.118, chop: 0.74, speed: 0.84, phase: 2.3 },
  { dir: 309, length: 17, amp: 0.08, chop: 0.62, speed: 0.9, phase: 5.7 },
];

const GRAVITY = 9.81;

const WAVE_UNIFORM_A = [];
const WAVE_UNIFORM_B = [];
let WAVE_SUM_AMPLITUDE = 0;

for (const wave of WAVES) {
  const k = (Math.PI * 2) / wave.length;
  // Deep-water dispersion, slightly slowed down for a cinematic, glassy swell.
  const omega = Math.sqrt(GRAVITY * k) * wave.speed;
  const angle = THREE.MathUtils.degToRad(wave.dir);
  WAVE_UNIFORM_A.push(new THREE.Vector4(wave.amp, k, omega, wave.phase));
  WAVE_UNIFORM_B.push(new THREE.Vector4(Math.cos(angle), Math.sin(angle), wave.chop, 0));
  WAVE_SUM_AMPLITUDE += wave.amp;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const OCEAN_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uWaveAmp;      // global amplitude multiplier (weather/waveScale)
  uniform float uWaveChop;     // global horizontal chop multiplier
  uniform float uWaveSumAmp;   // sum of the base amplitudes (shoaling reference)
  uniform vec4 uWaveA[ 6 ];    // x=amplitude, y=wavenumber, z=angular speed, w=phase
  uniform vec4 uWaveB[ 6 ];    // x=dirX, y=dirZ, z=chop
  uniform sampler2D uSeabed;   // R = water depth, 0..1 => 0..30 m
  uniform vec2 uSeabedXform;   // 1 / SEABED_COVERAGE
  uniform mat4 uTextureMatrix;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec4 vReflectCoord;
  varying float vFogDepth;
  varying float vCrest;
  varying float vSteepness;
  varying float vAmpDamp;

  struct WaveFrame {
    vec3 tangent;   // dP/dx (analytic)
    vec3 binormal;  // dP/dz (analytic)
    float height;   // accumulated vertical displacement
    float jxx;      // d(displaced x)/dx
    float jzz;      // d(displaced z)/dz
    float jxz;      // d(displaced x)/dz == d(displaced z)/dx
  };

  // One Gerstner layer. Everything is analytic: no finite differences anywhere.
  void applyGerstner(
    vec4 wave,
    vec4 params,
    vec2 planeXZ,
    float ampDamp,
    inout vec3 worldPos,
    inout WaveFrame f
  ) {
    vec2 dir = params.xy;
    float amp = wave.x * uWaveAmp * ampDamp;
    float chop = params.z * uWaveChop;
    float phase = dot( dir, planeXZ ) * wave.y - wave.z * uTime + wave.w;
    float s = sin( phase );
    float c = cos( phase );
    float ka = wave.y * amp;

    // Vertical swell plus horizontal choppiness (circular orbit motion).
    worldPos.xz += dir * ( chop * amp * c );
    worldPos.y += amp * s;
    f.height += amp * s;

    // Analytic tangent frame of the displaced surface.
    f.tangent.x += -ka * chop * dir.x * dir.x * s;
    f.tangent.y += ka * dir.x * c;
    f.tangent.z += -ka * chop * dir.x * dir.y * s;

    f.binormal.x += -ka * chop * dir.x * dir.y * s;
    f.binormal.y += ka * dir.y * c;
    f.binormal.z += -ka * chop * dir.y * dir.y * s;

    // Horizontal Jacobian terms (crest compression -> whitecaps).
    f.jxx += -ka * chop * dir.x * dir.x * s;
    f.jzz += -ka * chop * dir.y * dir.y * s;
    f.jxz += -ka * chop * dir.x * dir.y * s;
  }

  void main() {
    vec3 worldPos = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
    vec2 planeXZ = worldPos.xz;

    // ------------------------------------------------------------------
    // Shoaling: sample the baked seabed depth (LinearFilter) at the world
    // position and cap the total crest height to a fraction of the local
    // depth. Because the cap uses the *actual* wave energy it adapts to
    // storms automatically, and it fades to exactly zero at the waterline,
    // so no wave can ever poke through the beach.
    // ------------------------------------------------------------------
    vec2 depthUv = planeXZ * uSeabedXform + 0.5;
    float depth01 = texture2D( uSeabed, clamp( depthUv, 0.0, 1.0 ) ).r;
    float depthM = depth01 * ${SEA_DEPTH_METRES.toFixed(1)};
    float dampRaw = clamp( ( depthM * 0.62 ) / max( uWaveSumAmp * uWaveAmp, 1e-4 ), 0.0, 1.0 );
    float ampDamp = dampRaw * dampRaw * ( 3.0 - 2.0 * dampRaw );

    WaveFrame f;
    f.tangent = vec3( 1.0, 0.0, 0.0 );
    f.binormal = vec3( 0.0, 0.0, 1.0 );
    f.height = 0.0;
    f.jxx = 1.0;
    f.jzz = 1.0;
    f.jxz = 0.0;

    applyGerstner( uWaveA[ 0 ], uWaveB[ 0 ], planeXZ, ampDamp, worldPos, f );
    applyGerstner( uWaveA[ 1 ], uWaveB[ 1 ], planeXZ, ampDamp, worldPos, f );
    applyGerstner( uWaveA[ 2 ], uWaveB[ 2 ], planeXZ, ampDamp, worldPos, f );
    applyGerstner( uWaveA[ 3 ], uWaveB[ 3 ], planeXZ, ampDamp, worldPos, f );
    applyGerstner( uWaveA[ 4 ], uWaveB[ 4 ], planeXZ, ampDamp, worldPos, f );
    applyGerstner( uWaveA[ 5 ], uWaveB[ 5 ], planeXZ, ampDamp, worldPos, f );

    // Normal from the analytic tangent / binormal cross product.
    vNormal = normalize( cross( f.binormal, f.tangent ) );

    vWorldPos = worldPos;
    vReflectCoord = uTextureMatrix * vec4( worldPos, 1.0 );
    vFogDepth = -( viewMatrix * vec4( worldPos, 1.0 ) ).z;

    vAmpDamp = ampDamp;
    float localAmp = max( uWaveSumAmp * uWaveAmp * ampDamp, 1e-3 );
    vCrest = clamp( f.height / localAmp, -1.0, 1.0 );

    // Combined crest steepness: local horizontal compression + surface tilt.
    float jacobian = f.jxx * f.jzz - f.jxz * f.jxz;
    float slope = length( vNormal.xz ) / max( vNormal.y, 1e-3 );
    vSteepness = clamp( ( 1.0 - jacobian ) * 2.5 + slope * 1.6, 0.0, 1.0 );

    gl_Position = projectionMatrix * viewMatrix * vec4( worldPos, 1.0 );
  }
`;

const OCEAN_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform float uSunIntensity;
  uniform vec3 uMoonDir;
  uniform vec3 uMoonColor;
  uniform float uMoonIntensity;
  uniform float uDayFactor;
  uniform float uNightFactor;
  uniform float uTwilight;
  uniform float uStorm;
  uniform float uCloudCover;
  uniform float uLightning;
  uniform vec2 uWindDir;
  uniform float uWindStrength;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform vec3 uSkyHorizon;
  uniform vec3 uSkyZenith;
  uniform vec3 uDeepColor;
  uniform vec3 uShallowColor;
  uniform vec3 uFoamColor;
  uniform float uReflectValid;   // 0 when there is no usable mirror pass
  uniform sampler2D tReflection; // half-res HDR planar reflection
  uniform sampler2D uSeabed;     // R = water depth
  uniform vec2 uSeabedXform;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec4 vReflectCoord;
  varying float vFogDepth;
  varying float vCrest;
  varying float vSteepness;
  varying float vAmpDamp;

  #define PI 3.14159265359

  // --- procedural noise (no textures are used anywhere in the ocean) --------

  float hash12( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }

  float valueNoise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = fract( p );
    vec2 u = f * f * ( 3.0 - 2.0 * f );
    float a = hash12( i );
    float b = hash12( i + vec2( 1.0, 0.0 ) );
    float c = hash12( i + vec2( 0.0, 1.0 ) );
    float d = hash12( i + vec2( 1.0, 1.0 ) );
    return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
  }

  float fbm3( vec2 p ) {
    float sum = 0.0;
    float amp = 0.5;
    for ( int i = 0; i < 3; i ++ ) {
      sum += amp * valueNoise( p );
      p = p * 2.03 + vec2( 17.13, 9.71 );
      amp *= 0.5;
    }
    return sum / 0.875;
  }

  // --- lighting helpers -----------------------------------------------------

  float distributionGGX( float NoH, float alpha2 ) {
    float d = NoH * NoH * ( alpha2 - 1.0 ) + 1.0;
    return alpha2 / ( PI * d * d );
  }

  // Must match THREE.FogExp2 so the ocean fades like every other material.
  float fogExp2( float depth, float density ) {
    return 1.0 - exp( - density * density * depth * depth );
  }

  void main() {
    // ------------------------------------------------------------- normals
    vec3 N = normalize( vNormal );
    // Robustness: if the camera dips under the surface, shade the back face.
    if ( ! gl_FrontFacing ) N = -N;

    vec3 toCamera = cameraPosition - vWorldPos;
    float viewDistance = length( toCamera );
    vec3 V = toCamera / max( viewDistance, 1e-4 );
    vec2 p = vWorldPos.xz;
    float t = uTime;

    // -------------------------------------------------------- water depth
    // (0 on land, 30 m in deep water; the seabed map covers the island area
    // and clamps to deep water outside it.)
    vec2 seabedUv = p * uSeabedXform + 0.5;
    float depth01 = texture2D( uSeabed, clamp( seabedUv, 0.0, 1.0 ) ).r;
    float depthM = depth01 * ${SEA_DEPTH_METRES.toFixed(1)};
    float shallowness = 1.0 - smoothstep( 1.0, 9.0, depthM );

    // ------------------------------------------------- fine detail normals
    // Three short travelling ripples plus a noise gain. Analytic derivatives
    // of small sine waves keep this cheap; the noise breaks up the regularity.
    vec2 wind = normalize( uWindDir + vec2( 1e-4, 0.0 ) );
    vec2 flow = wind * ( t * ( 0.3 + 0.9 * uWindStrength ) );

    float detailFade = 1.0 - smoothstep( 80.0, 620.0, viewDistance );
    float shallowCalm = mix( 0.45, 1.0, clamp( vAmpDamp * 1.3, 0.0, 1.0 ) );
    float detailGain = mix(
      0.55,
      1.4,
      valueNoise( p * 0.09 + flow * 0.35 )
    ) * ( 0.75 + 1.0 * uStorm ) * detailFade * shallowCalm;

    float gx = 0.0;
    float gz = 0.0;

    {
      vec2 d = normalize( vec2( 0.82, 0.57 ) );
      float k = 6.2831853 / 3.1;
      float a = 0.03;
      float ph = dot( d, p + flow * 1.3 ) * k + t * 2.15;
      float slope = a * k * cos( ph );
      gx += d.x * slope;
      gz += d.y * slope;
    }
    {
      vec2 d = normalize( vec2( -0.62, 0.78 ) );
      float k = 6.2831853 / 1.9;
      float a = 0.018;
      float ph = dot( d, p - flow * 1.7 ) * k + t * 3.05 + 1.7;
      float slope = a * k * cos( ph );
      gx += d.x * slope;
      gz += d.y * slope;
    }
    {
      vec2 d = normalize( vec2( 0.25, -0.97 ) );
      float k = 6.2831853 / 1.25;
      float a = 0.01;
      float ph = dot( d, p + flow * 2.2 ) * k + t * 4.1 + 3.9;
      float slope = a * k * cos( ph );
      gx += d.x * slope;
      gz += d.y * slope;
    }

    N = normalize( N + vec3( - gx, 0.0, - gz ) * detailGain );

    // ------------------------------------------------------ foam patterns
    vec2 foamPos = p + flow;
    float bandNoise = fbm3( foamPos * 0.11 );
    float breakNoise = fbm3( p * 0.7 + flow * 1.9 );

    // Shore foam: animated depth threshold + FBM breakup + travelling ripple
    // bands that run up the beach. The wet edge itself stays transparent (see
    // alpha) and the foam is faded out right at the waterline.
    // The shelf around the island is very gentle, so an over-generous depth
    // threshold would paint the whole lagoon white. Keep the calm-weather lace
    // within ~0.6 m of the waterline and let storms widen it.
    float shoreWidth = 0.55 + 1.35 * uStorm;
    float shoreMask = 1.0 - smoothstep( 0.02, shoreWidth, depthM );
    float rippleBands = 0.5 + 0.5 * sin(
      depthM * 12.0 - t * ( 1.5 + uStorm ) + breakNoise * 5.5 + bandNoise * 2.0
    );
    float breakMask = smoothstep( 0.42, 0.82, breakNoise * 0.8 + rippleBands * 0.35 );
    float shoreFoam = shoreMask * breakMask * ( 0.3 + 0.7 * rippleBands );

    // Bright lace right where the swash meets the sand.
    float lace = 1.0 - smoothstep( 0.0, 0.32, depthM );
    shoreFoam += lace * 0.85 * smoothstep( 0.46, 0.85, breakNoise + 0.25 * rippleBands );

    shoreFoam *= 0.52 + 0.95 * uStorm;
    shoreFoam *= smoothstep( 0.006, 0.06, depthM );

    // Offshore foam lines: crest steepness (from the vertex-stage Jacobian)
    // modulated by the large FBM bands. Fair weather only gets occasional
    // whitecaps; storms fill the sea with broken foam.
    float crestMask = smoothstep( 0.22, 0.82, vCrest );
    float steepMask = smoothstep( 0.58, 0.95, vSteepness + 0.16 * uStorm );
    float offBands = smoothstep( 0.66, 0.94, bandNoise );
    float offshoreFoam = crestMask * steepMask * offBands * smoothstep( 2.0, 6.0, depthM );
    offshoreFoam *= 0.16 + 1.05 * uStorm;

    // Storm whitecaps spread over deeper water as well.
    float whitecap = smoothstep( 0.72, 0.94, bandNoise + 0.18 * breakNoise )
      * uStorm * smoothstep( 1.5, 5.0, depthM );

    float foam = clamp( shoreFoam + offshoreFoam + whitecap * 0.55, 0.0, 1.0 );

    // --------------------------------------------------------- reflection
    float NoV = clamp( dot( N, V ), 0.0, 1.0 );
    float fresnel = 0.02 + 0.98 * pow( 1.0 - NoV, 5.0 );

    vec3 skyFallback = uSkyHorizon * 0.85 + uSkyZenith * 0.25;
    vec2 reflUv = vReflectCoord.xy / max( vReflectCoord.w, 1e-4 );
    float distortion = ( 0.055 + 0.06 * uStorm ) / ( 1.0 + viewDistance * 0.012 );
    reflUv += N.xz * distortion;

    // Fade to a sky tint if the distorted lookup leaves the reflection target.
    float edgeMask = smoothstep( 0.0, 0.02, reflUv.x )
      * ( 1.0 - smoothstep( 0.98, 1.0, reflUv.x ) )
      * smoothstep( 0.0, 0.02, reflUv.y )
      * ( 1.0 - smoothstep( 0.98, 1.0, reflUv.y ) );

    vec3 reflection = texture2D( tReflection, clamp( reflUv, vec2( 0.001 ), vec2( 0.999 ) ) ).rgb;
    reflection = mix( skyFallback, reflection, edgeMask * uReflectValid );

    // ----------------------------------------------------------- lighting
    vec3 sunLight = uSunColor * uSunIntensity;
    vec3 moonLight = uMoonColor * uMoonIntensity;
    vec3 ambientLight = mix( uSkyZenith, uSkyHorizon, 0.6 )
        * ( 0.3 + 0.45 * uDayFactor )
      + moonLight * 0.4
      + uSunColor * ( 0.1 * uTwilight );

    float sunDiffuse = clamp( dot( N, uSunDir ), 0.0, 1.0 );

    // Deep teal offshore -> luminous turquoise over the sand. The shelf is
    // lifted so the lagoon stays saturated even where alpha lets sand through.
    vec3 body = mix( uDeepColor, uShallowColor, shallowness );
    body *= 1.0 + 0.5 * shallowness;
    body *= ambientLight + sunLight * ( 0.15 + 0.22 * sunDiffuse );
    body *= 1.0 - 0.28 * uStorm;
    body *= mix( 1.0, 0.7, uNightFactor );

    // Storm desaturates the water towards a cold grey-teal.
    float bodyLuma = dot( body, vec3( 0.2126, 0.7152, 0.0722 ) );
    body = mix( body, vec3( bodyLuma ) * vec3( 0.85, 0.93, 1.0 ), uStorm * 0.55 );

    // ---------------------------------------- subsurface scattering (crests)
    // Backlit translucency: strongest when looking towards the sun through a
    // crest. Gives the classic luminous turquoise rim on the swell.
    float towardSun = clamp( dot( V, - uSunDir ), 0.0, 1.0 );
    float crestHeight = clamp( vCrest, 0.0, 1.0 );
    float backlit = pow( towardSun, 3.0 )
      * smoothstep( 0.05, 0.8, crestHeight )
      * ( 0.6 + 0.4 * vSteepness );
    vec3 sssTint = uShallowColor * 1.9 + vec3( 0.0, 0.045, 0.03 );
    vec3 sssLight = uSunColor * ( uSunIntensity * 0.17 ) * sssTint * backlit;

    // --------------------------------------------- sun / moon specular
    // GGX with a very tight lobe for the glitter path; the detail normal and a
    // noise gain break the highlight into sparkles instead of a plastic blob.
    float roughness = mix( 0.058, 0.14, uStorm )
      + smoothstep( 80.0, 800.0, viewDistance ) * 0.05;
    float alphaR = roughness * roughness;
    float alphaR2 = alphaR * alphaR;
    float kG = ( roughness + 1.0 ) * ( roughness + 1.0 ) / 8.0;

    vec3 sunH = normalize( uSunDir + V );
    float sunNoH = clamp( dot( N, sunH ), 0.0, 1.0 );
    float sunNoL = clamp( dot( N, uSunDir ), 0.0, 1.0 );
    float sunVoH = clamp( dot( V, sunH ), 0.0, 1.0 );
    float sunD = distributionGGX( sunNoH, alphaR2 );
    float sunGv = NoV / max( NoV * ( 1.0 - kG ) + kG, 1e-4 );
    float sunGl = sunNoL / max( sunNoL * ( 1.0 - kG ) + kG, 1e-4 );
    float sunF = 0.02 + 0.98 * pow( 1.0 - sunVoH, 5.0 );
    float sunSpecTerm = sunD * sunF * sunGv * sunGl / ( 4.0 * max( NoV, 1e-3 ) );
    vec3 sunSpec = uSunColor * (
      uSunIntensity * sunSpecTerm
      * ( 0.9 + 0.7 * breakNoise )
      * ( 1.0 - 0.65 * uCloudCover )
      * smoothstep( -0.06, 0.08, uSunDir.y )
    );
    // Broad sheen under the tight sparkles keeps the glitter path readable in
    // clear weather even where the micro-normal sparkle misses a given pixel.
    float sunSheen = pow( sunNoH, 96.0 ) * 0.5 * sunNoL;
    sunSpec += uSunColor * (
      uSunIntensity * sunSheen
      * ( 0.6 + 0.4 * breakNoise )
      * ( 1.0 - 0.5 * uCloudCover )
      * smoothstep( -0.06, 0.08, uSunDir.y )
    );
    sunSpec = min( sunSpec, vec3( 70.0 ) );

    float moonAlpha2 = alphaR2 * 3.0;
    vec3 moonH = normalize( uMoonDir + V );
    float moonNoH = clamp( dot( N, moonH ), 0.0, 1.0 );
    float moonNoL = clamp( dot( N, uMoonDir ), 0.0, 1.0 );
    float moonVoH = clamp( dot( V, moonH ), 0.0, 1.0 );
    float moonD = distributionGGX( moonNoH, moonAlpha2 );
    float moonGv = NoV / max( NoV * ( 1.0 - kG ) + kG, 1e-4 );
    float moonGl = moonNoL / max( moonNoL * ( 1.0 - kG ) + kG, 1e-4 );
    float moonF = 0.02 + 0.98 * pow( 1.0 - moonVoH, 5.0 );
    float moonSpecTerm = moonD * moonF * moonGv * moonGl / ( 4.0 * max( NoV, 1e-3 ) );
    vec3 moonSpec = uMoonColor * (
      uMoonIntensity * moonSpecTerm * 0.55 * smoothstep( -0.05, 0.1, uMoonDir.y )
    );
    moonSpec = min( moonSpec, vec3( 10.0 ) );

    // ----------------------------------------------------------- foam shade
    vec3 foamLight = ambientLight * 0.82 + sunLight * ( 0.14 + 0.42 * sunDiffuse );
    vec3 foamColor = uFoamColor * foamLight;

    // ------------------------------------------------------------ compose
    vec3 color = mix( body, reflection, fresnel );
    color += sssLight;
    color += sunSpec + moonSpec;
    color = mix( color, foamColor, foam );

    // Lightning flash (shared weather state) lights the surface and the foam.
    color += vec3( 0.45, 0.55, 0.8 ) * ( uLightning * ( 0.2 + 0.9 * foam ) );

    // exp2 fog, deliberately using the same curve as THREE.FogExp2 so the
    // ocean meets the fogged horizon of the terrain seamlessly.
    float fogAmount = fogExp2( vFogDepth, uFogDensity );
    color = mix( color, uFogColor, clamp( fogAmount, 0.0, 1.0 ) );

    // --------------------------------------------------------------- alpha
    // Only very shallow water is transparent, so the seabed and wet sand show
    // through. The fade to zero at the geometric waterline hides the coarse
    // plane/terrain intersection instead of exposing a hard, faceted edge.
    float depthFade = smoothstep( 0.0, 0.3, depthM );
    float baseAlpha = 0.40 + 0.60 * smoothstep( 0.0, 1.9, depthM );
    float specAlpha = clamp(
      dot( sunSpec + moonSpec, vec3( 0.299, 0.587, 0.114 ) ) * 1.4,
      0.0,
      1.0
    );

    float alpha = baseAlpha;
    alpha = max( alpha, fresnel * 0.9 * depthFade );
    alpha = max( alpha, specAlpha * depthFade );
    alpha = max( alpha, foam * 0.92 );
    alpha = clamp( alpha, 0.0, 1.0 );

    // Output linear HDR: the host's ACES/OutputPass applies tone mapping and
    // the sRGB transfer exactly once, after bloom and grading.
    gl_FragColor = vec4( color, alpha );
  }
`;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * PlaneGeometry spans -SIZE/2..SIZE/2 uniformly. Remap each axis through a
 * monotonic warp so vertices cluster around the island (where the shoreline,
 * shoaling and foam detail are) and spread out towards the fogged horizon.
 * The footprint stays exactly WATER_SIZE x WATER_SIZE.
 */
function warpAxis(value) {
  const half = WATER_SIZE * 0.5;
  const s = Math.min(Math.abs(value) / half, 1);
  const mapped = WARP_LINEAR * s + (1 - WARP_LINEAR) * Math.pow(s, WARP_POWER);
  return Math.sign(value) * mapped * half;
}

function createOceanGeometry() {
  const geometry = new THREE.PlaneGeometry(
    WATER_SIZE,
    WATER_SIZE,
    WATER_SEGMENTS,
    WATER_SEGMENTS,
  );
  // Bake the plane into the XZ plane with the normal pointing up (+Y).
  geometry.rotateX(-Math.PI / 2);

  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    positions.setX(i, warpAxis(positions.getX(i)));
    positions.setZ(i, warpAxis(positions.getZ(i)));
  }
  positions.needsUpdate = true;
  // Not strictly needed (frustumCulled is false) but keeps bounds coherent.
  geometry.computeBoundingSphere();

  return geometry;
}

// ---------------------------------------------------------------------------
// Small, allocation-free helpers for the per-frame env sync
// ---------------------------------------------------------------------------

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function copyVec3(target, source) {
  if (source && typeof source.x === 'number' && typeof source.y === 'number' && typeof source.z === 'number') {
    target.set(source.x, source.y, source.z);
  }
}

function copyColor(target, source) {
  if (source && typeof source.r === 'number' && typeof source.g === 'number' && typeof source.b === 'number') {
    // THREE.Color stores working (linear) components; copy them verbatim.
    target.setRGB(source.r, source.g, source.b);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 */
export function createWater(scene, renderer) {
  // ------------------------------------------------------------------ state
  let time = 0;
  let reflectionScale = REFLECTION_SCALE_DEFAULT;
  let renderingReflection = false;
  let mirrorCamera = null;
  let mirrorCameraSource = null;

  // ---------------------------------------------------------------- seabed
  // The baked RGBA map from heightfield.js: R = water depth (0..1 -> 0..30 m).
  const seabedTexture = createSeabedTexture();

  // ------------------------------------------------------------- reflection
  // Half drawing-buffer resolution by default; HDR (HalfFloat) so the mirror
  // image can be re-exposed / tone mapped exactly once by the water shader.
  const reflectionTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 0,
    colorSpace: THREE.LinearSRGBColorSpace,
  });
  reflectionTarget.texture.name = 'WaterReflection';

  // ---------------------------------------------------------------- uniforms
  const uniforms = {
    uTime: { value: 0 },

    // Gerstner spectrum (uploaded once; only the globals scale per frame).
    uWaveA: { value: WAVE_UNIFORM_A },
    uWaveB: { value: WAVE_UNIFORM_B },
    uWaveAmp: { value: 1 },
    uWaveChop: { value: 1 },
    uWaveSumAmp: { value: WAVE_SUM_AMPLITUDE },
    uSeabed: { value: seabedTexture },
    uSeabedXform: {
      value: new THREE.Vector2(1 / SEABED_COVERAGE, 1 / SEABED_COVERAGE),
    },

    // Planar reflection.
    uTextureMatrix: { value: new THREE.Matrix4() },
    tReflection: { value: reflectionTarget.texture },
    uReflectValid: { value: 0 },

    // Shared atmosphere / lighting. Values are copied from `env` each frame.
    uSunDir: { value: new THREE.Vector3(0.35, 0.82, 0.45) },
    uSunColor: { value: new THREE.Color('#fff1d0') },
    uSunIntensity: { value: 2.7 },
    uMoonDir: { value: new THREE.Vector3(-0.35, 0.82, -0.45) },
    uMoonColor: { value: new THREE.Color('#9fb7ff') },
    uMoonIntensity: { value: 0 },
    uDayFactor: { value: 1 },
    uNightFactor: { value: 0 },
    uTwilight: { value: 0 },
    uStorm: { value: 0 },
    uCloudCover: { value: 0.38 },
    uLightning: { value: 0 },
    uWindDir: { value: new THREE.Vector2(1, 0.35) },
    uWindStrength: { value: 0.35 },
    uFogColor: { value: new THREE.Color('#bed8e2') },
    uFogDensity: { value: 0.0024 },
    uSkyHorizon: { value: new THREE.Color('#cfe4ed') },
    uSkyZenith: { value: new THREE.Color('#3b79bd') },

    // Art-directed water palette (working/linear colour space via THREE.Color).
    uDeepColor: { value: new THREE.Color('#07293a') },
    uShallowColor: { value: new THREE.Color('#189488') },
    uFoamColor: { value: new THREE.Color('#eef8f5') },
  };

  // --------------------------------------------------------------- material
  const material = new THREE.ShaderMaterial({
    name: 'OceanMaterial',
    uniforms,
    vertexShader: OCEAN_VERTEX_SHADER,
    fragmentShader: OCEAN_FRAGMENT_SHADER,
    transparent: true,
    // The ocean is a single, height-field surface: writing depth is safe and
    // avoids transparent self-overlap artifacts between displaced triangles.
    depthWrite: true,
    depthTest: true,
    // Robust from every angle, including when the camera dips under a crest.
    side: THREE.DoubleSide,
    fog: false, // fog is integrated manually with env.fogColor / fogDensity
  });

  // ------------------------------------------------------------------- mesh
  const geometry = createOceanGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Ocean';
  mesh.position.set(0, SEA_LEVEL_Y, 0);
  mesh.frustumCulled = false; // the plane is always potentially visible
  // The opaque sky / terrain / props render in the opaque pass automatically.
  // A low render order puts the transparent ocean first among transparents;
  // it writes depth, so rain/particles drawn later (renderOrder >= 0) blend
  // over it correctly while anything behind it is depth-rejected.
  mesh.renderOrder = -1;
  mesh.matrixAutoUpdate = true;

  scene.add(mesh);

  // -------------------------------------------------- scratch objects (no GC)
  const drawingSize = new THREE.Vector2();
  const cameraWorldPosition = new THREE.Vector3();
  const meshWorldPosition = new THREE.Vector3();
  const waterNormal = new THREE.Vector3(0, 1, 0);
  const view = new THREE.Vector3();
  const lookAtPosition = new THREE.Vector3();
  const target = new THREE.Vector3();
  const rotationMatrix = new THREE.Matrix4();
  const reflectorPlane = new THREE.Plane();
  const clipPlane = new THREE.Vector4();
  const q = new THREE.Vector4();
  const textureMatrix = uniforms.uTextureMatrix.value;

  // =========================================================== reflection ===

  function ensureMirrorCamera(camera) {
    if (mirrorCamera === null || mirrorCameraSource !== camera) {
      // Clone once per camera (same approach as three's Reflector). Never per
      // frame, so the update path stays allocation free.
      mirrorCamera = camera.clone();
      mirrorCameraSource = camera;
    }
    return mirrorCamera;
  }

  /**
   * Mirror the main camera across the y = 0 water plane and build the
   * texture matrix, then replace the near plane of the projection with the
   * water plane (Lengyel's oblique near-plane clipping).
   */
  function setupMirrorCamera(camera) {
    camera.updateMatrixWorld();
    cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld);
    meshWorldPosition.setFromMatrixPosition(mesh.matrixWorld);

    // --- mirrored camera position -----------------------------------------
    view.subVectors(meshWorldPosition, cameraWorldPosition);
    view.reflect(waterNormal).negate().add(meshWorldPosition);
    mirrorCamera.position.copy(view);

    // --- mirrored look-at target (also mirrors the camera orientation) -----
    rotationMatrix.extractRotation(camera.matrixWorld);
    lookAtPosition.set(0, 0, -1).applyMatrix4(rotationMatrix).add(cameraWorldPosition);
    target.subVectors(meshWorldPosition, lookAtPosition);
    target.reflect(waterNormal).negate().add(meshWorldPosition);

    // Mirroring flips handedness; reflecting the up vector compensates so the
    // rendered image is a true mirror image. (Same trick as Reflector.)
    mirrorCamera.up.set(0, 1, 0).applyMatrix4(rotationMatrix).reflect(waterNormal);
    mirrorCamera.lookAt(target);
    mirrorCamera.near = camera.near;
    mirrorCamera.far = camera.far;
    mirrorCamera.updateMatrixWorld();

    // --- projective texture matrix (world space -> reflection texture uv) --
    // bias * projection * view. The water shader multiplies it by the
    // displaced world position; no model matrix is included on purpose.
    mirrorCamera.projectionMatrix.copy(camera.projectionMatrix);
    textureMatrix.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0,
    );
    textureMatrix.multiply(mirrorCamera.projectionMatrix);
    textureMatrix.multiply(mirrorCamera.matrixWorldInverse);

    // --- oblique near-plane clipping --------------------------------------
    // http://www.terathon.com/code/oblique.html
    reflectorPlane.setFromNormalAndCoplanarPoint(waterNormal, meshWorldPosition);
    reflectorPlane.applyMatrix4(mirrorCamera.matrixWorldInverse);
    clipPlane.set(
      reflectorPlane.normal.x,
      reflectorPlane.normal.y,
      reflectorPlane.normal.z,
      reflectorPlane.constant,
    );

    const projection = mirrorCamera.projectionMatrix;
    const e = projection.elements;
    let degenerate = false;

    if (mirrorCamera.isOrthographicCamera) {
      q.x = (Math.sign(clipPlane.x) + e[8]) / e[0];
      q.y = (Math.sign(clipPlane.y) + e[9]) / e[5];
      q.z = -camera.far;
      q.w = 1.0;
    } else {
      q.x = (Math.sign(clipPlane.x) + e[8]) / e[0];
      q.y = (Math.sign(clipPlane.y) + e[9]) / e[5];
      q.z = -1.0;
      q.w = (1.0 + e[10]) / e[14];
    }

    degenerate = !Number.isFinite(q.x) || !Number.isFinite(q.y)
      || !Number.isFinite(q.z) || !Number.isFinite(q.w);

    const denominator = clipPlane.dot(q);
    if (!degenerate && Number.isFinite(denominator) && Math.abs(denominator) > 1e-6) {
      clipPlane.multiplyScalar(2.0 / denominator);
      e[2] = clipPlane.x;
      e[6] = clipPlane.y;
      if (mirrorCamera.isOrthographicCamera) {
        e[10] = clipPlane.z - CLIP_BIAS;
        e[14] = clipPlane.w - 1.0;
      } else {
        e[10] = clipPlane.z + 1.0 - CLIP_BIAS;
        e[14] = clipPlane.w;
      }
    }
    // Keep the inverse in sync for shaders that rely on it (e.g. sky domes).
    // If the oblique step was skipped, this still yields a valid matrix.
    mirrorCamera.projectionMatrixInverse.copy(projection).invert();
  }

  /** Render the scene from the mirror camera into the reflection target. */
  function renderReflectionPass(camera) {
    const previousRenderTarget = renderer.getRenderTarget();
    const previousXrEnabled = renderer.xr.enabled;
    const previousShadowAutoUpdate = renderer.shadowMap.autoUpdate;

    renderer.xr.enabled = false; // never modify the XR camera
    renderer.shadowMap.autoUpdate = false; // reuse the shadow maps from the main view
    mesh.visible = false; // no feedback / no recursive reflection

    try {
      renderer.setRenderTarget(reflectionTarget);
      // Make sure the depth buffer is writable before the clear (#18897).
      renderer.state.buffers.depth.setMask(true);
      if (renderer.autoClear === false) renderer.clear();
      renderer.render(scene, mirrorCamera);
    } finally {
      mesh.visible = true;
      renderer.xr.enabled = previousXrEnabled;
      renderer.shadowMap.autoUpdate = previousShadowAutoUpdate;
      renderer.setRenderTarget(previousRenderTarget);

      // Restore a custom viewport the main camera may be using.
      if (camera.viewport !== undefined) renderer.state.viewport(camera.viewport);
    }
  }

  function updateReflection(camera) {
    uniforms.uReflectValid.value = 0;
    if (!mesh.visible || renderingReflection) return;

    camera.updateMatrixWorld();
    cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld);

    // Clamp near / under the surface: no usable mirror and no degenerate
    // oblique projection. The water shader falls back to a sky tint instead.
    if (cameraWorldPosition.y < MIN_REFLECTION_EYE_HEIGHT) return;

    renderingReflection = true;
    try {
      const mirror = ensureMirrorCamera(camera);
      setupMirrorCamera(camera);
      renderReflectionPass(camera);
      uniforms.uReflectValid.value = 1;
    } finally {
      renderingReflection = false;
    }
  }

  // ============================================================ size mgmt ===

  function refreshRenderTargetSize(force) {
    if (!renderer) return;
    renderer.getDrawingBufferSize(drawingSize);
    const width = Math.max(1, Math.round(drawingSize.x * reflectionScale));
    const height = Math.max(1, Math.round(drawingSize.y * reflectionScale));
    if (force || reflectionTarget.width !== width || reflectionTarget.height !== height) {
      reflectionTarget.setSize(width, height);
    }
  }

  /** Called on window resize / pixel-ratio change by the host. */
  function resize() {
    refreshRenderTargetSize(true);
  }

  /** 0.25 .. 0.75 fraction of the drawing-buffer size (default 0.5). */
  function setReflectionScale(scale) {
    const next = THREE.MathUtils.clamp(
      numberOr(scale, REFLECTION_SCALE_DEFAULT),
      REFLECTION_SCALE_MIN,
      REFLECTION_SCALE_MAX,
    );
    if (next === reflectionScale) return;
    reflectionScale = next;
    refreshRenderTargetSize(true);
  }

  // ============================================================ env sync ====

  function applyEnvironment(env) {
    copyVec3(uniforms.uSunDir.value, env.sunDir);
    copyColor(uniforms.uSunColor.value, env.sunColor);
    uniforms.uSunIntensity.value = Math.max(0, numberOr(env.sunIntensity, 0));

    copyVec3(uniforms.uMoonDir.value, env.moonDir);
    copyColor(uniforms.uMoonColor.value, env.moonColor);
    uniforms.uMoonIntensity.value = Math.max(0, numberOr(env.moonIntensity, 0));

    uniforms.uDayFactor.value = THREE.MathUtils.clamp(numberOr(env.dayFactor, 1), 0, 1);
    uniforms.uNightFactor.value = THREE.MathUtils.clamp(numberOr(env.nightFactor, 0), 0, 1);
    uniforms.uTwilight.value = THREE.MathUtils.clamp(numberOr(env.twilightFactor, 0), 0, 1);

    const storm = THREE.MathUtils.clamp(numberOr(env.stormMix, 0), 0, 1);
    uniforms.uStorm.value = storm;
    uniforms.uCloudCover.value = THREE.MathUtils.clamp(numberOr(env.cloudCover, 0.35), 0, 1);
    uniforms.uLightning.value = THREE.MathUtils.clamp(numberOr(env.lightning, 0), 0, 1);
    uniforms.uWindStrength.value = THREE.MathUtils.clamp(numberOr(env.windStrength, 0.35), 0, 1);

    if (env.windDir && typeof env.windDir.x === 'number' && typeof env.windDir.y === 'number') {
      uniforms.uWindDir.value.set(env.windDir.x, env.windDir.y);
    }

    copyColor(uniforms.uFogColor.value, env.fogColor);
    uniforms.uFogDensity.value = Math.max(0, numberOr(env.fogDensity, 0.0024));
    copyColor(uniforms.uSkyHorizon.value, env.skyHorizon);
    copyColor(uniforms.uSkyZenith.value, env.skyZenith);

    // Weather swell: storm grows both the amplitude and the horizontal chop.
    // waveScale stays the host's master calm/rough multiplier.
    const waveScale = numberOr(env.waveScale, 1);
    uniforms.uWaveAmp.value = THREE.MathUtils.clamp(
      waveScale * 1.14 * (1 + 1.05 * storm),
      0,
      3.4,
    );
    uniforms.uWaveChop.value = 1 + 0.5 * storm;
  }

  // =============================================================== update ===

  /**
   * Advance the wave clock, sync uniforms from `env`, then render the planar
   * reflection. Call this before the main `renderer.render(scene, camera)`.
   *
   * @param {number} dt seconds
   * @param {THREE.Camera} camera main camera
   * @param {object} env shared environment state (see environment.js)
   */
  function update(dt, camera, env) {
    // Clamp large frame gaps (tab switches) so the ocean never "teleports".
    time += Math.min(Math.max(numberOr(dt, 0), 0), 0.1);
    uniforms.uTime.value = time;

    if (env) applyEnvironment(env);

    // Cheap, allocation-free safety net for pixel-ratio changes: the host may
    // call resize(), but even if it doesn't the target follows the buffer.
    refreshRenderTargetSize(false);

    if (camera) updateReflection(camera);
  }

  // --------------------------------------------------------------- start-up
  refreshRenderTargetSize(true);

  return {
    mesh,
    reflectionTarget,
    update,
    setReflectionScale,
    resize,
  };
}
