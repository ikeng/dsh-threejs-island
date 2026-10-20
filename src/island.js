import * as THREE from 'three';
import {
  heightAt,
  gradientAt,
  slopeAt,
  SEA_LEVEL,
  TERRAIN_SIZE,
  TERRAIN_SEGMENTS,
  LIGHTHOUSE_SITE,
  coastRadius,
  fbm2,
  noise2,
  hash2,
} from './heightfield.js';

/**
 * The island: one high-resolution terrain mesh (land + seabed) plus a couple of
 * instanced shoreline / cliff rock meshes.
 *
 * Everything is derived from heightAt() in heightfield.js — the terrain vertices
 * literally are heightAt(x, z), so the waterline (y = 0) is exact and the ocean's
 * baked seabed map agrees vertex for vertex.
 *
 * The terrain is a single draw call. Albedo, ambient occlusion and roughness are
 * baked per vertex in linear space; wet sand gets a low per-vertex roughness and
 * a view-dependent sky-reflection term injected into MeshStandardMaterial. A
 * procedurally generated tiling bump texture adds close-up grain.
 */

const { clamp, lerp } = THREE.MathUtils;

const UP = new THREE.Vector3(0, 1, 0);
const BAY_ANGLE = 0.62; // the wide walkable bay baked into heightfield.coastRadius
const TRAIL_RADIUS = 2.5;
// Vertices below this height use the cheap deep-seabed bake (~95% of the mesh).
const DEEP_BAKE_HEIGHT = -6.5;

// ---------------------------------------------------------------------------
// Deterministic helpers (no Math.random anywhere: the scene rebuilds identically)
// ---------------------------------------------------------------------------

