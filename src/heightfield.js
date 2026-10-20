import * as THREE from 'three';

/**
 * The single source of truth for the island silhouette.
 *
 * heightAt(x, z) is used by the terrain mesh, the baked seabed-depth texture
 * sampled by the ocean, and every vegetation / prop placement routine. Because
 * all of them share the exact same function, the waterline and the beach are
 * guaranteed to line up.
 */

export const SEA_LEVEL = 0;
export const TERRAIN_SIZE = 360;
export const WORLD_HALF = TERRAIN_SIZE * 0.5;
export const TERRAIN_SEGMENTS = 320;
export const WATER_SIZE = 1400;
export const LIGHTHOUSE_SITE = Object.freeze({ x: -21.2, z: 9.4, plateau: 6.35 });

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

export function hash2(x, y) {
  let h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return h - Math.floor(h);
}

/** Smooth value noise in [0, 1]. */
export function noise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal value noise, roughly [0, 1]. */
export function fbm2(x, y, octaves = 4, lacunarity = 2.03, gain = 0.5) {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq + i * 17.13, y * freq - i * 9.71);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

function smoothstep(edge0, edge1, x) {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Island height field
// ---------------------------------------------------------------------------

/** Radially warped coastline radius at a given angle (radians). */
export function coastRadius(angle) {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const shape =
    (fbm2(ca * 2.15 + 8.7, sa * 2.15 - 3.4, 3) - 0.5) * 4.6 +
    Math.sin(angle * 3 + 0.72) * 2.3 +
    Math.sin(angle * 5 - 1.35) * 1.15 +
    Math.sin(angle * 2 - 2.4) * 1.8;
  // A wide, gentle bay on the south-east side.
  const bay = Math.exp(-Math.pow((angle - 0.62) / 0.42, 2)) * 4.2;
  return 30.4 + shape - bay;
}

function landMass(x, z, inland) {
  const mask = smoothstep(1.5, 15, inland);
  const ridgeMask = smoothstep(2.0, 11.0, inland);

  // Main hill, a jagged secondary horn, the west headland and a low eastern
  // shoulder. The overlapping peaks keep the skyline asymmetric instead of a
  // smooth dome.
  const h1 = 11.9 * Math.exp(-((x + 2.6) ** 2 + (z + 5.2) ** 2) / (2 * 11.8 ** 2));
  const horn = 5.1 * Math.exp(
    -(((x + 8.6) ** 2) / (2 * 4.3 ** 2) + ((z + 0.8) ** 2) / (2 * 3.9 ** 2)),
  );
  const h2 = 8.9 * Math.exp(-((x + 18.2) ** 2 + (z + 2.8) ** 2) / (2 * 7.6 ** 2));
  const h3 = 5.3 * Math.exp(-((x - 13.5) ** 2 + (z - 4.5) ** 2) / (2 * 9.2 ** 2));
  const h4 = 6.1 * Math.exp(-((x - 3.0) ** 2 + (z - 15.0) ** 2) / (2 * 7.8 ** 2));

  let hills = (h1 + horn + h2 + h3 + h4) * mask;

  // Ridges, gullies and a subtle river-cut. Kept away from the shoreline so
  // beaches stay walkable and the waterline stays clean.
  const ridge = fbm2(x * 0.062 + 4.2, z * 0.062 - 2.8, 5) - 0.5;
  const ridged = 1 - Math.abs(2 * fbm2(x * 0.105 - 3.2, z * 0.105 + 7.4, 4) - 1);
  const gully = (fbm2(x * 0.18 - 9.0, z * 0.18 + 5.0, 3) - 0.5) * 0.55;
  hills += (ridge * 3.0 + (ridged - 0.6) * 1.7 + gully) * ridgeMask;

  const beach = 1.18 * smoothstep(0, 13.5, inland) + 0.06;
  const micro = (fbm2(x * 0.55, z * 0.55, 2) - 0.5) * 0.16 * smoothstep(0.6, 5.0, inland);

  return beach + hills + micro;
}

/**
 * Height in world units relative to sea level (positive = land).
 * Smoothly continues under water, so it also defines the seabed.
 */
export function heightAt(x, z) {
  const dist = Math.sqrt(x * x + z * z);
  const angle = Math.atan2(z, x);
  const coast = coastRadius(angle);
  const inland = coast - dist;

  let h;
  if (inland < 0) {
    // Seabed: a shallow shelf, then a steeper drop into deeper water.
    const offshore = -inland;
    const shelf = -0.14 * offshore - 0.0034 * offshore * offshore;
    const dunes = (fbm2(x * 0.055 + 5.0, z * 0.055 - 1.7, 4) - 0.5) * 1.5;
    const duneMask = smoothstep(2.0, 22.0, offshore);
    h = shelf + dunes * duneMask;
    // A submerged sandbar trailing off the south coast.
    const bar = Math.exp(-(((x - 9) / 21) ** 2 + ((z - 35) / 7.0) ** 2)) * 2.4;
    h += bar * smoothstep(4, 16, offshore);
    h = Math.min(h, -0.012);
    // Keep the sandbar comfortably underwater so it reads as a turquoise shelf.
    if (h > -0.45) h = -0.45 - (h + 0.45) * 0.2;
    return h;
  }

  h = landMass(x, z, inland);

  // A carved saddle connects the headland to the beach without ever dropping
  // inland terrain below the waterline (which used to leave a pond).
  const saddle = Math.exp(-((x + 15.7) ** 2 + (z - 14.4) ** 2) / (2 * 4.8 ** 2));
  h -= saddle * 0.85 * smoothstep(1.5, 6.0, inland) * smoothstep(0.3, 2.6, h);

  // Flattened headland plaza for the lighthouse (applied last, so it is level).
  const lx = x - LIGHTHOUSE_SITE.x;
  const lz = z - LIGHTHOUSE_SITE.z;
  const lhDist = Math.sqrt(lx * lx + lz * lz);
  const plaza = 1 - smoothstep(4.4, 10.5, lhDist);
  h = THREE.MathUtils.lerp(h, LIGHTHOUSE_SITE.plateau, plaza);

  // Never allow a land vertex to sit underwater: keeps the shore/hill junction
  // watertight and avoids mysterious inland ponds.
  return Math.max(h, 0.06 + 0.08 * Math.min(1, Math.max(0, inland / 6)));
}

/** Central-difference gradient of heightAt. */
export function gradientAt(x, z, eps = 0.4) {
  const hx = (heightAt(x + eps, z) - heightAt(x - eps, z)) / (2 * eps);
  const hz = (heightAt(x, z + eps) - heightAt(x, z - eps)) / (2 * eps);
  return { x: hx, z: hz, slope: Math.sqrt(hx * hx + hz * hz) };
}

export function normalAt(x, z, eps = 0.4, target = new THREE.Vector3()) {
  const g = gradientAt(x, z, eps);
  return target.set(-g.x, 1, -g.z).normalize();
}

export function slopeAt(x, z, eps = 0.4) {
  const g = gradientAt(x, z, eps);
  return Math.min(1, g.slope / 2.0);
}

export function isLand(x, z) {
  return heightAt(x, z) > SEA_LEVEL + 0.02;
}

// ---------------------------------------------------------------------------
// Baked seabed depth map (sampled by the ocean vertex shader for shoaling)
// ---------------------------------------------------------------------------

export const SEABED_MAP_SIZE = 512;
export const SEABED_COVERAGE = TERRAIN_SIZE;

/**
 * R = water depth (0..1 mapped to 0..30m, zero on land)
 * G = land height (0..1 mapped to 0..20m)
 * B = signed shore proximity (128 = waterline)
 * The ocean shader uses R to damp wave amplitude in shallows.
 */
export function createSeabedTexture(size = SEABED_MAP_SIZE) {
  const data = new Uint8Array(size * size * 4);
  const half = SEABED_COVERAGE * 0.5;
  for (let j = 0; j < size; j++) {
    const z = (j / (size - 1)) * SEABED_COVERAGE - half;
    for (let i = 0; i < size; i++) {
      const x = (i / (size - 1)) * SEABED_COVERAGE - half;
      const h = heightAt(x, z);
      const depth = THREE.MathUtils.clamp(-h / 30, 0, 1);
      const land = THREE.MathUtils.clamp(h / 20, 0, 1);
      const shore = THREE.MathUtils.clamp(0.5 - h / 24, 0, 1);
      const k = (j * size + i) * 4;
      data[k] = Math.round(depth * 255);
      data[k + 1] = Math.round(land * 255);
      data[k + 2] = Math.round(shore * 255);
      data[k + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.name = 'SeabedDepthMap';
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** CPU-side depth at a world position — handy for spawning foam emitters. */
export function waterDepthAt(x, z) {
  return Math.max(0, SEA_LEVEL - heightAt(x, z));
}

/** UV in the baked seabed map for a world-space position. */
export function seabedUv(x, z) {
  return {
    u: (x + SEABED_COVERAGE * 0.5) / SEABED_COVERAGE,
    v: (z + SEABED_COVERAGE * 0.5) / SEABED_COVERAGE,
  };
}
