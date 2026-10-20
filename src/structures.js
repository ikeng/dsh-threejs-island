import * as THREE from 'three';
import { heightAt, gradientAt, noise2, LIGHTHOUSE_SITE } from './heightfield.js';
import { env as initialEnv } from './environment.js';

/**
 * Structures & props for the island.
 *
 * Everything in this module is procedural and seeded: the lighthouse tower is
 * painted into a CanvasTexture pair (paint + stone), the rocks are displaced
 * icosahedra with baked basalt vertex colours, the driftwood is lofted along
 * Catmull-Rom curves and the gulls are instanced low-poly bodies with two
 * independently flapping wing panels.
 *
 * `createStructures(scene)` returns `{ group, update, lighthouseLight }`.
 * `update(dt, env)` reads the shared environment published by environment.js;
 * it never owns time / weather state of its own.
 */

// ---------------------------------------------------------------------------
// Constants & deterministic helpers
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const SEED = 0x1a2b3c4d;

const LIGHTHOUSE_LOCAL = Object.freeze({
  plinthTop: 1.05,
  towerBottom: 1.05,
  towerHeight: 15.35,
  towerTop: 16.4,
  towerBottomRadius: 2.55,
  towerTopRadius: 1.62,
  railTop: 18.07,
  railRadius: 2.56,
  glassBottom: 17.36,
  glassTop: 19.5,
  glassRadius: 1.34,
  lampY: 18.85,
  domeBase: 19.65,
});

/** Mulberry32 — small, fast, deterministic PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randRange(rng, min, max) {
  return min + (max - min) * rng();
}

function smoothstep(x, min, max) {
  const t = THREE.MathUtils.clamp((x - min) / (max - min), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Ground height used by the whole lighthouse (slightly sunk so the plinth never floats). */
function lighthouseBaseY() {
  return heightAt(LIGHTHOUSE_SITE.x, LIGHTHOUSE_SITE.z) - 0.06;
}

/** World-space height of the lantern lamp — handy for cameras / audio later. */
function lampWorldPosition(target = new THREE.Vector3()) {
  return target.set(
    LIGHTHOUSE_SITE.x,
    lighthouseBaseY() + LIGHTHOUSE_LOCAL.lampY,
    LIGHTHOUSE_SITE.z,
  );
}

// ---------------------------------------------------------------------------
// Procedural canvas textures
// ---------------------------------------------------------------------------

/** 256x1024 canvas: white stucco, three bold red bands, grime + rust streaks. */
function createTowerTexture() {
  const W = 256;
  const H = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const rng = mulberry32(0x51a7c0de);

  const base = ctx.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0.0, '#e7e2d4');
  base.addColorStop(0.4, '#f0ebdf');
  base.addColorStop(0.78, '#e4ddce');
  base.addColorStop(1.0, '#cdc4b5');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);

  // Fine stucco grain — short vertical dabs, cheap and deterministic.
  for (let i = 0; i < 4200; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const v = 176 + Math.floor(rng() * 68);
    ctx.fillStyle = `rgba(${v},${v - 6},${v - 18},${0.04 + rng() * 0.11})`;
    ctx.fillRect(x, y, 1 + rng() * 2, 1 + rng() * 11);
  }

  // Broad trowel patches so the surface is not perfectly uniform.
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = `rgba(122,112,96,${0.02 + rng() * 0.04})`;
    ctx.fillRect(rng() * W, rng() * H, 8 + rng() * 38, 18 + rng() * 90);
  }

  // Three bold red bands. UV v = 0 at the bottom of the tower.
  const bands = [
    [0.275, 0.375],
    [0.5, 0.6],
    [0.72, 0.82],
  ];
  for (const [v0, v1] of bands) {
    const y0 = (1 - v1) * H;
    const y1 = (1 - v0) * H;
    const bh = y1 - y0;
    const grad = ctx.createLinearGradient(0, y0, 0, y1);
    grad.addColorStop(0.0, '#982a24');
    grad.addColorStop(0.18, '#b83a2e');
    grad.addColorStop(0.55, '#bd3d30');
    grad.addColorStop(0.86, '#a83028');
    grad.addColorStop(1.0, '#8c2722');
    ctx.fillStyle = grad;
    ctx.fillRect(0, y0, W, bh);

    // Sun-bleached patches and chipped paint.
    for (let i = 0; i < 240; i++) {
      ctx.fillStyle = `rgba(236,229,213,${0.035 + rng() * 0.14})`;
      ctx.fillRect(rng() * W, y0 + rng() * bh, 1 + rng() * 3, 1 + rng() * 7);
    }
    for (let i = 0; i < 70; i++) {
      const x = rng() * W;
      const len = 2 + rng() * 12;
      ctx.fillStyle = `rgba(233,226,212,${0.22 + rng() * 0.45})`;
      ctx.fillRect(x, y0 + rng() * 2.5, len, 1 + rng() * 2);
      ctx.fillRect(x, y1 - rng() * 3.5, len * 0.7, 1 + rng() * 2);
    }
    // Rust bleeding down out of each band.
    for (let i = 0; i < 30; i++) {
      const x = rng() * W;
      const len = 22 + rng() * 140;
      const g = ctx.createLinearGradient(0, y1, 0, y1 + len);
      g.addColorStop(0, 'rgba(104,55,30,0.34)');
      g.addColorStop(0.55, 'rgba(112,58,32,0.16)');
      g.addColorStop(1, 'rgba(112,58,32,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y1, 1 + rng() * 2.4, len);
    }
  }

  // Long vertical grime / salt streaks.
  for (let i = 0; i < 160; i++) {
    const x = rng() * W;
    const y = rng() * H * 0.6;
    const len = 40 + rng() * 320;
    const alpha = 0.025 + rng() * 0.085;
    const g = ctx.createLinearGradient(0, y, 0, y + len);
    g.addColorStop(0, `rgba(86,78,64,${alpha})`);
    g.addColorStop(1, 'rgba(86,78,64,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, 1 + rng() * 2.6, len);
  }

  // Damp base.
  const damp = ctx.createLinearGradient(0, H - 190, 0, H);
  damp.addColorStop(0, 'rgba(70,64,50,0)');
  damp.addColorStop(1, 'rgba(56,52,42,0.55)');
  ctx.fillStyle = damp;
  ctx.fillRect(0, H - 190, W, 190);

  // A few hairline cracks.
  ctx.strokeStyle = 'rgba(74,66,54,0.2)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 14; i++) {
    let x = rng() * W;
    let y = rng() * H;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 4; s++) {
      x += (rng() - 0.5) * 7;
      y += 7 + rng() * 20;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'LighthouseTowerPaint';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 8;
  return texture;
}

/** 256x256 weathered stone courses for the plinth and steps. */
function createStoneTexture() {
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  const rng = mulberry32(0x3f19b2a7);

  ctx.fillStyle = '#6f6a5f';
  ctx.fillRect(0, 0, S, S);

  const rows = 5;
  const cols = 6;
  const rowH = S / rows;
  const colW = S / cols;
  for (let r = 0; r < rows; r++) {
    const y = r * rowH;
    for (let c = 0; c < cols; c++) {
      const x = c * colW;
      const shade = 118 + Math.floor(rng() * 42);
      ctx.fillStyle = `rgb(${shade},${shade - 5},${shade - 17})`;
      ctx.fillRect(x + 1.5, y + 1.5, colW - 3, rowH - 3);
      // Highlight on the top/left of each block.
      ctx.fillStyle = `rgba(215,208,192,${0.08 + rng() * 0.08})`;
      ctx.fillRect(x + 2, y + 2, colW - 4, 1.5);
      ctx.fillRect(x + 2, y + 2, 1.5, rowH - 4);
      // Weathering blotches.
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = `rgba(58,54,46,${0.03 + rng() * 0.07})`;
        ctx.fillRect(x + 3 + rng() * (colW - 12), y + 3 + rng() * (rowH - 10), 2 + rng() * 9, 2 + rng() * 7);
      }
    }
    // Mortar course line.
    ctx.fillStyle = 'rgba(48,45,39,0.7)';
    ctx.fillRect(0, y, S, 2);
    for (let c = 0; c < cols; c++) {
      ctx.fillRect(c * colW, y, 2, rowH);
    }
  }

  // Damp base + lichen specks.
  const damp = ctx.createLinearGradient(0, S * 0.68, 0, S);
  damp.addColorStop(0, 'rgba(54,58,48,0)');
  damp.addColorStop(1, 'rgba(48,54,44,0.42)');
  ctx.fillStyle = damp;
  ctx.fillRect(0, S * 0.68, S, S * 0.32);
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = rng() > 0.6 ? 'rgba(120,134,96,0.11)' : 'rgba(206,198,180,0.1)';
    ctx.fillRect(rng() * S, rng() * S, 1 + rng() * 2.5, 1 + rng() * 2.5);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'LighthouseStone';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 1);
  texture.anisotropy = 8;
  return texture;
}