/** Fast seeded PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function angleDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Seamless tiling value noise (lattice wraps at `period`). */
function tileNoise(x, y, period) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const a = hash2(x0 + 0.5, y0 + 0.5);
  const b = hash2(x1 + 0.5, y0 + 0.5);
  const c = hash2(x0 + 0.5, y1 + 0.5);
  const d = hash2(x1 + 0.5, y1 + 0.5);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function tileFbm(u, v, baseFreq = 4, octaves = 4) {
  let sum = 0;
  let amp = 0.55;
  let norm = 0;
  let freq = baseFreq;
  for (let o = 0; o < octaves; o++) {
    sum += amp * tileNoise(u * freq, v * freq, freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// Palette (THREE.Color converts the sRGB hex strings into the linear working
// space, which is exactly what the vertex-colour attribute must hold).
// ---------------------------------------------------------------------------

const PAL = {
  // seabed
  deepSeabed: new THREE.Color('#1d2a2b'),
  midSeabed: new THREE.Color('#3d5049'),
  shelfSand: new THREE.Color('#b5a67f'),
  shallowSand: new THREE.Color('#c6b58c'),
  underwaterTint: new THREE.Color('#5f9a90'),
  algaeA: new THREE.Color('#4f6630'),
  algaeB: new THREE.Color('#6d7a3d'),
  seagrass: new THREE.Color('#3c5229'),
  sandBar: new THREE.Color('#d2c091'),

  // beach
  wetSandDark: new THREE.Color('#8a6d42'),
  wetSandLight: new THREE.Color('#b39362'),
  dampSand: new THREE.Color('#c3ad80'),
  drySand: new THREE.Color('#e4d3aa'),
  drySandWarm: new THREE.Color('#d6bf8f'),
  pebbleDark: new THREE.Color('#6f6858'),
  wrack: new THREE.Color('#4b4430'),

  // vegetation
  duneGrass: new THREE.Color('#8f9158'),
  grassA: new THREE.Color('#4b6231'),
  grassB: new THREE.Color('#3a4f28'),
  grassC: new THREE.Color('#657b40'),
  grassDry: new THREE.Color('#7d7b4d'),
  soil: new THREE.Color('#6d6448'),

  // rock
  rock: new THREE.Color('#7b7a73'),
  rockLight: new THREE.Color('#949188'),
  rockDark: new THREE.Color('#5d5c55'),
  basalt: new THREE.Color('#414447'),
  basaltDark: new THREE.Color('#2f3134'),

  // trail
  trailSand: new THREE.Color('#c9b384'),
  trailWorn: new THREE.Color('#b19a70'),

  // instanced rocks (baked onto the low-poly rock geometries)
  pebbleA: new THREE.Color('#8d8678'),
  pebbleB: new THREE.Color('#6d675c'),
  pebbleLight: new THREE.Color('#aca290'),
  pebbleMoss: new THREE.Color('#6f7a4b'),
  outcropA: new THREE.Color('#78776f'),
  outcropB: new THREE.Color('#5c5b56'),
  outcropLight: new THREE.Color('#918d83'),
  outcropMoss: new THREE.Color('#67713f'),
};

// Scratch colours for the bake passes (the build is synchronous, so reuse is safe).
const _c0 = new THREE.Color();
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const _c3 = new THREE.Color();
const _c4 = new THREE.Color();

// ---------------------------------------------------------------------------
// The lighthouse approach trail. A short, gently S-curved walk from the north
// beach (the natural ramp in the height field) up to the flattened plaza.
// ---------------------------------------------------------------------------

const TRAIL = [
  { x: -21.0, z: -12.4 },
  { x: -22.7, z: -8.1 },
  { x: -22.0, z: -4.4 },
  { x: -21.4, z: -0.6 },
  { x: -21.15, z: 2.6 },
  { x: -21.2, z: 4.9 },
];

function distanceToTrail(x, z) {
  // Cheap bounds reject: the trail lives in a small box west of the island centre.
  if (x < -34 || x > -13 || z < -18 || z > 10) return Infinity;
  let best = Infinity;
  for (let i = 0; i < TRAIL.length - 1; i++) {
    const ax = TRAIL[i].x;
    const az = TRAIL[i].z;
    const bx = TRAIL[i + 1].x;
    const bz = TRAIL[i + 1].z;
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let t = ((x - ax) * dx + (z - az) * dz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ddx = x - (ax + dx * t);
    const ddz = z - (az + dz * t);
    const d2 = ddx * ddx + ddz * ddz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

// ---------------------------------------------------------------------------
// Per-vertex shading bake
// ---------------------------------------------------------------------------

function computeAO(heights, count, step, i, j, h, slopeNorm) {
  // Three rings of eight neighbours: a cheap horizon/concavity approximation.
  const radii = [2, 4, 7];
  const weights = [0.5, 0.3, 0.2];
  let occlusion = 0;
  for (let r = 0; r < radii.length; r++) {
    const rr = radii[r];
    const scale = 1 / (rr * step);
    let ring = 0;
    let n = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const ni = i + dx * rr;
        const nj = j + dz * rr;
        if (ni < 0 || nj < 0 || ni >= count || nj >= count) continue;
        const dh = heights[nj * count + ni] - h;
        if (dh > 0) ring += dh * scale;
        n++;
      }
    }
    if (n > 0) occlusion += (ring / n) * weights[r];
  }

  // Concavity: how much the vertex sits below its immediate neighbours.
  const iL = i > 0 ? i - 1 : i;
  const iR = i < count - 1 ? i + 1 : i;
  const jD = j > 0 ? j - 1 : j;
  const jU = j < count - 1 ? j + 1 : j;
  const avg =
    (heights[j * count + iL] +
      heights[j * count + iR] +
      heights[jD * count + i] +
      heights[jU * count + i]) *
    0.25;
  const concavity = h - avg;

  let ao =
    1 - clamp(occlusion * 0.55, 0, 0.5) - clamp(concavity * 0.22, 0, 0.18) - slopeNorm * 0.1;
  if (h < SEA_LEVEL) ao = 1 - (1 - ao) * 0.45; // underwater ambient is softer
  return clamp(ao, 0.42, 1);
}

/** Full-quality bake for land and shallow water. Writes into `out`. */
function shadeDetailed(out, x, z, h, slopeNorm, ao) {
  const nLow = fbm2(x * 0.028 + 7.3, z * 0.028 - 4.1, 3);
  const nMid = fbm2(x * 0.09 - 2.6, z * 0.09 + 6.2, 3);
  const nFine = noise2(x * 0.42 + 11.1, z * 0.42 - 3.7);
  const nRidge = fbm2(x * 0.05 - 13.0, z * 0.05 + 2.4, 2);

  let roughness = 0.92;
  let wet = 0;
  let grassMix = 0;
  let rockMask = 0;
  let dampMask = 0;
  let trailMask = 0;

  if (h < SEA_LEVEL) {
    // ---- seabed: pale sand shelf, mottled algae, dark seagrass patches ------
    const depth = SEA_LEVEL - h;
    out.copy(PAL.shallowSand);
    out.lerp(PAL.shelfSand, smoothstep(0.3, 2.5, depth));
    out.lerp(PAL.midSeabed, smoothstep(2.5, 8.0, depth));
    out.lerp(PAL.deepSeabed, smoothstep(8.0, 22.0, depth));
    // Faint turquoise absorption so the shallow shelf reads through the water alpha.
    out.lerp(PAL.underwaterTint, smoothstep(0.15, 3.2, depth) * 0.3);
    // Continue the wet-sand stain just below the waterline so there is no seam.
    out.lerp(PAL.wetSandDark, smoothstep(0.55, 0.04, depth) * 0.55);

    if (depth < 10.0) {
      const algaeN = fbm2(x * 0.13 + 4.7, z * 0.13 - 8.1, 3);
      const algaeMask =
        smoothstep(0.52, 0.72, algaeN) *
        smoothstep(0.25, 1.4, depth) *
        (1 - smoothstep(3.4, 6.4, depth));
      _c0.copy(PAL.algaeA).lerp(PAL.algaeB, smoothstep(0.35, 0.75, nMid));
      out.lerp(_c0, algaeMask * 0.8);

      const grassN = fbm2(x * 0.19 - 6.0, z * 0.075 + 2.7, 2);
      out.lerp(
        PAL.seagrass,
        smoothstep(0.58, 0.78, grassN) *
          0.55 *
          smoothstep(0.6, 2.0, depth) *
          (1 - smoothstep(3.2, 6.4, depth)),
      );

      // Rippled sand bars / brighter shell banks.
      const barN = fbm2(x * 0.06 + 1.4, z * 0.06 - 5.2, 2);
      out.lerp(
        PAL.sandBar,
        smoothstep(0.58, 0.82, barN) * 0.3 * (1 - smoothstep(3.4, 6.4, depth)),
      );
    }

    out.multiplyScalar(0.94 + 0.1 * nFine);
    roughness = 0.58 + 0.26 * smoothstep(0, 7.0, depth);
    wet = 0;
  } else {
    // ---- beach sand --------------------------------------------------------
    _c0.copy(PAL.drySand).lerp(PAL.drySandWarm, smoothstep(0.3, 0.75, nMid));
    // Sparse dark pebble grains and shell speckle on the dry beach.
    const speckMask = smoothstep(0.84, 0.94, noise2(x * 1.55 + 3.3, z * 1.55 - 7.4));
    _c0.lerp(PAL.pebbleDark, speckMask * 0.5 * (1 - smoothstep(1.9, 3.4, h)));
    const sandGrain = hash2(Math.floor(x * 2.0), Math.floor(z * 2.0));
    _c0.multiplyScalar((0.94 + 0.12 * nFine) * (0.97 + 0.06 * sandGrain));

    // Wet-sand band, height ~0.02 .. 0.5. The upper edge wobbles with noise so
    // the waterline reads as a hand-painted stain rather than a hard contour.
    const wetStart = 0.02 + (nFine - 0.5) * 0.03;
    const wetEnd = 0.34 + (nMid - 0.5) * 0.18 + (nFine - 0.5) * 0.1;
    const wetMask = smoothstep(wetStart, wetStart + 0.07, h) * (1 - smoothstep(wetEnd, wetEnd + 0.24, h));
    _c1.copy(PAL.wetSandDark).lerp(PAL.wetSandLight, smoothstep(0.2, 0.8, nMid));
    const ripple = 0.5 + 0.5 * Math.sin((x * 0.9 + z * 0.55) * 4.2 + nFine * 2.4);
    _c1.multiplyScalar((0.92 + 0.16 * nFine) * (1 - 0.05 * ripple));
    out.copy(_c0).lerp(_c1, wetMask);

    // Damp sand just above the wet band.
    dampMask = smoothstep(0.5, 0.72, h) * (1 - smoothstep(0.98, 1.5, h)) * 0.45;
    out.lerp(PAL.dampSand, dampMask);

    // ---- beach wrack / pebble streaks (shore-parallel banding) --------------
    const angle = Math.atan2(z, x);
    const wrackBand = noise2(angle * 11.0 + 1.7, h * 3.4);
    const wrackMask =
      smoothstep(0.54, 0.72, 0.5 * wrackBand + 0.5 * nLow) *
      smoothstep(0.22, 0.42, h) *
      (1 - smoothstep(1.15, 1.75, h));
    out.lerp(PAL.wrack, wrackMask * 0.85);

    // ---- vegetation: dune grass transition, then varied interior greens -----
    const duneLine = 1.4 + (nLow - 0.5) * 1.9 + (nFine - 0.5) * 0.8 + slopeNorm * 0.7;
    grassMix = smoothstep(duneLine, duneLine + 1.15, h);
    if (grassMix > 0.001) {
      _c2.copy(PAL.grassA).lerp(PAL.grassB, smoothstep(0.28, 0.7, nMid));
      _c2.lerp(PAL.grassC, smoothstep(0.55, 0.85, nRidge) * 0.6);
      const dryPatch = fbm2(x * 0.045 - 9.0, z * 0.045 + 3.3, 2);
      _c2.lerp(PAL.grassDry, smoothstep(0.6, 0.88, dryPatch) * 0.45);
      // Bare soil / heath patches break up the "green carpet" look.
      const soilPatch = fbm2(x * 0.035 + 4.9, z * 0.035 - 6.1, 2);
      _c2.lerp(PAL.soil, smoothstep(0.64, 0.86, soilPatch) * 0.35);
      _c2.lerp(PAL.duneGrass, (1 - smoothstep(duneLine + 0.2, duneLine + 1.7, h)) * 0.6);
      _c2.multiplyScalar(0.88 + 0.22 * nFine);
      out.lerp(_c2, grassMix);
    }

    // The high dome should stay mossy/forested; without this it reads as one
    // bald grey boulder from every angle.
    if (grassMix > 0.001 && h > 7.0) {
      _c2.copy(PAL.grassB).lerp(PAL.grassA, 0.35 + 0.3 * nFine);
      out.lerp(_c2, smoothstep(7.0, 14.5, h) * grassMix * (0.35 + 0.25 * nRidge));
    }

    // ---- exposed rock on steep faces and high ridges -----------------------
    const steepMask = smoothstep(0.62, 0.9, slopeNorm);
    const ridgeRock =
      smoothstep(12.0, 16.5, h) * smoothstep(0.64, 0.88, 0.4 + 0.6 * nRidge) * 0.55;
    rockMask = Math.max(steepMask, ridgeRock);
    rockMask = clamp(rockMask * (0.78 + 0.3 * smoothstep(0.35, 0.7, nMid)), 0, 1);
    if (rockMask > 0.002) {
      _c3.copy(PAL.rock).lerp(PAL.rockLight, smoothstep(0.35, 0.7, nMid));
      // Sedimentary strata bands follow elevation, so cliffs read as layered rock.
      const strata = 0.5 + 0.5 * Math.sin(h * 2.6 + nMid * 7.0 + nLow * 3.0);
      _c3.lerp(PAL.rockDark, (1 - strata) * 0.45);
      _c3.lerp(PAL.rockDark, smoothstep(0.3, 0.7, nLow) * 0.3);
      const basalt = smoothstep(0.62, 0.9, slopeNorm) * (0.4 + 0.6 * smoothstep(0.4, 0.7, nLow));
      const seaCliff = smoothstep(0.64, 0.92, slopeNorm) * (1 - smoothstep(5.5, 9.0, h)) * 0.9;
      _c3.lerp(PAL.basalt, clamp(Math.max(basalt, seaCliff), 0, 1));
      _c3.lerp(PAL.basaltDark, smoothstep(0.85, 1.0, slopeNorm) * 0.45);
      _c3.multiplyScalar(0.85 + 0.24 * nFine);
      out.lerp(_c3, rockMask);
    }

    // ---- lighthouse approach trail (sandy path drawn in vertex colours) -----
    const trailDist = distanceToTrail(x, z);
    if (trailDist < TRAIL_RADIUS) {
      trailMask =
        (1 - smoothstep(0.8, TRAIL_RADIUS, trailDist)) *
        smoothstep(0.16, 0.42, h) *
        (1 - smoothstep(0.88, 1.0, slopeNorm) * 0.5);
      if (trailMask > 0.001) {
        _c4.copy(PAL.trailSand).lerp(PAL.trailWorn, 1 - smoothstep(0.12, 1.0, trailDist));
        out.lerp(_c4, trailMask * 0.92);
      }
    }

    // ---- roughness / wetness ----------------------------------------------
    const wetRough = 0.2 + 0.13 * (1 - nFine);
    roughness = 0.93;
    roughness = lerp(roughness, 0.66, dampMask);
    roughness = lerp(roughness, wetRough, wetMask);
    roughness = lerp(roughness, 0.74, wrackMask * 0.7);
    roughness = lerp(roughness, 0.95, grassMix);
    roughness = lerp(roughness, 0.84, rockMask);
    roughness = lerp(roughness, 0.68, trailMask);

    wet = clamp(wetMask * (0.72 + 0.5 * nLow) + dampMask * 0.35 + wrackMask * 0.2, 0, 1);
  }

  // ---- baked ambient occlusion ---------------------------------------------
  const aoMul = SEA_LEVEL > h ? 0.68 + 0.32 * ao : 0.44 + 0.56 * ao;
  out.r *= aoMul;
  out.g *= aoMul;
  out.b *= aoMul;

  return { roughness, wet };
}

/**
 * Fast bake for the deep seabed (the vast majority of the terrain vertices).
 * Mirrors the base colour ramp of shadeDetailed() so the hand-off at
 * DEEP_BAKE_HEIGHT is invisible under the deep ocean, then keeps a coarse hash
 * variation so the abyss is not a flat colour field.
 */
function shadeDeep(out, x, z, h) {
  const depth = SEA_LEVEL - h;
  out.copy(PAL.shallowSand);
  out.lerp(PAL.shelfSand, smoothstep(0.3, 2.5, depth));
  out.lerp(PAL.midSeabed, smoothstep(2.5, 8.0, depth));
  out.lerp(PAL.underwaterTint, smoothstep(0.15, 3.2, depth) * 0.3);
  out.lerp(PAL.deepSeabed, smoothstep(8.0, 22.0, depth));
  _c0.copy(PAL.deepSeabed).multiplyScalar(0.6);
  out.lerp(_c0, smoothstep(30.0, 90.0, depth));
  const grain = hash2(Math.floor(x * 0.35), Math.floor(z * 0.35));
  out.multiplyScalar(0.94 + 0.1 * grain);
  return { roughness: 0.86, wet: 0 };
}

// ---------------------------------------------------------------------------
// Procedural tiling bump texture (grayscale, high repeat)
// ---------------------------------------------------------------------------

function createDetailBumpTexture() {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const broad = tileFbm(u, v, 4, 4);
      const grain = tileNoise(u * 64.0, v * 64.0, 64);
      const mid = tileNoise(u * 16.0, v * 16.0, 16);
      let value = 0.5 * broad + 0.28 * grain + 0.22 * mid;
      value = 0.5 + (value - 0.5) * 0.9;
      const byte = Math.round(clamp(value, 0, 1) * 255);
      const k = (y * size + x) * 4;
      data[k] = byte;
      data[k + 1] = byte;
      data[k + 2] = byte;
      data[k + 3] = 255;
    }
  }

  let texture = null;
  if (typeof document !== 'undefined' && document.createElement) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const image = ctx.createImageData(size, size);
        image.data.set(data);
        ctx.putImageData(image, 0, 0);
        texture = new THREE.CanvasTexture(canvas);
      }
    } catch (error) {
      texture = null; // fall back to a DataTexture below
    }
  }
  if (!texture) {
    texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  }

  texture.name = 'IslandDetailBump';
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

// ---------------------------------------------------------------------------
// Instanced rock geometry + placement
// ---------------------------------------------------------------------------

/**
 * Low-poly noise-displaced rock. IcosahedronGeometry is non-indexed, so
 * computeVertexNormals() produces faceted normals and the duplicated vertices
 * displace identically (the displacement is a function of the vertex direction).
 */
function createRockGeometry(seed, { detail = 1, amp = 0.3, flatten = 0.72, kind = 'pebble' }) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const position = geo.attributes.position;
  const v = new THREE.Vector3();
  const phase = hash2(seed * 0.001, seed * 0.003) * 40;

  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i).normalize();
    const big = fbm2(v.x * 1.6 + phase, v.z * 1.6 - v.y * 1.2 - phase * 0.7, 3) - 0.5;
    const fine = hash2(v.x * 7.3 + phase, v.z * 7.3 + v.y * 3.7) - 0.5;
    const radial = 1 + big * amp * 2.0 + fine * amp * 0.55;
    v.multiplyScalar(radial);
    v.y *= flatten;
    position.setXYZ(i, v.x, v.y, v.z);
  }
  position.needsUpdate = true;

  const colors = new Float32Array(position.count * 3);
  const faceA = kind === 'pebble' ? PAL.pebbleA : PAL.outcropA;
  const faceB = kind === 'pebble' ? PAL.pebbleB : PAL.outcropB;
  const faceLight = kind === 'pebble' ? PAL.pebbleLight : PAL.outcropLight;
  const faceMoss = kind === 'pebble' ? PAL.pebbleMoss : PAL.outcropMoss;
  const col = new THREE.Color();
  for (let f = 0; f < position.count; f += 3) {
    const faceSeed = hash2(f * 0.37 + seed * 0.0001, f * 0.11 - 3.1);
    // Average local Y of the face: upper faces catch light and moss.
    const yA = position.getY(f);
    const yB = position.getY(f + 1);
    const yC = position.getY(f + 2);
    const upFace = clamp((yA + yB + yC) / 3 * 1.5 + 0.2, 0, 1);
    col.copy(faceA).lerp(faceB, faceSeed);
    col.lerp(faceLight, upFace * 0.3);
    const moss = upFace * smoothstep(0.55, 0.9, faceSeed) * 0.5;
    col.lerp(faceMoss, moss);
    for (let k = 0; k < 3; k++) {
      const o = (f + k) * 3;
      colors[o] = col.r;
      colors[o + 1] = col.g;
      colors[o + 2] = col.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Regions where small rocks must not appear (plaza, trail, walkable bay beach). */
function isRockExcluded(x, z, h) {
  const lx = x - LIGHTHOUSE_SITE.x;
  const lz = z - LIGHTHOUSE_SITE.z;
  if (lx * lx + lz * lz < 11.0 * 11.0) return true;
  if (distanceToTrail(x, z) < TRAIL_RADIUS + 0.5) return true;
  const angle = Math.atan2(z, x);
  if (Math.abs(angleDelta(angle, BAY_ANGLE)) < 0.8 && h > -1.2 && h < 3.0) return true;
  return false;
}

function collectPebbles(seed, target) {
  const rng = mulberry32(seed);
  const items = [];
  let guard = 0;
  while (items.length < target && guard < 30000) {
    guard++;
    const angle = rng() * Math.PI * 2;
    const coast = coastRadius(angle);
    const radial = coast + (rng() * 2 - 0.62) * 10.5;
    const x = Math.cos(angle) * radial;
    const z = Math.sin(angle) * radial;
    const h = heightAt(x, z);
    if (h < -0.7 || h > 2.1) continue;
    if (slopeAt(x, z) > 0.62) continue;
    if (isRockExcluded(x, z, h)) continue;
    const nearWater = 1 - smoothstep(0.2, 2.0, h);
    const size = (0.13 + rng() * 0.34) * (0.8 + 0.5 * nearWater);
    items.push({
      x,
      z,
      h,
      size,
      yaw: rng() * Math.PI * 2,
      tiltX: (rng() - 0.5) * 0.7,
      tiltZ: (rng() - 0.5) * 0.7,
      shade: 0.72 + rng() * 0.5,
      moss: rng(),
    });
  }
  return items;
}

function collectOutcrops(seed, target) {
  const rng = mulberry32(seed);
  const items = [];
  let guard = 0;
  while (items.length < target && guard < 40000) {
    guard++;
    const x = (rng() * 2 - 1) * 46;
    const z = (rng() * 2 - 1) * 46;
    const radius = Math.hypot(x, z);
    if (radius < 17 || radius > 44) continue;
    const h = heightAt(x, z);
    if (h < 1.8 || h > 16) continue;
    if (slopeAt(x, z) < 0.74) continue;
    if (isRockExcluded(x, z, h)) continue;
    const grad = gradientAt(x, z);
    const invLen = 1 / Math.sqrt(grad.x * grad.x + 1 + grad.z * grad.z);
    items.push({
      x,
      z,
      h,
      nx: -grad.x * invLen,
      nz: -grad.z * invLen,
      size: 0.22 + rng() * 0.45,
      stretch: 0.85 + rng() * 0.7,
      yaw: rng() * Math.PI * 2,
      shade: 0.78 + rng() * 0.4,
      moss: rng(),
    });
  }
  return items;
}

function buildRockMesh(geometry, material, items, { alignToNormal, name, seed }) {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(items.length, 1));
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const rng = mulberry32(seed);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const yawQuat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const tilt = new THREE.Euler();
  const color = new THREE.Color();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (alignToNormal) {
      position.set(item.x, item.h - item.size * 0.62, item.z);
      normal.set(item.nx, 1, item.nz).normalize();
      quaternion.setFromUnitVectors(UP, normal);
      yawQuat.setFromAxisAngle(UP, item.yaw);
      quaternion.multiply(yawQuat);
      scale.set(item.size, item.size * item.stretch, item.size * (0.85 + rng() * 0.4));
    } else {
      position.set(item.x, item.h - item.size * 0.32, item.z);
      tilt.set(item.tiltX, item.yaw, item.tiltZ, 'XYZ');
      quaternion.setFromEuler(tilt);
      scale.set(item.size, item.size * 0.82, item.size);
    }
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);

    const shade = item.shade;
    const moss = item.moss > 0.72 ? (item.moss - 0.72) / 0.28 : 0;
    color.setRGB(shade * (1 - 0.1 * moss), shade * (1 + 0.05 * moss), shade * (0.98 - 0.2 * moss));
    mesh.setColorAt(i, color);
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

// ---------------------------------------------------------------------------
// Wet-sand sheen shader injection
// ---------------------------------------------------------------------------

function installTerrainShader(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSheenHorizon = uniforms.uSheenHorizon;
    shader.uniforms.uSheenZenith = uniforms.uSheenZenith;
    shader.uniforms.uSunColor = uniforms.uSunColor;
    shader.uniforms.uSunDir = uniforms.uSunDir;
    shader.uniforms.uSheenIntensity = uniforms.uSheenIntensity;
    shader.uniforms.uMoonFactor = uniforms.uMoonFactor;
    shader.uniforms.uTime = uniforms.uTime;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aRoughness;
        attribute float aWet;
        attribute float aAO;
        varying float vTerrainRough;
        varying float vTerrainWet;
        varying float vTerrainAO;
        varying vec3 vTerrainWorldNormal;
        varying vec3 vTerrainWorldPos;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        vTerrainWorldNormal = normalize( ( modelMatrix * vec4( objectNormal, 0.0 ) ).xyz );`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTerrainWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
        vTerrainRough = aRoughness;
        vTerrainWet = aWet;
        vTerrainAO = aAO;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uSheenHorizon;
        uniform vec3 uSheenZenith;
        uniform vec3 uSunColor;
        uniform vec3 uSunDir;
        uniform float uSheenIntensity;
        uniform float uMoonFactor;
        uniform float uTime;
        varying float vTerrainRough;
        varying float vTerrainWet;
        varying float vTerrainAO;
        varying vec3 vTerrainWorldNormal;
        varying vec3 vTerrainWorldPos;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp( vTerrainRough, 0.05, 1.0 );`,
      )
      .replace(
        '#include <opaque_fragment>',
        `// ---- wet-sand sky sheen: reflects the sky at grazing angles -----------------
        {
          vec3 tN = normalize( vTerrainWorldNormal );
          vec3 tV = normalize( cameraPosition - vTerrainWorldPos );
          float ndv = saturate( dot( tN, tV ) );
          float fresnel = pow( 1.0 - ndv, 5.0 );
          vec3 refl = reflect( -tV, tN );
          float skyT = saturate( refl.y * 0.5 + 0.5 );
          vec3 skyRaw = mix( uSheenHorizon, uSheenZenith, smoothstep( 0.02, 0.85, skyT ) );
          // Desaturate and warm the reflection a little: wet sand should tint the
          // sky, never paint a saturated blue stripe over the dark wet band.
          float skyLuma = dot( skyRaw, vec3( 0.299, 0.587, 0.114 ) );
          vec3 skyColor = mix( vec3( skyLuma ), skyRaw, 0.5 ) * 0.95;
          skyColor = mix( skyColor, uSunColor, 0.22 );
          vec3 sunDirN = normalize( uSunDir );
          float glint = pow( saturate( dot( refl, sunDirN ) ), 32.0 );
          vec3 glintColor = mix( uSunColor, vec3( 0.52, 0.62, 0.86 ), uMoonFactor );
          float sparkle = 0.7 + 0.3 * sin( uTime * 2.3 + vTerrainWorldPos.x * 2.1 + vTerrainWorldPos.z * 1.7 );
          // Patchy sheen: tide leaves some patches glossier than others.
          float tidePatch = 0.62 + 0.38 * ( 0.5 + 0.5 * sin( vTerrainWorldPos.x * 2.1 + sin( vTerrainWorldPos.z * 1.7 ) * 1.4 ) );
          float wet = saturate( vTerrainWet ) * uSheenIntensity * ( 0.65 + 0.35 * vTerrainAO ) * tidePatch;
          outgoingLight += skyColor * ( fresnel * 0.5 ) * wet;
          outgoingLight += glintColor * glint * sparkle * wet * 0.3;
        }
        #include <opaque_fragment>`,
      );
  };
  // Forces a distinct program cache entry for this material.
  material.customProgramCacheKey = () => 'island-terrain-wet-sheen';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createIsland(scene) {
  const group = new THREE.Group();
  group.name = 'Island';

  const segments = TERRAIN_SEGMENTS;
  const size = TERRAIN_SIZE;
  const half = size * 0.5;
  const step = size / segments;
  const count = segments + 1;
  const vertexCount = count * count;

  // ---- 1. Sample the single source of truth ---------------------------------
  const heights = new Float32Array(vertexCount);
  for (let j = 0; j < count; j++) {
    const z = -half + j * step;
    for (let i = 0; i < count; i++) {
      heights[j * count + i] = heightAt(-half + i * step, z);
    }
  }

  // ---- 2. Build vertex attributes ------------------------------------------
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colors = new Float32Array(vertexCount * 3);
  const roughness = new Float32Array(vertexCount);
  const wetness = new Float32Array(vertexCount);
  const aoAttr = new Float32Array(vertexCount);

  const color = new THREE.Color();

  for (let j = 0; j < count; j++) {
    const z = -half + j * step;
    for (let i = 0; i < count; i++) {
      const x = -half + i * step;
      const vi = j * count + i;
      const h = heights[vi];

      // Smooth analytic-style normals from the height grid (central differences).
      const iL = i > 0 ? i - 1 : i;
      const iR = i < count - 1 ? i + 1 : i;
      const jD = j > 0 ? j - 1 : j;
      const jU = j < count - 1 ? j + 1 : j;
      const dhdx = (heights[j * count + iR] - heights[j * count + iL]) / ((iR - iL) * step);
      const dhdz = (heights[jU * count + i] - heights[jD * count + i]) / ((jU - jD) * step);
      const invNormal = 1 / Math.sqrt(dhdx * dhdx + 1 + dhdz * dhdz);
      const nx = -dhdx * invNormal;
      const ny = invNormal;
      const nz = -dhdz * invNormal;

      const slopeNorm = clamp(Math.sqrt(dhdx * dhdx + dhdz * dhdz) * 0.5, 0, 1);
      const ao =
        h < DEEP_BAKE_HEIGHT ? 1 : computeAO(heights, count, step, i, j, h, slopeNorm);

      if (h < DEEP_BAKE_HEIGHT) {
        const deep = shadeDeep(color, x, z, h);
        roughness[vi] = deep.roughness;
        wetness[vi] = deep.wet;
      } else {
        const bake = shadeDetailed(color, x, z, h, slopeNorm, ao);
        roughness[vi] = bake.roughness;
        wetness[vi] = bake.wet;
        // Deterministic per-vertex grain: breaks up smooth vertex-colour ramps
        // on steep slopes so the paint reads as hand-made rather than banded.
        color.multiplyScalar(0.965 + 0.07 * hash2(i * 1.37 + 5.1, j * 2.11 - 3.7));
      }

      positions[vi * 3] = x;
      positions[vi * 3 + 1] = h;
      positions[vi * 3 + 2] = z;

      normals[vi * 3] = nx;
      normals[vi * 3 + 1] = ny;
      normals[vi * 3 + 2] = nz;

      uvs[vi * 2] = x / 3.5; // high-repeat tiling for the detail bump map
      uvs[vi * 2 + 1] = z / 3.5;

      colors[vi * 3] = color.r;
      colors[vi * 3 + 1] = color.g;
      colors[vi * 3 + 2] = color.b;

      aoAttr[vi] = ao;
    }
  }

  // ---- 3. Index buffer (CCW from above) ------------------------------------
  const indexCount = segments * segments * 6;
  const indices = new Uint32Array(indexCount);
  let ptr = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * count + i;
      const b = a + 1;
      const c = a + count;
      const d = c + 1;
      indices[ptr++] = a;
      indices[ptr++] = c;
      indices[ptr++] = b;
      indices[ptr++] = b;
      indices[ptr++] = c;
      indices[ptr++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.name = 'IslandTerrain';
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aRoughness', new THREE.BufferAttribute(roughness, 1));
  geometry.setAttribute('aWet', new THREE.BufferAttribute(wetness, 1));
  geometry.setAttribute('aAO', new THREE.BufferAttribute(aoAttr, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();

  // ---- 4. Material with baked roughness + reflected-sky sheen --------------
  const sheenUniforms = {
    uSheenHorizon: { value: new THREE.Color('#cfe4ed') },
    uSheenZenith: { value: new THREE.Color('#3b79bd') },
    uSunColor: { value: new THREE.Color('#fff1d0') },
    uSunDir: { value: new THREE.Vector3(0.35, 0.82, 0.45).normalize() },
    uSheenIntensity: { value: 0.9 },
    uMoonFactor: { value: 0 },
    uTime: { value: 0 },
  };

  const detailBump = createDetailBumpTexture();
  const material = new THREE.MeshStandardMaterial({
    name: 'IslandTerrainMaterial',
    color: 0xffffff,
    vertexColors: true,
    roughness: 1.0, // overridden per vertex in the shader
    metalness: 0.0,
    bumpMap: detailBump,
    bumpScale: 1.0,
    dithering: true,
  });
  installTerrainShader(material, sheenUniforms);

  const terrain = new THREE.Mesh(geometry, material);
  terrain.name = 'IslandTerrain';
  terrain.castShadow = true;
  terrain.receiveShadow = true;
  terrain.matrixAutoUpdate = false;
  terrain.updateMatrix();
  group.add(terrain);

  // ---- 5. Sparse instanced shoreline rocks + cliff outcrops ----------------
  const pebbleGeometry = createRockGeometry(1337, {
    detail: 1,
    amp: 0.22,
    flatten: 0.68,
    kind: 'pebble',
  });
  const outcropGeometry = createRockGeometry(424242, {
    detail: 1,
    amp: 0.42,
    flatten: 0.92,
    kind: 'outcrop',
  });

  const pebbleMaterial = new THREE.MeshStandardMaterial({
    name: 'ShorePebbleMaterial',
    vertexColors: true,
    roughness: 0.6,
    metalness: 0.03,
    flatShading: true,
    dithering: true,
  });
  const outcropMaterial = new THREE.MeshStandardMaterial({
    name: 'CliffOutcropMaterial',
    vertexColors: true,
    roughness: 0.86,
    metalness: 0.02,
    flatShading: true,
    dithering: true,
  });

  const pebbleItems = collectPebbles(0x51e7a11, 116);
  const outcropItems = collectOutcrops(0x0c1ff0c, 46);

  const pebbles = buildRockMesh(pebbleGeometry, pebbleMaterial, pebbleItems, {
    alignToNormal: false,
    name: 'ShorePebbles',
    seed: 0x24f00d,
  });
  const outcrops = buildRockMesh(outcropGeometry, outcropMaterial, outcropItems, {
    alignToNormal: true,
    name: 'CliffOutcrops',
    seed: 0x5eed77,
  });
  group.add(pebbles, outcrops);

  // ---- 6. Attach to the scene ---------------------------------------------
  scene.add(group);

  // ---- 7. Per-frame update: cache env-derived colours into the uniforms ----
  let elapsed = 0;

  function update(dt, env) {
    const delta = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    elapsed += delta;
    sheenUniforms.uTime.value = elapsed;

    if (!env) return;

    if (env.sunDir && sheenUniforms.uSunDir.value.copy) {
      sheenUniforms.uSunDir.value.copy(env.sunDir);
    }
    if (env.sunColor && sheenUniforms.uSunColor.value.copy) {
      sheenUniforms.uSunColor.value.copy(env.sunColor);
    }
    if (env.skyHorizon && sheenUniforms.uSheenHorizon.value.copy) {
      sheenUniforms.uSheenHorizon.value.copy(env.skyHorizon);
    } else if (env.fogColor && sheenUniforms.uSheenHorizon.value.copy) {
      sheenUniforms.uSheenHorizon.value.copy(env.fogColor);
    }
    if (env.skyZenith && sheenUniforms.uSheenZenith.value.copy) {
      sheenUniforms.uSheenZenith.value.copy(env.skyZenith);
    }

    const day = env.dayFactor ?? 1;
    const night = env.nightFactor ?? 0;
    const storm = env.stormMix ?? 0;
    sheenUniforms.uMoonFactor.value = clamp(night, 0, 1);
    // Wet sand reflects the sky most on clear days; storms and night mute it.
    sheenUniforms.uSheenIntensity.value = clamp(0.2 + 0.55 * day - 0.25 * storm + 0.1 * night, 0, 0.9);
  }

  return { group, terrain, update };
}