/** Soft radial glow used by the lamp sprites. */
function createGlowTexture() {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S / 2);
  g.addColorStop(0.0, 'rgba(255,253,241,1)');
  g.addColorStop(0.16, 'rgba(255,231,177,0.94)');
  g.addColorStop(0.42, 'rgba(255,191,108,0.42)');
  g.addColorStop(0.72, 'rgba(255,158,74,0.11)');
  g.addColorStop(1.0, 'rgba(255,150,70,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'LampGlow';
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Merge simple geometry parts (optionally transformed + tinted) into one
 * non-indexed BufferGeometry with position / normal / color attributes.
 * Per-vertex colour can be supplied by an existing color attribute, a
 * THREE.Color or a function returning a Color.
 */
function mergeParts(parts) {
  const prepared = [];
  let total = 0;

  for (const part of parts) {
    let geo = part.geometry;
    geo = geo.index ? geo.toNonIndexed() : geo.clone();
    if (part.matrix) geo.applyMatrix4(part.matrix);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const count = geo.attributes.position.count;
    prepared.push({ geo, count, color: part.color });
    total += count;
  }

  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  const scratch = new THREE.Color();
  let offset = 0;

  for (const { geo, count, color } of prepared) {
    const posAttr = geo.attributes.position;
    positions.set(posAttr.array, offset * 3);
    normals.set(geo.attributes.normal.array, offset * 3);

    if (color === undefined) {
      const existing = geo.attributes.color;
      if (existing) {
        colors.set(existing.array, offset * 3);
      } else {
        scratch.setRGB(1, 1, 1);
        for (let i = 0; i < count; i++) {
          const k = (offset + i) * 3;
          colors[k] = scratch.r;
          colors[k + 1] = scratch.g;
          colors[k + 2] = scratch.b;
        }
      }
    } else if (typeof color === 'function') {
      for (let i = 0; i < count; i++) {
        const out = color(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i), i, scratch);
        const c = out || scratch;
        const k = (offset + i) * 3;
        colors[k] = c.r;
        colors[k + 1] = c.g;
        colors[k + 2] = c.b;
      }
    } else {
      for (let i = 0; i < count; i++) {
        const k = (offset + i) * 3;
        colors[k] = color.r;
        colors[k + 1] = color.g;
        colors[k + 2] = color.b;
      }
    }

    offset += count;
    geo.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Build a tapered tube around a curve. Used for driftwood logs / branches.
 * Returns an indexed BufferGeometry with baked vertex colours.
 */
function buildLoftGeometry(curve, radiusAt, colorAt, sides, segments) {
  const positions = [];
  const colors = [];
  const indices = [];

  const up = new THREE.Vector3(0, 1, 0);
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const binormal = new THREE.Vector3();
  const point = new THREE.Vector3();
  const vertex = new THREE.Vector3();
  const color = new THREE.Color();

  for (let s = 0; s <= segments; s++) {
    const t = s / segments;
    curve.getPointAt(t, point);
    curve.getTangentAt(t, tangent);

    normal.crossVectors(up, tangent);
    if (normal.lengthSq() < 1e-5) normal.set(1, 0, 0);
    normal.normalize();
    binormal.crossVectors(tangent, normal).normalize();

    const radius = radiusAt(t);
    for (let j = 0; j < sides; j++) {
      const angle = (j / sides) * TAU + t * 0.9;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      vertex
        .copy(point)
        .addScaledVector(normal, cos * radius)
        .addScaledVector(binormal, sin * radius);
      positions.push(vertex.x, vertex.y, vertex.z);
      colorAt(t, angle, cos, sin, vertex, color);
      colors.push(color.r, color.g, color.b);
    }
  }

  for (let s = 0; s < segments; s++) {
    for (let j = 0; j < sides; j++) {
      const a = s * sides + j;
      const b = s * sides + ((j + 1) % sides);
      const c = (s + 1) * sides + j;
      const d = (s + 1) * sides + ((j + 1) % sides);
      indices.push(a, b, c, b, d, c);
    }
  }

  // End caps so the hollow tube never shows through.
  const ringCount = (segments + 1) * sides;
  const cutColor = new THREE.Color(0.64, 0.6, 0.51);
  const startCenter = ringCount;
  curve.getPointAt(0, point);
  positions.push(point.x, point.y, point.z);
  colors.push(cutColor.r, cutColor.g, cutColor.b);
  for (let j = 0; j < sides; j++) {
    indices.push(startCenter, ((j + 1) % sides), j);
  }

  curve.getPointAt(1, point);
  positions.push(point.x, point.y, point.z);
  colors.push(cutColor.r, cutColor.g, cutColor.b);
  const endCenter = startCenter + 1;
  const endRing = segments * sides;
  for (let j = 0; j < sides; j++) {
    indices.push(endCenter, endRing + j, endRing + ((j + 1) % sides));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

// ---------------------------------------------------------------------------
// Placement helpers — every ground position comes from heightAt()
// ---------------------------------------------------------------------------

/**
 * March radially outward from the island centre and find the first distance
 * where the terrain crosses `targetHeight`. Returns null when the ray never
 * reaches that height (e.g. a long cliff face).
 */
function findCoastCrossing(angle, targetHeight, startRadius = 8, endRadius = 96, step = 0.35) {
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  let prevR = startRadius;
  let prevH = heightAt(dx * startRadius, dz * startRadius);

  for (let r = startRadius + step; r <= endRadius; r += step) {
    const h = heightAt(dx * r, dz * r);
    if (prevH >= targetHeight && h < targetHeight) {
      const denom = prevH - h;
      const t = denom > 1e-5 ? (prevH - targetHeight) / denom : 0;
      const rr = prevR + (r - prevR) * t;
      return {
        angle,
        x: dx * rr,
        z: dz * rr,
        radius: rr,
        height: heightAt(dx * rr, dz * rr),
      };
    }
    prevR = r;
    prevH = h;
  }
  return null;
}

function isClear(x, z, avoid, padding) {
  for (let i = 0; i < avoid.length; i++) {
    const p = avoid[i];
    const dx = x - p.x;
    const dz = z - p.z;
    const d = (p.radius || 0) + padding;
    if (dx * dx + dz * dz < d * d) return false;
  }
  return true;
}

/** Seeded search for a low-slope, unoccupied point in a height band near the shore. */
function findBeachSpot(rng, minHeight, maxHeight, avoid, padding, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const angle = rng() * TAU;
    const target = randRange(rng, minHeight, maxHeight);
    const hit = findCoastCrossing(angle, target);
    if (!hit) continue;
    const x = hit.x;
    const z = hit.z;

    const plazaX = x - LIGHTHOUSE_SITE.x;
    const plazaZ = z - LIGHTHOUSE_SITE.z;
    if (plazaX * plazaX + plazaZ * plazaZ < 81) continue; // keep the lighthouse apron clear

    const g = gradientAt(x, z);
    if (g.slope > 0.6) continue;
    if (!isClear(x, z, avoid, padding)) continue;

    const h = heightAt(x, z);
    if (h < minHeight - 0.25 || h > maxHeight + 0.25) continue;
    return { x, z, height: h, angle };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shore boulders / sea stacks
// ---------------------------------------------------------------------------

const ROCK_WET_DARK = new THREE.Color(0x191e20);
const ROCK_WET_MID = new THREE.Color(0x272e30);
const ROCK_SPLASH = new THREE.Color(0x3b433d);
const ROCK_DRY_DARK = new THREE.Color(0x363a3b);
const ROCK_DRY_LIGHT = new THREE.Color(0x5b5b56);
const ROCK_TOP = new THREE.Color(0x77746a);

/**
 * Displaced, flattened icosahedron with baked basalt vertex colours.
 * The wet band is computed against the actual world waterline (baseY).
 */
function buildRockGeometry(rng, options) {
  const {
    width,
    height,
    depthRatio = 1,
    detail = 1,
    taper = 0.88,
    baseY = 0,
  } = options;

  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.attributes.position;
  const count = pos.count;
  const seed = rng() * 1000;
  const raw = new Float32Array(count * 3);

  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    let nx = pos.getX(i);
    let ny = pos.getY(i);
    let nz = pos.getZ(i);
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    const n1 = noise2(nx * 2.4 + seed, nz * 2.4 - seed);
    const n2 = noise2(ny * 4.1 - seed * 0.7, nx * 4.1 + seed * 0.3);
    const strata = Math.sin(ny * 8 + seed * 0.5) * 0.045;
    const wobble = 1 + (n1 - 0.5) * 0.46 + (n2 - 0.5) * 0.26 + strata;

    const x = nx * wobble;
    const y = ny * wobble;
    const z = nz * wobble;
    raw[i * 3] = x;
    raw[i * 3 + 1] = y;
    raw[i * 3 + 2] = z;

    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const floorCut = minY + (maxY - minY) * 0.18;
  const span = Math.max(1e-4, maxY - floorCut);
  const colors = new Float32Array(count * 3);
  const dry = new THREE.Color();
  const scratch = new THREE.Color();
  const waterLocal = -baseY;

  for (let i = 0; i < count; i++) {
    const y = Math.max(raw[i * 3 + 1], floorCut);
    const tNorm = (y - floorCut) / span;
    const taperFactor = 1 - (1 - taper) * Math.pow(tNorm, 1.4);
    const x = raw[i * 3] * width * taperFactor;
    const z = raw[i * 3 + 2] * width * depthRatio * taperFactor;
    const yFinal = tNorm * height;
    pos.setXYZ(i, x, yFinal, z);

    const n = noise2(x * 3.2 + seed, z * 3.2 - seed) * 0.6 +
      noise2(yFinal * 2.2 + seed, x * 2.2) * 0.4;
    dry.copy(ROCK_DRY_DARK).lerp(ROCK_DRY_LIGHT, n * 0.95);

    const wetT = THREE.MathUtils.clamp((waterLocal + 0.5 - yFinal) / 0.9, 0, 1);
    const splash = (1 - Math.abs(yFinal - (waterLocal + 0.28)) / 0.6) * 0.5;
    scratch.copy(dry).lerp(ROCK_WET_MID, wetT * 0.75).lerp(ROCK_WET_DARK, wetT * wetT * 0.55);
    if (splash > 0) scratch.lerp(ROCK_SPLASH, Math.min(0.5, splash) * 0.55);
    scratch.lerp(ROCK_TOP, smoothstep(yFinal, height * 0.7, height) * 0.22);
    const strata = 0.94 + 0.12 * noise2(yFinal * 4.5 + seed, 1.7);
    scratch.multiplyScalar(strata);

    colors[i * 3] = scratch.r;
    colors[i * 3 + 1] = scratch.g;
    colors[i * 3 + 2] = scratch.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function createRocks(rng) {
  const group = new THREE.Group();
  group.name = 'ShoreRocks';

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.04,
    flatShading: true,
  });
  material.name = 'BasaltRock';

  const placed = [];
  const rocks = [];

  // Composed clusters rather than a uniform ring: each cluster sits on a
  // different stretch of coast, and the bay cluster stays deliberately small so
  // it never blocks the beach view.
  const clusters = [
    { angle: 0.42, count: 3, size: [0.55, 1.15], emerge: [0.8, 1.7], depth: [0.35, 1.6] },
    { angle: 1.25, count: 2, size: [0.8, 1.5], emerge: [1.0, 2.1], depth: [0.5, 1.9] },
    { angle: 1.95, count: 2, size: [0.75, 1.5], emerge: [0.9, 2.0], depth: [0.5, 1.8] },
    { angle: -0.4, count: 2, size: [0.7, 1.35], emerge: [0.8, 1.9], depth: [0.4, 1.7] },
    { angle: -1.15, count: 2, size: [0.85, 1.7], emerge: [1.1, 2.3], depth: [0.6, 2.0] },
    { angle: -1.9, count: 2, size: [0.9, 1.9], emerge: [1.2, 2.6], depth: [0.7, 2.2] },
    { angle: -2.7, count: 2, size: [0.85, 1.8], emerge: [1.1, 2.4], depth: [0.6, 2.0] },
    { angle: 3.6, count: 2, size: [0.9, 1.9], emerge: [1.2, 2.7], depth: [0.8, 2.3] },
    { angle: 4.5, count: 2, size: [0.85, 1.8], emerge: [1.1, 2.4], depth: [0.6, 2.0] },
    { angle: 5.3, count: 2, size: [0.8, 1.6], emerge: [1.0, 2.2], depth: [0.5, 1.9] },
  ];

  for (const cluster of clusters) {
    for (let k = 0; k < cluster.count; k++) {
      let width = randRange(rng, cluster.size[0], cluster.size[1]);
      const depth = randRange(rng, cluster.depth[0], cluster.depth[1]);
      const emerge = randRange(rng, cluster.emerge[0], cluster.emerge[1]);
      let attempt = 0;
      let x = 0;
      let z = 0;
      let groundY = 0;
      let ok = false;

      while (attempt < 10 && !ok) {
        attempt++;
        const angle = cluster.angle + randRange(rng, -0.065, 0.065);
        const hit = findCoastCrossing(angle, -depth);
        if (!hit) continue;
        x = hit.x;
        z = hit.z;
        groundY = heightAt(x, z);
        if (Math.hypot(x - LIGHTHOUSE_SITE.x, z - LIGHTHOUSE_SITE.z) < 9) continue;
        if (!isClear(x, z, placed, 0.9)) {
          width *= 0.85;
          if (width < 0.4) break;
          continue;
        }
        ok = true;
      }
      if (!ok) continue;

      const detail = width > 1.35 ? 2 : 1;
      const height = depth + emerge + 0.12;
      const geometry = buildRockGeometry(rng, {
        width,
        height,
        depthRatio: randRange(rng, 0.8, 1.25),
        detail,
        taper: randRange(rng, 0.78, 0.98),
        baseY: groundY - 0.12,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `ShoreRock_${rocks.length}`;
      mesh.position.set(x, groundY - 0.12, z);
      mesh.rotation.y = rng() * TAU;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);

      placed.push({ x, z, radius: width * 1.15 });
      rocks.push(mesh);
    }
  }

  // 2-3 larger sea stacks further offshore.
  const stackAngles = [3.48, 4.95, 5.75];
  for (const angle of stackAngles) {
    const depth = randRange(rng, 3.8, 5.8);
    let hit = findCoastCrossing(angle, -depth);
    if (!hit) continue;
    // Push a little further out so they read as separate sea stacks.
    const outX = Math.cos(angle);
    const outZ = Math.sin(angle);
    let x = hit.x + outX * randRange(rng, 2, 5);
    let z = hit.z + outZ * randRange(rng, 2, 5);
    let groundY = heightAt(x, z);
    if (!isClear(x, z, placed, 2.5)) continue;

    const width = randRange(rng, 2.0, 3.3);
    const emerge = randRange(rng, 3.6, 6.2);
    const height = -groundY + emerge + 0.2;
    const geometry = buildRockGeometry(rng, {
      width,
      height,
      depthRatio: randRange(rng, 0.75, 1.05),
      detail: 2,
      taper: randRange(rng, 0.5, 0.72),
      baseY: groundY - 0.2,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `SeaStack_${rocks.length}`;
    mesh.position.set(x, groundY - 0.2, z);
    mesh.rotation.y = rng() * TAU;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    placed.push({ x, z, radius: width * 1.2 });
    rocks.push(mesh);
  }

  // A few foundation rocks tie the lighthouse plinth into the headland.
  const doorAngle = Math.atan2(-LIGHTHOUSE_SITE.x, -LIGHTHOUSE_SITE.z);
  const foundationAngles = [doorAngle + 1.25, doorAngle + 2.5, doorAngle + 3.7, doorAngle + 5.1];
  for (let i = 0; i < foundationAngles.length; i++) {
    const a = foundationAngles[i];
    const r = randRange(rng, 5.6, 7.4);
    const x = LIGHTHOUSE_SITE.x + Math.sin(a) * r;
    const z = LIGHTHOUSE_SITE.z + Math.cos(a) * r;
    const groundY = heightAt(x, z);
    const height = randRange(rng, 0.55, 1.25);
    const width = randRange(rng, 0.5, 1.05);
    const geometry = buildRockGeometry(rng, {
      width,
      height,
      depthRatio: randRange(rng, 0.85, 1.2),
      detail: 1,
      taper: randRange(rng, 0.8, 1.0),
      baseY: groundY - 0.08,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `FoundationRock_${i}`;
    mesh.position.set(x, groundY - 0.08, z);
    mesh.rotation.y = rng() * TAU;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  return { group, placed, rocks };
}

// ---------------------------------------------------------------------------
// Driftwood
// ---------------------------------------------------------------------------

const WOOD_LIGHT = new THREE.Color(0xb3a68f);
const WOOD_DARK = new THREE.Color(0x5f5546);
const WOOD_CUT = new THREE.Color(0xc9bda5);

function createDriftwood(rng, avoid) {
  const group = new THREE.Group();
  group.name = 'Driftwood';

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0.0,
  });
  material.name = 'Driftwood';

  const placed = [];

  for (let i = 0; i < 6; i++) {
    const spot = findBeachSpot(rng, 0.2, 0.72, avoid, 1.7, 90);
    if (!spot) continue;

    const length = randRange(rng, 2.5, 4.6);
    const radius = randRange(rng, 0.09, 0.18);
    const parts = [];
    const seed = rng() * 100;

    // Main log: gently twisted Catmull-Rom curve.
    const ctrl = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(randRange(rng, -0.22, 0.22), randRange(rng, -0.1, 0.1), length * 0.28),
      new THREE.Vector3(randRange(rng, -0.34, 0.34), randRange(rng, -0.16, 0.16), length * 0.58),
      new THREE.Vector3(randRange(rng, -0.3, 0.3), randRange(rng, -0.2, 0.2), length * 0.82),
      new THREE.Vector3(randRange(rng, -0.4, 0.4), randRange(rng, -0.26, 0.26), length),
    ];
    const mainCurve = new THREE.CatmullRomCurve3(ctrl, false, 'catmullrom', 0.5);

    const mainColor = (t, angle, cos, sin, v, out) => {
      const grain = noise2(t * 26 + seed, angle * 1.7 + seed * 0.7);
      const crack = noise2(t * 44 + seed * 2, angle * 3.1);
      out.copy(WOOD_LIGHT).lerp(WOOD_DARK, grain * 0.72 + (crack > 0.74 ? 0.55 : 0));
      if (t < 0.05 || t > 0.95) out.lerp(WOOD_CUT, 0.5);
      out.multiplyScalar(0.94 + 0.14 * noise2(t * 9, angle * 2.2));
    };
    parts.push({
      geometry: buildLoftGeometry(
        mainCurve,
        (t) => radius * (1 - 0.42 * t) * (1 + 0.16 * Math.sin(t * 11 + seed) + 0.1 * noise2(t * 7 + seed, seed * 2)),
        mainColor,
        8,
        14,
      ),
    });

    // Root / branch stubs.
    const branchCount = rng() < 0.35 ? 2 : 1;
    for (let b = 0; b < branchCount; b++) {
      const root = b === 0 && rng() < 0.6;
      const t0 = root ? randRange(rng, 0.02, 0.14) : randRange(rng, 0.25, 0.85);
      const attach = mainCurve.getPointAt(t0);
      const dir = new THREE.Vector3(
        randRange(rng, -1, 1),
        randRange(rng, -0.25, 0.9),
        randRange(rng, -0.9, 0.9),
      ).normalize();
      const branchLength = randRange(rng, 0.5, root ? 1.35 : 1.05);
      const bend = new THREE.Vector3(
        randRange(rng, -0.25, 0.25),
        randRange(rng, 0.05, 0.35),
        randRange(rng, -0.25, 0.25),
      );
      const bpts = [
        attach.clone().addScaledVector(dir, -0.12),
        attach.clone().addScaledVector(dir, branchLength * 0.5).add(bend),
        attach.clone().addScaledVector(dir, branchLength).addScaledVector(bend, 1.8),
      ];
      const branchCurve = new THREE.CatmullRomCurve3(bpts, false, 'catmullrom', 0.5);
      const baseRadius = radius * randRange(rng, 0.35, 0.55);
      const branchColor = (t, angle, cos, sin, v, out) => {
        const grain = noise2(t * 18 + seed + b * 5, angle * 2 + seed);
        out.copy(WOOD_LIGHT).lerp(WOOD_DARK, 0.35 + grain * 0.5);
        if (t > 0.94) out.lerp(WOOD_CUT, 0.45);
      };
      parts.push({
        geometry: buildLoftGeometry(
          branchCurve,
          (t) => baseRadius * (1 - 0.8 * t) + 0.012,
          branchColor,
          6,
          root ? 7 : 5,
        ),
      });
    }

    const geometry = mergeParts(parts);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `Driftwood_${placed.length}`;

    const yaw = rng() * TAU;
    const slope = gradientAt(spot.x, spot.z);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const alongSlope = slope.x * fx + slope.z * fz;
    const acrossSlope = slope.x * rx + slope.z * rz;
    mesh.rotation.set(
      -Math.atan(alongSlope) * 0.55,
      yaw,
      Math.atan(acrossSlope) * 0.55,
      'YXZ',
    );
    mesh.position.set(spot.x, heightAt(spot.x, spot.z) - radius * 0.3, spot.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    placed.push({ x: spot.x, z: spot.z, radius: Math.max(length * 0.42, 1.3) });
  }

  return { group, placed };
}

// ---------------------------------------------------------------------------
// Coconuts
// ---------------------------------------------------------------------------

const COCONUT_DARK = new THREE.Color(0x3d2a19);
const COCONUT_MID = new THREE.Color(0x6b4a2b);
const COCONUT_LIGHT = new THREE.Color(0x9a7448);
const COCONUT_TAN = new THREE.Color(0xb28f5f);
const COCONUT_PORE = new THREE.Color(0x1a110a);

function buildCoconutGeometry() {
  const geometry = new THREE.SphereGeometry(1, 14, 10);
  const pos = geometry.attributes.position;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const color = new THREE.Color();
  const scratch = new THREE.Color();
  const dir = new THREE.Vector3();
  const pore = new THREE.Vector3();

  const pores = [];
  for (let i = 0; i < 3; i++) {
    const a = (i * TAU) / 3 + 0.35;
    pores.push(
      new THREE.Vector3(
        Math.sin(a) * Math.sin(0.62),
        Math.cos(0.62),
        Math.cos(a) * Math.sin(0.62),
      ).normalize(),
    );
  }

  for (let i = 0; i < count; i++) {
    dir.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();

    let dimple = 0;
    for (const p of pores) {
      const dot = THREE.MathUtils.clamp(dir.dot(p), -1, 1);
      const angle = Math.acos(dot);
      if (angle < 0.3) dimple = Math.max(dimple, 1 - angle / 0.3);
    }
    const rr = 1 - dimple * 0.1;
    pos.setXYZ(i, dir.x * rr, dir.y * rr, dir.z * rr);

    const n = noise2(dir.x * 7 + 2.1, dir.z * 7 - 1.7) * 0.6 +
      noise2(dir.y * 11, dir.x * 11) * 0.4;
    color.copy(COCONUT_DARK).lerp(COCONUT_LIGHT, n);

    // Fibrous streaks running towards the poles.
    const fiber = noise2(dir.x * 22 + dir.y * 3.5, dir.z * 22 - dir.y * 5);
    color.multiplyScalar(0.9 + fiber * 0.2);
    color.lerp(COCONUT_TAN, THREE.MathUtils.clamp(dir.y, 0, 1) * 0.28);
    color.lerp(COCONUT_MID, THREE.MathUtils.clamp(-dir.y, 0, 1) * 0.18);
    if (dimple > 0) scratch.copy(color).lerp(COCONUT_PORE, Math.min(1, dimple * 1.7));
    else scratch.copy(color);

    colors[i * 3] = scratch.r;
    colors[i * 3 + 1] = scratch.g;
    colors[i * 3 + 2] = scratch.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function createCoconuts(rng, avoid) {
  const group = new THREE.Group();
  group.name = 'Coconuts';

  const geometry = buildCoconutGeometry();
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.0,
  });
  material.name = 'Coconut';

  const clusterSizes = [4, 4, 3, 3];
  const spots = [];

  for (let c = 0; c < clusterSizes.length; c++) {
    const anchor = findBeachSpot(rng, 0.95, 1.95, avoid, 1.3, 100);
    if (!anchor) continue;

    const inlandLength = Math.hypot(anchor.x, anchor.z) || 1;
    const inX = -anchor.x / inlandLength;
    const inZ = -anchor.z / inlandLength;
    const baseX = anchor.x + inX * randRange(rng, 1.2, 3.0);
    const baseZ = anchor.z + inZ * randRange(rng, 1.2, 3.0);

    for (let k = 0; k < clusterSizes[c]; k++) {
      const a = rng() * TAU;
      const spread = Math.sqrt(rng()) * 1.5;
      let x = baseX + Math.cos(a) * spread;
      let z = baseZ + Math.sin(a) * spread;
      let h = heightAt(x, z);
      if (h < 0.45 || h > 3.4) {
        x = baseX;
        z = baseZ;
        h = heightAt(x, z);
      }
      if (h < 0.25) continue;
      spots.push({
        x,
        z,
        h,
        scale: randRange(rng, 0.19, 0.27),
        yaw: rng() * TAU,
        tiltX: randRange(rng, -0.45, 0.45),
        tiltZ: randRange(rng, -0.45, 0.45),
      });
    }
  }

  if (spots.length === 0) return { group };

  const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
  mesh.name = 'CoconutClusters';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    dummy.position.set(s.x, s.h + s.scale * randRange(rng, 0.02, 0.18), s.z);
    dummy.rotation.set(s.tiltX, s.yaw, s.tiltZ, 'YXZ');
    dummy.scale.setScalar(s.scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    tint.setRGB(randRange(rng, 0.82, 1.05), randRange(rng, 0.8, 1.0), randRange(rng, 0.78, 0.98));
    mesh.setColorAt(i, tint);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);

  return { group, count: spots.length };
}

// ---------------------------------------------------------------------------
// Seagulls
// ---------------------------------------------------------------------------

const GULL_BELLY = new THREE.Color(0xf4f2e9);
const GULL_BACK = new THREE.Color(0xc7cdd2);
const GULL_WING_WHITE = new THREE.Color(0xf2f0e7);
const GULL_WING_GREY = new THREE.Color(0xb4bbc0);
const GULL_WING_DARK = new THREE.Color(0x6a737a);
const GULL_WING_BLACK = new THREE.Color(0x1a1e22);
const GULL_BEAK = new THREE.Color(0xd69a2c);
const GULL_EYE = new THREE.Color(0x121518);

function buildGullBodyGeometry() {
  const parts = [];

  const torso = new THREE.SphereGeometry(1, 10, 7);
  torso.scale(0.155, 0.14, 0.36);
  parts.push({
    geometry: torso,
    color: (x, y, z, i, out) => {
      // White belly, pale grey back.
      return out.copy(GULL_BELLY).lerp(GULL_BACK, smoothstep(y, -0.08, 0.13) * 0.9);
    },
  });

  const neck = new THREE.SphereGeometry(1, 8, 6);
  neck.scale(0.1, 0.105, 0.13).translate(0, 0.035, 0.22);
  parts.push({ geometry: neck, color: GULL_BELLY });

  const head = new THREE.SphereGeometry(1, 8, 6);
  head.scale(0.093, 0.095, 0.105).translate(0, 0.075, 0.31);
  parts.push({ geometry: head, color: GULL_BELLY });

  const beak = new THREE.ConeGeometry(0.028, 0.13, 5);
  beak.rotateX(Math.PI / 2).translate(0, 0.058, 0.415);
  parts.push({
    geometry: beak,
    color: (x, y, z, i, out) => out.copy(GULL_BEAK).multiplyScalar(z > 0.46 ? 0.8 : 1),
  });

  const tail = new THREE.ConeGeometry(0.09, 0.24, 4);
  tail.rotateX(-Math.PI / 2).scale(1.55, 0.26, 1.0).translate(0, 0.005, -0.37);
  parts.push({
    geometry: tail,
    color: (x, y, z, i, out) => out.copy(GULL_BACK).lerp(GULL_WING_GREY, z < -0.42 ? 0.65 : 0.2),
  });

  for (const side of [-1, 1]) {
    const eye = new THREE.SphereGeometry(0.018, 6, 4);
    eye.translate(side * 0.072, 0.088, 0.36);
    parts.push({ geometry: eye, color: GULL_EYE });
  }

  return mergeParts(parts);
}

/** Flat, cambered gull wing with white → grey → black spanwise bands. */
function buildWingGeometry(side) {
  const stations = [
    { x: 0.0, lead: 0.15, trail: -0.13, y: 0.015 },
    { x: 0.22, lead: 0.205, trail: -0.22, y: 0.05 },
    { x: 0.48, lead: 0.17, trail: -0.24, y: 0.075 },
    { x: 0.74, lead: 0.105, trail: -0.19, y: 0.055 },
    { x: 0.99, lead: 0.04, trail: -0.085, y: 0.01 },
  ];
  const span = stations[stations.length - 1].x;
  const positions = [];
  const colors = [];
  const indices = [];

  for (let s = 0; s < stations.length; s++) {
    const st = stations[s];
    const f = st.x / span;
    let base;
    if (f < 0.55) base = GULL_WING_WHITE.clone().lerp(GULL_WING_GREY, smoothstep(f, 0.1, 0.55) * 0.55);
    else if (f < 0.8) base = GULL_WING_GREY.clone().lerp(GULL_WING_DARK, (f - 0.55) / 0.25);
    else base = GULL_WING_DARK.clone().lerp(GULL_WING_BLACK, THREE.MathUtils.clamp((f - 0.8) / 0.19, 0, 1));

    const rows = [
      { z: st.lead, lift: 0.0, shade: 1.04 },
      { z: (st.lead + st.trail) * 0.5, lift: 0.022, shade: 0.98 },
      { z: st.trail, lift: -0.006, shade: 0.86 },
    ];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      positions.push(side * st.x, st.y + row.lift, row.z);
      const c = base.clone().multiplyScalar(row.shade);
      colors.push(c.r, c.g, c.b);
    }
  }

  const rows = 3;
  for (let s = 0; s < stations.length - 1; s++) {
    for (let r = 0; r < rows - 1; r++) {
      const a = s * rows + r;
      const b = a + 1;
      const c = (s + 1) * rows + r;
      const d = c + 1;
      if (side > 0) indices.push(a, c, b, b, c, d);
      else indices.push(a, b, c, b, d, c);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function createGulls() {
  const group = new THREE.Group();
  group.name = 'Seagulls';

  const bodyGeometry = buildGullBodyGeometry();
  const rightWingGeometry = buildWingGeometry(1);
  const leftWingGeometry = buildWingGeometry(-1);

  const bodyMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.0,
    flatShading: true,
  });
  bodyMaterial.name = 'GullBody';

  const wingMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0.0,
    side: THREE.DoubleSide,
    shadowSide: THREE.DoubleSide,
    flatShading: true,
  });
  wingMaterial.name = 'GullWings';

  const FLYING = 11;
  const PERCHED = 2;
  const TOTAL = FLYING + PERCHED;
  const rng = mulberry32(0x6c11b1d5);

  const bodies = new THREE.InstancedMesh(bodyGeometry, bodyMaterial, TOTAL);
  const rightWings = new THREE.InstancedMesh(rightWingGeometry, wingMaterial, TOTAL);
  const leftWings = new THREE.InstancedMesh(leftWingGeometry, wingMaterial, TOTAL);
  bodies.name = 'GullBodies';
  rightWings.name = 'GullRightWings';
  leftWings.name = 'GullLeftWings';

  for (const mesh of [bodies, rightWings, leftWings]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  }
  bodies.castShadow = true;
  bodies.receiveShadow = true;

  // Flying gulls circle the island and the lighthouse at 12-35 m.
  const birds = [];
  for (let i = 0; i < FLYING; i++) {
    const aroundLighthouse = i < 4;
    const scale = randRange(rng, 0.95, 1.15);
    birds.push({
      perched: false,
      cx: aroundLighthouse
        ? LIGHTHOUSE_SITE.x + randRange(rng, -2.5, 2.5)
        : randRange(rng, -7, 7),
      cz: aroundLighthouse
        ? LIGHTHOUSE_SITE.z + randRange(rng, -2.5, 2.5)
        : randRange(rng, -7, 7),
      radius: aroundLighthouse ? randRange(rng, 9, 19) : randRange(rng, 30, 47),
      baseY: aroundLighthouse ? randRange(rng, 19.5, 33) : randRange(rng, 14, 29),
      theta: rng() * TAU,
      dir: rng() < 0.5 ? -1 : 1,
      speed: randRange(rng, 0.09, 0.2),
      bobAmp: aroundLighthouse ? randRange(rng, 0.5, 1.4) : randRange(rng, 0.5, 1.2),
      bobPhase: rng() * TAU,
      flapPhase: rng() * TAU,
      flapSpeed: randRange(rng, 7.2, 10.4),
      flapAmp: 0.2,
      flapping: rng() < 0.55,
      stateTime: rng() * 1.5,
      stateDuration: randRange(rng, 1.4, 3.2),
      scale,
      scaleVec: new THREE.Vector3(scale, scale, scale),
    });
  }

  // Two gulls perched on the gallery railing, facing outwards.
  const baseY = lighthouseBaseY();
  const perchBaseAngle = Math.atan2(-LIGHTHOUSE_SITE.x, -LIGHTHOUSE_SITE.z);
  for (let i = 0; i < PERCHED; i++) {
    const angle = perchBaseAngle + (i === 0 ? 2.3 : 4.7);
    const scale = randRange(rng, 0.95, 1.05);
    birds.push({
      perched: true,
      perchX: LIGHTHOUSE_SITE.x + Math.sin(angle) * LIGHTHOUSE_LOCAL.railRadius,
      perchY: baseY + LIGHTHOUSE_LOCAL.railTop + 0.14,
      perchZ: LIGHTHOUSE_SITE.z + Math.cos(angle) * LIGHTHOUSE_LOCAL.railRadius,
      perchYaw: angle,
      theta: 0,
      dir: 1,
      speed: 0,
      bobAmp: 0,
      bobPhase: 0,
      flapPhase: rng() * TAU,
      flapSpeed: 8,
      flapAmp: 0,
      flapping: false,
      stateTime: 0,
      stateDuration: 1,
      scale,
      scaleVec: new THREE.Vector3(scale, scale, scale),
    });
  }

  // Pre-allocated scratch objects so update() never allocates.
  const AXIS_X = new THREE.Vector3(1, 0, 0);
  const AXIS_Y = new THREE.Vector3(0, 1, 0);
  const AXIS_Z = new THREE.Vector3(0, 0, 1);
  const ONE = new THREE.Vector3(1, 1, 1);
  const qYaw = new THREE.Quaternion();
  const qPitch = new THREE.Quaternion();
  const qRoll = new THREE.Quaternion();
  const qSweep = new THREE.Quaternion();
  const qFlap = new THREE.Quaternion();
  const qBody = new THREE.Quaternion();
  const qWing = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const wingLocal = new THREE.Matrix4();
  const wingWorld = new THREE.Matrix4();
  const bodyMatrix = new THREE.Matrix4();

  function applyPerched(index, bird) {
    pos.set(bird.perchX, bird.perchY, bird.perchZ);
    qYaw.setFromAxisAngle(AXIS_Y, bird.perchYaw);
    qPitch.setFromAxisAngle(AXIS_X, -0.05);
    qBody.copy(qYaw).multiply(qPitch);
    bodyMatrix.compose(pos, qBody, bird.scaleVec);
    bodies.setMatrixAt(index, bodyMatrix);

    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? 1 : -1;
      qSweep.setFromAxisAngle(AXIS_Y, side * 1.08);
      qFlap.setFromAxisAngle(AXIS_Z, side * 0.72);
      qWing.copy(qSweep).multiply(qFlap);
      pos.set(side * 0.075, 0.045, 0.03);
      wingLocal.compose(pos, qWing, ONE);
      wingWorld.multiplyMatrices(bodyMatrix, wingLocal);
      (side > 0 ? rightWings : leftWings).setMatrixAt(index, wingWorld);
    }
  }

  const update = (dt, env) => {
    const step = THREE.MathUtils.clamp(dt || 0, 0, 0.05);

    const wind = env.windStrength || 0;
    const windX = env.windDir ? env.windDir.x * wind * 1.8 : 0;
    const windZ = env.windDir ? env.windDir.y * wind * 1.8 : 0;
    const storm = env.stormMix || 0;

    for (let i = 0; i < TOTAL; i++) {
      const bird = birds[i];

      if (bird.perched) {
        applyPerched(i, bird);
        continue;
      }

      bird.theta += bird.dir * bird.speed * step * (1 + wind * 0.18);
      const theta = bird.theta;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);

      const lift = Math.sin(theta * 2 + bird.bobPhase) * bird.bobAmp +
        Math.sin(theta * 5 + bird.bobPhase * 1.7) * 0.22;
      const px = bird.cx + cos * bird.radius + windX;
      const pz = bird.cz + sin * bird.radius + windZ;
      const py = bird.baseY + lift;

      // Alternate flapping and gliding.
      bird.stateTime += step;
      if (bird.stateTime >= bird.stateDuration) {
        bird.stateTime = 0;
        bird.flapping = !bird.flapping;
        bird.stateDuration = bird.flapping
          ? 1.1 + (i % 5) * 0.28
          : 1.4 + ((i + 2) % 4) * 0.45;
      }
      const targetAmp = bird.flapping ? 0.52 + storm * 0.16 : 0.05;
      bird.flapAmp += (targetAmp - bird.flapAmp) * Math.min(1, step * 6);
      bird.flapPhase += bird.flapping
        ? step * bird.flapSpeed * (1 + wind * 0.45)
        : step * 1.3;

      const flap = 0.16 + bird.flapAmp * Math.sin(bird.flapPhase) + 0.03 * Math.sin(theta + bird.bobPhase);
      const sweep = 0.05 + (bird.flapping ? 0 : 0.035) + 0.02 * Math.sin(bird.flapPhase * 0.7);

      // Heading follows the orbit tangent; bank into the turn.
      const vx = -sin * bird.dir;
      const vz = cos * bird.dir;
      const yaw = Math.atan2(vx, vz);
      const climb = (Math.cos(theta * 2 + bird.bobPhase) * 2 * bird.bobAmp +
        Math.cos(theta * 5 + bird.bobPhase * 1.7) * 1.1) * bird.dir * bird.speed;
      const pitch = THREE.MathUtils.clamp(-climb * 0.045, -0.2, 0.2);
      const bank = bird.dir * (0.26 + 0.07 * Math.sin(theta * 0.7 + bird.bobPhase));

      qYaw.setFromAxisAngle(AXIS_Y, yaw);
      qPitch.setFromAxisAngle(AXIS_X, pitch);
      qRoll.setFromAxisAngle(AXIS_Z, bank);
      qBody.copy(qYaw).multiply(qPitch).multiply(qRoll);

      pos.set(px, py, pz);
      bodyMatrix.compose(pos, qBody, bird.scaleVec);
      bodies.setMatrixAt(i, bodyMatrix);

      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? 1 : -1;
        qSweep.setFromAxisAngle(AXIS_Y, side * sweep);
        qFlap.setFromAxisAngle(AXIS_Z, side * flap);
        qWing.copy(qSweep).multiply(qFlap);
        pos.set(side * 0.075, 0.045, 0.03);
        wingLocal.compose(pos, qWing, ONE);
        wingWorld.multiplyMatrices(bodyMatrix, wingLocal);
        (side > 0 ? rightWings : leftWings).setMatrixAt(i, wingWorld);
      }
    }

    bodies.instanceMatrix.needsUpdate = true;
    rightWings.instanceMatrix.needsUpdate = true;
    leftWings.instanceMatrix.needsUpdate = true;
  };

  return { group, update };
}

// ---------------------------------------------------------------------------
// Lighthouse
// ---------------------------------------------------------------------------

const BEAM_VERTEX_SHADER = /* glsl */ `
  uniform float uLength;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec2 vUv;
  varying float vAxial;

  void main() {
    vUv = uv;
    vAxial = clamp(position.z / uLength, 0.0, 1.0);
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const BEAM_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uTime;
  uniform float uFogDensity;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec2 vUv;
  varying float vAxial;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    // The shell is brightest through the middle of the silhouette, which reads
    // as light integrated through the cone volume.
    float facing = abs(dot(normal, viewDir));
    float body = pow(facing, 1.7);

    // Soft axial falloff: dark at the lantern, brightest immediately outside,
    // long fading tail.
    float axial = smoothstep(0.0, 0.05, vAxial) * pow(1.0 - vAxial, 1.35);

    // Drifting mist streaks inside the beam.
    float angle = vUv.x * 6.2831853;
    float streak = valueNoise(vec2(vAxial * 9.0 - uTime * 0.55, angle * 2.1 + uTime * 0.12));
    streak = mix(0.62, 1.0, streak);

    // Gentle quadratic distance falloff: still bright from the default
    // 60-100 unit viewing range, but never a harsh infinite cone.
    float dist = distance(cameraPosition, vWorldPos);
    float distFade = 1.0 / (1.0 + dist * dist * 0.000025);
    float fog = exp(-uFogDensity * dist * 1.15);
    float nearFade = smoothstep(0.25, 2.2, dist);

    float intensity = uIntensity * body * axial * streak * distFade * fog * nearFade;
    // Linear HDR additive light: the composer tone-maps once at the end.
    gl_FragColor = vec4(uColor * intensity, 1.0);
  }
`;

function createLighthouse() {
  const group = new THREE.Group();
  group.name = 'Lighthouse';
  const baseX = LIGHTHOUSE_SITE.x;
  const baseZ = LIGHTHOUSE_SITE.z;
  const baseY = lighthouseBaseY();
  group.position.set(baseX, baseY, baseZ);

  const LH = LIGHTHOUSE_LOCAL;
  const towerTexture = createTowerTexture();
  const stoneTexture = createStoneTexture();
  const glowTexture = createGlowTexture();

  const towerRadiusAt = (y) => {
    const t = THREE.MathUtils.clamp(
      (y - LH.towerBottom) / LH.towerHeight,
      0,
      1,
    );
    return LH.towerBottomRadius + (LH.towerTopRadius - LH.towerBottomRadius) * t;
  };

  // --- materials ---------------------------------------------------------
  const towerMaterial = new THREE.MeshStandardMaterial({
    map: towerTexture,
    roughness: 0.86,
    metalness: 0.0,
  });
  towerMaterial.name = 'LighthousePaint';

  const stoneMaterial = new THREE.MeshStandardMaterial({
    map: stoneTexture,
    roughness: 0.96,
    metalness: 0.0,
  });
  stoneMaterial.name = 'LighthouseStone';

  const whiteMaterial = new THREE.MeshStandardMaterial({
    color: 0xe2ddd0,
    roughness: 0.72,
    metalness: 0.0,
  });
  whiteMaterial.name = 'LighthouseTrim';

  const ironMaterial = new THREE.MeshStandardMaterial({
    color: 0x23292b,
    roughness: 0.5,
    metalness: 0.62,
  });
  ironMaterial.name = 'LighthouseIron';

  const roofMaterial = new THREE.MeshStandardMaterial({
    color: 0x394348,
    roughness: 0.4,
    metalness: 0.55,
  });
  roofMaterial.name = 'LighthouseRoof';

  const woodMaterial = new THREE.MeshStandardMaterial({
    color: 0x4a3323,
    roughness: 0.92,
    metalness: 0.0,
  });
  woodMaterial.name = 'LighthouseDoor';

  const windowMaterial = new THREE.MeshStandardMaterial({
    color: 0x18242c,
    roughness: 0.24,
    metalness: 0.2,
    emissive: new THREE.Color(0xffb15a),
    emissiveIntensity: 0.03,
  });
  windowMaterial.name = 'LighthouseWindowGlow';

  const glassMaterial = new THREE.MeshStandardMaterial({
    color: 0xa8ccd4,
    roughness: 0.08,
    metalness: 0.25,
    transparent: true,
    opacity: 0.26,
    depthWrite: false,
    side: THREE.DoubleSide,
    emissive: new THREE.Color(0xffc478),
    emissiveIntensity: 0.02,
  });
  glassMaterial.name = 'LanternGlass';

  const lampCoreMaterial = new THREE.MeshBasicMaterial({
    color: 0xffd08a,
    toneMapped: false,
    depthWrite: false,
  });
  lampCoreMaterial.name = 'LampCore';

  const doorLampMaterial = new THREE.MeshStandardMaterial({
    color: 0x2b2418,
    roughness: 0.5,
    metalness: 0.1,
    emissive: new THREE.Color(0xffb25c),
    emissiveIntensity: 0.05,
  });
  doorLampMaterial.name = 'DoorLamp';

  const addMesh = (parent, geometry, material, x, y, z, opts = {}) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    if (opts.rotation) mesh.rotation.set(opts.rotation[0], opts.rotation[1], opts.rotation[2]);
    mesh.castShadow = opts.castShadow !== false;
    mesh.receiveShadow = opts.receiveShadow !== false;
    if (opts.name) mesh.name = opts.name;
    if (opts.renderOrder !== undefined) mesh.renderOrder = opts.renderOrder;
    parent.add(mesh);
    return mesh;
  };

  // --- plinth & steps ----------------------------------------------------
  addMesh(group, new THREE.CylinderGeometry(4.9, 4.9, 0.25, 8), stoneMaterial, 0, 0.125, 0, { name: 'PlinthStepA' });
  addMesh(group, new THREE.CylinderGeometry(4.55, 4.72, 0.25, 8), stoneMaterial, 0, 0.375, 0, { name: 'PlinthStepB' });
  addMesh(group, new THREE.CylinderGeometry(4.02, 4.38, 0.55, 8), stoneMaterial, 0, 0.775, 0, { name: 'PlinthBody' });
  addMesh(group, new THREE.CylinderGeometry(4.06, 4.06, 0.07, 8), whiteMaterial, 0, 1.015, 0, { name: 'PlinthCap' });

  // --- tower -------------------------------------------------------------
  addMesh(
    group,
    new THREE.CylinderGeometry(LH.towerTopRadius, LH.towerBottomRadius, LH.towerHeight, 56, 1, false),
    towerMaterial,
    0,
    LH.towerBottom + LH.towerHeight * 0.5,
    0,
    { name: 'Tower' },
  );

  addMesh(group, new THREE.CylinderGeometry(2.62, 2.68, 0.4, 56), whiteMaterial, 0, 1.25, 0, { name: 'TowerBaseCollar' });
  addMesh(group, new THREE.CylinderGeometry(2.1, 2.16, 0.18, 56), whiteMaterial, 0, 10.9, 0, { name: 'TowerMidCornice' });
  addMesh(group, new THREE.CylinderGeometry(1.7, 1.76, 0.22, 56), whiteMaterial, 0, 16.26, 0, { name: 'TowerTopCornice' });

  // --- gallery, railing, lantern room -----------------------------------
  addMesh(group, new THREE.CylinderGeometry(2.62, 1.96, 0.55, 56), whiteMaterial, 0, 16.675, 0, { name: 'GalleryCorbel' });
  addMesh(group, new THREE.CylinderGeometry(2.74, 2.74, 0.22, 56), ironMaterial, 0, 17.06, 0, { name: 'GalleryDeck' });

  const postGeometry = new THREE.CylinderGeometry(0.032, 0.045, 0.9, 6);
  const postCount = 20;
  const posts = new THREE.InstancedMesh(postGeometry, ironMaterial, postCount);
  posts.name = 'GalleryRailing';
  posts.castShadow = true;
  posts.receiveShadow = true;
  const postDummy = new THREE.Object3D();
  for (let i = 0; i < postCount; i++) {
    const a = (i / postCount) * TAU;
    postDummy.position.set(Math.sin(a) * LH.railRadius, 17.62, Math.cos(a) * LH.railRadius);
    postDummy.rotation.set(0, a, 0);
    postDummy.updateMatrix();
    posts.setMatrixAt(i, postDummy.matrix);
  }
  posts.instanceMatrix.needsUpdate = true;
  group.add(posts);

  const ringGeometry = new THREE.TorusGeometry(LH.railRadius, 0.028, 6, 72);
  ringGeometry.rotateX(Math.PI / 2);
  for (const y of [17.21, 17.64, LH.railTop]) {
    addMesh(group, ringGeometry.clone(), ironMaterial, 0, y, 0, { name: 'GalleryRailRing' });
  }
  const topRingGeometry = new THREE.TorusGeometry(LH.railRadius, 0.04, 6, 72);
  topRingGeometry.rotateX(Math.PI / 2);
  addMesh(group, topRingGeometry, ironMaterial, 0, LH.railTop, 0, { name: 'GalleryRailCap' });

  addMesh(group, new THREE.CylinderGeometry(1.76, 1.62, 0.16, 36), ironMaterial, 0, 17.25, 0, { name: 'LanternFloor' });

  addMesh(
    group,
    new THREE.CylinderGeometry(LH.glassRadius, LH.glassRadius, LH.glassTop - LH.glassBottom, 36, 1, true),
    glassMaterial,
    0,
    (LH.glassTop + LH.glassBottom) * 0.5,
    0,
    { name: 'LanternGlass', castShadow: false, receiveShadow: false, renderOrder: 2 },
  );

  const mullionCount = 14;
  const mullionHeight = LH.glassTop - LH.glassBottom;
  const mullionGeometry = new THREE.BoxGeometry(0.055, mullionHeight, 0.055);
  const mullions = new THREE.InstancedMesh(mullionGeometry, ironMaterial, mullionCount);
  mullions.name = 'LanternMullions';
  mullions.castShadow = true;
  mullions.receiveShadow = true;
  const mullionDummy = new THREE.Object3D();
  for (let i = 0; i < mullionCount; i++) {
    const a = (i / mullionCount) * TAU;
    mullionDummy.position.set(
      Math.sin(a) * (LH.glassRadius + 0.025),
      (LH.glassTop + LH.glassBottom) * 0.5,
      Math.cos(a) * (LH.glassRadius + 0.025),
    );
    mullionDummy.rotation.set(0, a, 0);
    mullionDummy.updateMatrix();
    mullions.setMatrixAt(i, mullionDummy.matrix);
  }
  mullions.instanceMatrix.needsUpdate = true;
  group.add(mullions);

  addMesh(group, new THREE.CylinderGeometry(1.4, 1.4, 0.09, 36), ironMaterial, 0, LH.glassBottom, 0, { name: 'LanternBottomRing' });
  addMesh(group, new THREE.CylinderGeometry(1.4, 1.4, 0.09, 36), ironMaterial, 0, LH.glassTop, 0, { name: 'LanternTopRing' });
  const lanternMidRing = new THREE.TorusGeometry(1.37, 0.026, 6, 48);
  lanternMidRing.rotateX(Math.PI / 2);
  addMesh(group, lanternMidRing, ironMaterial, 0, LH.lampY, 0, { name: 'LanternMidRing' });

  // Lens pedestal + glowing lamp.
  addMesh(group, new THREE.CylinderGeometry(0.26, 0.44, 0.56, 16), ironMaterial, 0, 17.62, 0, { name: 'LampPedestal' });
  const lampCore = addMesh(
    group,
    new THREE.CylinderGeometry(0.26, 0.42, 0.88, 24),
    lampCoreMaterial,
    0,
    LH.lampY,
    0,
    { name: 'LampCore', castShadow: false, receiveShadow: false },
  );
  addMesh(group, new THREE.CylinderGeometry(0.44, 0.3, 0.14, 16), ironMaterial, 0, LH.lampY + 0.5, 0, { name: 'LampCap' });

  // --- roof & finial -----------------------------------------------------
  addMesh(group, new THREE.CylinderGeometry(1.63, 1.52, 0.16, 36), ironMaterial, 0, LH.glassTop + 0.08, 0, { name: 'RoofCollar' });

  const domeProfile = [];
  const domeRadius = 1.57;
  const domeHeight = 1.72;
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * (Math.PI * 0.5);
    const r = Math.max(0.001, domeRadius * Math.cos(a) + 0.04 * Math.sin(a * 3));
    domeProfile.push(new THREE.Vector2(r, domeHeight * Math.sin(a)));
  }
  addMesh(
    group,
    new THREE.LatheGeometry(domeProfile, 40),
    roofMaterial,
    0,
    LH.domeBase,
    0,
    { name: 'LanternDome' },
  );
  const domeRimGeometry = new THREE.TorusGeometry(1.6, 0.045, 6, 48);
  domeRimGeometry.rotateX(Math.PI / 2);
  addMesh(group, domeRimGeometry, ironMaterial, 0, LH.domeBase + 0.4, 0, { name: 'DomeRim' });

  addMesh(group, new THREE.SphereGeometry(0.11, 12, 8), ironMaterial, 0, LH.domeBase + domeHeight + 0.08, 0, { name: 'FinialBall' });
  addMesh(group, new THREE.CylinderGeometry(0.022, 0.022, 0.62, 8), ironMaterial, 0, LH.domeBase + domeHeight + 0.5, 0, { name: 'FinialRod' });
  addMesh(group, new THREE.ConeGeometry(0.07, 0.2, 8), ironMaterial, 0, LH.domeBase + domeHeight + 0.9, 0, { name: 'FinialTip' });

  // --- door & windows ----------------------------------------------------
  const doorAngle = Math.atan2(-baseX, -baseZ);
  const doorY = 2.28;
  const doorRadius = towerRadiusAt(doorY);
  const doorGroup = new THREE.Group();
  doorGroup.name = 'DoorAssembly';
  doorGroup.position.set(Math.sin(doorAngle) * doorRadius, 0, Math.cos(doorAngle) * doorRadius);
  doorGroup.rotation.y = doorAngle;
  group.add(doorGroup);

  addMesh(doorGroup, new THREE.BoxGeometry(1.34, 2.42, 0.14), whiteMaterial, 0, 2.2, 0.02, { name: 'DoorFrame' });
  addMesh(doorGroup, new THREE.BoxGeometry(1.02, 2.02, 0.1), woodMaterial, 0, 2.14, 0.1, { name: 'DoorLeaf' });
  addMesh(doorGroup, new THREE.BoxGeometry(1.56, 0.2, 0.26), whiteMaterial, 0, 3.46, 0.03, { name: 'DoorLintel' });
  addMesh(doorGroup, new THREE.SphereGeometry(0.05, 8, 6), ironMaterial, 0.34, 2.1, 0.16, { name: 'DoorHandle' });
  addMesh(doorGroup, new THREE.BoxGeometry(1.6, 0.14, 0.55), stoneMaterial, 0, 1.12, 0.3, { name: 'DoorThreshold' });
  // Stairs from the plateau up to the plinth top.
  for (let i = 0; i < 3; i++) {
    const top = 0.35 * (i + 1);
    addMesh(
      doorGroup,
      new THREE.BoxGeometry(1.7, top, 0.4),
      stoneMaterial,
      0,
      top * 0.5,
      2.6 - i * 0.38,
      { name: `DoorStep_${i}` },
    );
  }
  // Warm lamp above the door (emissive only — no extra light).
  addMesh(doorGroup, new THREE.BoxGeometry(0.18, 0.26, 0.14), doorLampMaterial, 0, 3.72, 0.14, { name: 'DoorLamp' });
  addMesh(doorGroup, new THREE.BoxGeometry(0.32, 0.06, 0.24), ironMaterial, 0, 3.9, 0.12, { name: 'DoorLampHood' });

  const windowFrameGeometry = new THREE.BoxGeometry(0.5, 0.72, 0.08);
  const windowGlassGeometry = new THREE.BoxGeometry(0.34, 0.56, 0.04);
  const windowSillGeometry = new THREE.BoxGeometry(0.62, 0.07, 0.16);
  for (let i = 0; i < 6; i++) {
    const y = 4.4 + i * 1.82;
    const angle = doorAngle + 0.9 + i * 1.06;
    const radius = towerRadiusAt(y);
    const win = new THREE.Group();
    win.name = `TowerWindow_${i}`;
    win.position.set(Math.sin(angle) * radius, y, Math.cos(angle) * radius);
    win.rotation.y = angle;
    addMesh(win, windowFrameGeometry, ironMaterial, 0, 0, 0.02, { name: 'WindowFrame' });
    addMesh(win, windowGlassGeometry, windowMaterial, 0, 0, 0.06, { name: 'WindowGlass', castShadow: false });
    addMesh(win, windowSillGeometry, whiteMaterial, 0, -0.38, 0.04, { name: 'WindowSill' });
    group.add(win);
  }

  // --- rotating beams & lights ------------------------------------------
  const beamRig = new THREE.Group();
  beamRig.name = 'BeamRig';
  beamRig.position.set(0, LH.lampY, 0);
  // Start roughly perpendicular to the default camera so the first night
  // frame reads as sweeping beams rather than one cone aimed down the lens.
  beamRig.rotation.y = 2.55;
  group.add(beamRig);

  const beamLength = 48;
  const beamGeometry = new THREE.CylinderGeometry(6.4, 0.55, beamLength, 48, 1, true);
  beamGeometry.rotateX(Math.PI / 2);
  beamGeometry.translate(0, 0, beamLength * 0.5);

  const beamMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color().setRGB(1.35, 1.0, 0.62) },
      uIntensity: { value: 0.06 },
      uTime: { value: 0 },
      uFogDensity: { value: 0.0024 },
      uLength: { value: beamLength },
    },
    vertexShader: BEAM_VERTEX_SHADER,
    fragmentShader: BEAM_FRAGMENT_SHADER,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  beamMaterial.name = 'LighthouseBeam';

  const beamA = new THREE.Mesh(beamGeometry, beamMaterial);
  beamA.name = 'BeamA';
  beamA.renderOrder = 8;
  beamA.castShadow = false;
  beamA.receiveShadow = false;
  beamRig.add(beamA);

  const beamB = new THREE.Mesh(beamGeometry, beamMaterial);
  beamB.name = 'BeamB';
  beamB.rotation.y = Math.PI;
  beamB.renderOrder = 8;
  beamB.castShadow = false;
  beamB.receiveShadow = false;
  beamRig.add(beamB);

  const spotLight = new THREE.SpotLight(0xffd39a, 0, 95, 0.15, 0.62, 1.85);
  spotLight.name = 'LighthouseSpot';
  spotLight.position.set(0, 0, 0.4);
  spotLight.castShadow = false;
  const spotTarget = new THREE.Object3D();
  spotTarget.position.set(0, 0, 30);
  beamRig.add(spotTarget);
  spotLight.target = spotTarget;
  beamRig.add(spotLight);

  const lampLight = new THREE.PointLight(0xffbe78, 0, 55, 2);
  lampLight.name = 'LighthouseLamp';
  lampLight.position.set(0, LH.lampY, 0);
  lampLight.castShadow = false;
  group.add(lampLight);

  const glowMaterial = new THREE.SpriteMaterial({
    map: glowTexture,
    color: 0xffd79c,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    opacity: 0.1,
    toneMapped: false,
  });
  const glowSprite = new THREE.Sprite(glowMaterial);
  glowSprite.name = 'LampGlow';
  glowSprite.position.set(0, LH.lampY, 0);
  glowSprite.scale.set(4.6, 4.6, 1);
  glowSprite.renderOrder = 10;
  group.add(glowSprite);

  const coreGlowMaterial = new THREE.SpriteMaterial({
    map: glowTexture,
    color: 0xfff0cb,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    opacity: 0.25,
    toneMapped: false,
  });
  const coreGlow = new THREE.Sprite(coreGlowMaterial);
  coreGlow.name = 'LampCoreGlow';
  coreGlow.position.set(0, LH.lampY, 0);
  coreGlow.scale.set(1.9, 1.9, 1);
  coreGlow.renderOrder = 11;
  group.add(coreGlow);

  // Keep a reference for debugging / camera rigs.
  group.userData.lampWorld = lampWorldPosition(new THREE.Vector3());

  const BEAM_COLOR = new THREE.Color().setRGB(1.35, 1.0, 0.62);
  const LAMP_COLOR = new THREE.Color(0xffd08a);
  let time = 0;

  const update = (dt, env) => {
    const step = THREE.MathUtils.clamp(dt || 0, 0, 0.05);
    time += step;

    const night = env.nightFactor || 0;
    const twilight = env.twilightFactor || 0;
    const storm = env.stormMix || 0;
    const lightning = env.lightning || 0;
    const visibility = THREE.MathUtils.clamp(
      Math.max(night, twilight * 0.78, storm * 0.6),
      0,
      1,
    );

    const flicker = 0.94 +
      0.045 * Math.sin(time * 13.7) +
      0.03 * Math.sin(time * 27.3 + 1.7) +
      0.02 * Math.sin(time * 41.1 + 0.6);

    // Rotate the twin beams around the lantern.
    beamRig.rotation.y = (beamRig.rotation.y + step * (0.3 + storm * 0.06)) % TAU;

    beamMaterial.uniforms.uTime.value = time;
    beamMaterial.uniforms.uFogDensity.value = env.fogDensity ?? 0.0024;
    beamMaterial.uniforms.uIntensity.value =
      (0.035 + visibility * 0.36) * (0.9 + flicker * 0.1) + lightning * 0.3;
    beamMaterial.uniforms.uColor.value
      .copy(BEAM_COLOR)
      .lerp(env.fogColor || BEAM_COLOR, storm * 0.12);

    const lampIntensity = (3 + visibility * 100) * flicker * (1 + lightning * 0.9);
    lampLight.intensity = lampIntensity;
    lampLight.color.copy(LAMP_COLOR).lerp(env.fogColor || LAMP_COLOR, storm * 0.08);

    spotLight.intensity = visibility * 820 * (0.86 + 0.14 * flicker) + lightning * 260;
    spotLight.color.copy(LAMP_COLOR);

    lampCoreMaterial.color.copy(LAMP_COLOR).multiplyScalar(0.55 + visibility * 2.4 + lightning * 0.8);

    glowMaterial.opacity = 0.08 + visibility * 0.82 + lightning * 0.4;
    const glowScale = 3.9 + visibility * 1.2 + storm * 0.6;
    glowSprite.scale.set(glowScale, glowScale, 1);
    coreGlowMaterial.opacity = 0.2 + visibility * 0.8 + lightning * 0.5;

    windowMaterial.emissiveIntensity = 0.03 + visibility * 1.9;
    doorLampMaterial.emissiveIntensity = 0.05 + visibility * 2.6;
    glassMaterial.emissiveIntensity = 0.02 + visibility * 0.55;
    glassMaterial.opacity = 0.24 + visibility * 0.08;
  };

  return {
    group,
    update,
    lampLight,
    spotLight,
    beamRig,
    lampCore,
    towerRadiusAt,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the lighthouse, shoreline props, beach furniture and seagulls.
 * Adds the resulting group to `scene` and returns the animated handles.
 *
 * @param {THREE.Scene} scene
 * @returns {{ group: THREE.Group, update: (dt: number, env: object) => void, lighthouseLight: THREE.PointLight }}
 */
export function createStructures(scene) {
  const group = new THREE.Group();
  group.name = 'Structures';

  const lighthouse = createLighthouse();
  group.add(lighthouse.group);
  // Convenience for camera rigs / audio: where the lantern actually is.
  group.userData.lampWorld = lampWorldPosition(new THREE.Vector3());

  const rocks = createRocks(mulberry32(SEED ^ 0x51a7));
  group.add(rocks.group);

  const driftwood = createDriftwood(
    mulberry32(SEED ^ 0x77b1),
    rocks.placed,
  );
  group.add(driftwood.group);

  const coconuts = createCoconuts(
    mulberry32(SEED ^ 0x0c0c),
    rocks.placed.concat(driftwood.placed),
  );
  group.add(coconuts.group);

  const gulls = createGulls();
  group.add(gulls.group);

  scene.add(group);

  const update = (dt, env) => {
    lighthouse.update(dt, env);
    gulls.update(dt, env);
  };

  // Prime uniforms / light intensities from the current shared environment so
  // the very first rendered frame is already correct.
  update(0, initialEnv);

  return {
    group,
    update,
    lighthouseLight: lighthouse.lampLight,
  };
}
