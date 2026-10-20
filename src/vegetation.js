import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  heightAt,
  slopeAt,
  coastRadius,
  fbm2,
  LIGHTHOUSE_SITE,
  WORLD_HALF,
} from './heightfield.js';

/**
 * Procedural vegetation for the island.
 *
 * Everything here is generated from the same `heightAt()` the terrain uses, so
 * trunks and grass roots sit exactly on the visible ground. No textures are
 * loaded: bark bands, frond gradients and grass colour are carried in vertex
 * colours, and all wind motion happens in the vertex shader.
 *
 * Public API (contract with main.js):
 *
 *   const vegetation = createVegetation(scene);
 *   vegetation.group           // THREE.Group added to the scene
 *   vegetation.update(dt, env) // dt seconds, env from environment.js
 *   vegetation.palmCount       // placed palms
 *   vegetation.grassCount      // instanced grass clumps (13,000)
 *
 * Shared wind uniforms (updated every frame from `env`):
 *   uTime         seconds
 *   uWindStrength env.windStrength (0..1.4)
 *   uWindDir      env.windDir (Vector2)
 *   uStorm        env.stormMix (0..1)
 *
 * Per-vertex wind attributes expected by every vegetation geometry:
 *   aWindWeight  0 at the anchored base -> 1 at the free end
 *   aFlutter     secondary flutter weight (frond tips / grass blades)
 *   aPhase       per-frond / per-blade phase offset
 */

// ---------------------------------------------------------------------------
// Constants & deterministic randomness
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const GRASS_COUNT = 13000;
const PALM_TARGET = 24;
const SHRUB_COUNT = 250;
const MOUNTAIN_SCRUB_COUNT = 1400;
const FLOWER_COUNT = 180;

const LIGHTHOUSE_CLEARANCE = 9; // palms: metres from the lighthouse site
const LIGHTHOUSE_PLAZA_CLEARANCE = 11; // grass: keep the plaza walkable
const PALM_MIN_SPACING = 4.8;

/** Small, fast, deterministic PRNG (same family used by the other island modules). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash11(n) {
  const s = Math.sin(n * 127.1) * 43758.5453123;
  return s - Math.floor(s);
}

function smoothstep(edge0, edge1, x) {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Cheap forward-difference slope estimate used during scattering.
 * `gradient` matches 2 * heightfield.slopeAt() (which divides by 2).
 */
function terrainGradient(x, z, h, eps) {
  const hx = heightAt(x + eps, z);
  const hz = heightAt(x, z + eps);
  return Math.hypot(hx - h, hz - h) / eps;
}

// ---------------------------------------------------------------------------
// Colour palette. THREE.Color parses sRGB hex into the renderer's linear
// working space, which is exactly the space vertex colours are consumed in.
// ---------------------------------------------------------------------------

const C = {
  barkDark: new THREE.Color('#33241a'),
  barkLight: new THREE.Color('#8a6a47'),
  barkSeam: new THREE.Color('#241910'),
  frondRib: new THREE.Color('#a8bf56'),
  frondBase: new THREE.Color('#6f9238'),
  frondMid: new THREE.Color('#487128'),
  frondTip: new THREE.Color('#22491a'),
  bootDark: new THREE.Color('#33391a'),
  bootGreen: new THREE.Color('#5a5f28'),
  bract: new THREE.Color('#8fb544'),
  coconutDark: new THREE.Color('#42301a'),
  coconutLight: new THREE.Color('#7a5a2c'),
  grassBase: new THREE.Color('#2f441a'),
  grassTip: new THREE.Color('#b9a94e'),
  shrubBase: new THREE.Color('#243a12'),
  shrubTop: new THREE.Color('#557a22'),
  flowerStem: new THREE.Color('#4b6b2a'),
  flowerPetal: new THREE.Color('#efe6d0'),
  glint: new THREE.Color('#fff3c8'),
};

// Single low-poly sphere used for every coconut (only read at build time).
const COCONUT_TEMPLATE = new THREE.IcosahedronGeometry(1, 1);

// ---------------------------------------------------------------------------
// Wind shader — one layered model shared by palms and ground cover.
// The displacement is injected at `begin_vertex`, so normals, lights, fog,
// shadow maps and tone mapping stay exactly as MeshStandardMaterial provides.
// ---------------------------------------------------------------------------

const WIND_HEADER = /* glsl */ `
uniform float uTime;
uniform float uWindStrength;
uniform vec2  uWindDir;
uniform float uStorm;

attribute float aWindWeight;
attribute float aFlutter;
attribute float aPhase;

vec2 vegSafeWindDir(vec2 d) {
  float l = length(d);
  return l > 1e-5 ? d / l : vec2(1.0, 0.0);
}
`;

/**
 * Palms: height-weighted trunk sway (slow gust + sway layers), then a
 * per-frond flutter layered on top. aFlutter is zero on the trunk, so the
 * crown stays attached. Storm adds a violent steady bend.
 */
const PALM_WIND_BODY = /* glsl */ `
{
  vec2 wdir = vegSafeWindDir(uWindDir);
  vec2 wside = vec2(-wdir.y, wdir.x);
  vec2 plantPos = modelMatrix[3].xz;
  float plantPhase = fract(sin(dot(plantPos, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;

  float strength = uWindStrength;
  float storm = clamp(uStorm, 0.0, 1.5);
  float t = uTime;

  // Slow, spatially travelling gust front.
  float travel = dot(plantPos, wdir) * 0.12 - t * (0.6 + 1.1 * strength);
  float gust = 0.5 + 0.5 * sin(travel) * (0.6 + 0.4 * sin(travel * 0.37 + 1.7 + plantPhase));

  // Primary sway of the whole palm (one slow + one faster layer).
  float sway = sin(t * (1.1 + 0.7 * strength) + plantPhase) * 0.65
             + sin(t * 0.41 + plantPhase * 0.73 + 1.3) * 0.35;

  // Secondary frond flutter, per-frond phase from aPhase.
  float flutter = sin(t * (3.2 + 3.0 * strength) + aPhase * 6.2831853 + aWindWeight * 4.0) * 0.6
                + sin(t * (5.7 + 3.4 * strength) + aPhase * 9.7 - aWindWeight * 7.0) * 0.4;

  float amp = strength * (0.30 + 0.55 * min(storm, 1.0));
  float bend = aWindWeight * aWindWeight;
  float gustBend = amp * (0.35 + 1.15 * gust);

  transformed.xz += wdir * (bend * gustBend + flutter * aFlutter * amp * 0.38);
  transformed.xz += wside * (bend * sway * amp * 0.55 + flutter * aFlutter * amp * 0.22);

  // Visual arc-length compensation: tips dip as they bend away.
  transformed.y -= (bend * (0.12 + 0.50 * min(storm, 1.0)) * strength
                   + aFlutter * 0.05 * abs(flutter)) * 0.35;
}
`;

/**
 * Ground cover: grass, shrubs and wildflowers. Same layered model, but the
 * tuft is an InstancedMesh, so the wind offset is computed in world space and
 * rotated back into the instance's local frame (the blades must all lean the
 * same way, not rotate with the clump's random yaw). Stronger per-blade
 * flutter than the palms.
 */
const GROUND_WIND_BODY = /* glsl */ `
{
  vec2 wdir = vegSafeWindDir(uWindDir);
  vec2 wside = vec2(-wdir.y, wdir.x);

  #ifdef USE_INSTANCING
    vec2 plantPos = instanceMatrix[3].xz;
    vec2 basisX = instanceMatrix[0].xz;
    vec2 basisZ = instanceMatrix[2].xz;
    basisX = length(basisX) > 1e-5 ? normalize(basisX) : vec2(1.0, 0.0);
    basisZ = length(basisZ) > 1e-5 ? normalize(basisZ) : vec2(0.0, 1.0);
  #else
    vec2 plantPos = modelMatrix[3].xz;
    vec2 basisX = vec2(1.0, 0.0);
    vec2 basisZ = vec2(0.0, 1.0);
  #endif

  float plantPhase = fract(sin(dot(plantPos, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
  float strength = uWindStrength;
  float storm = clamp(uStorm, 0.0, 1.5);
  float t = uTime;

  // Ground wind travels a little faster than the palm gust.
  float travel = dot(plantPos, wdir) * 0.16 - t * (0.75 + 1.2 * strength);
  float gust = 0.5 + 0.5 * sin(travel) * (0.55 + 0.45 * sin(travel * 0.41 + plantPhase));

  float flutter = sin(t * (4.1 + 3.4 * strength) + aPhase * 6.2831853 + plantPos.x * 2.3 + plantPos.y * 1.7) * 0.6
                + sin(t * (7.0 + 4.2 * strength) + aPhase * 3.7 - plantPos.y * 3.1) * 0.4;

  float amp = strength * (0.55 + 0.85 * min(storm, 1.0));
  float bend = aWindWeight;

  // Coherent bend along the wind plus high-frequency blade flutter.
  vec2 offsetW = wdir * (bend * bend * (0.42 + 0.90 * gust) * amp + flutter * bend * amp * 0.26)
               + wside * (flutter * bend * amp * 0.34
                          + sin(t * (2.2 + 1.6 * strength) + plantPhase + aPhase * 4.0) * bend * amp * 0.10);

  #ifdef USE_INSTANCING
    vec2 offsetObj = vec2(dot(offsetW, basisX), dot(offsetW, basisZ));
  #else
    vec2 offsetObj = offsetW;
  #endif

  transformed.xz += offsetObj;
  transformed.y -= bend * bend * amp * (0.10 + 0.12 * min(storm, 1.0));
}
`;

function createPalmMaterials(uniforms) {
  const tints = ['#ffffff', '#e9f6d9', '#d9efc6'];
  const roughness = [0.78, 0.83, 0.88];

  return tints.map((tint, i) => {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(tint),
      roughness: roughness[i],
      metalness: 0.0,
      vertexColors: true,
      side: THREE.DoubleSide,
    });

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;
      shader.uniforms.uWindStrength = uniforms.uWindStrength;
      shader.uniforms.uWindDir = uniforms.uWindDir;
      shader.uniforms.uStorm = uniforms.uStorm;
      shader.uniforms.uTransColor = uniforms.uTransColor;

      shader.vertexShader = WIND_HEADER + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n' + PALM_WIND_BODY,
      );

      // Faked translucency: a little warm back-scatter read from the vertex
      // colour (bright rib -> deep green tip). Added before tone mapping/fog so
      // it stays physically consistent with the rest of the frame.
      shader.fragmentShader = 'uniform vec3 uTransColor;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        '#include <opaque_fragment>\n\tgl_FragColor.rgb += vColor.rgb * uTransColor;',
      );
    };
    material.customProgramCacheKey = () => 'vegetation-palm-wind-v1';
    return material;
  });
}

/**
 * Matching depth material so the swaying palms cast shadow silhouettes that
 * follow the wind (no extra uniforms — it shares the same uniform objects).
 */
function createPalmDepthMaterial(uniforms) {
  const material = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    side: THREE.DoubleSide,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWindStrength = uniforms.uWindStrength;
    shader.uniforms.uWindDir = uniforms.uWindDir;
    shader.uniforms.uStorm = uniforms.uStorm;

    shader.vertexShader = WIND_HEADER + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n' + PALM_WIND_BODY,
    );
  };
  material.customProgramCacheKey = () => 'vegetation-palm-depth-v1';
  return material;
}

function createGroundMaterial(uniforms) {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.0,
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  material.defines = { VEG_GROUND: 1 };

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWindStrength = uniforms.uWindStrength;
    shader.uniforms.uWindDir = uniforms.uWindDir;
    shader.uniforms.uStorm = uniforms.uStorm;

    shader.vertexShader = WIND_HEADER + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n' + GROUND_WIND_BODY,
    );
  };
  material.customProgramCacheKey = () => 'vegetation-ground-wind-v1';
  return material;
}

// ---------------------------------------------------------------------------
// Small geometry building helpers. A "part" accumulates one merged vertex
// buffer; every plant ends up as a single draw call.
// ---------------------------------------------------------------------------

function newPart() {
  return {
    pos: [],
    nrm: [],
    col: [],
    wind: [],
    flutter: [],
    phase: [],
  };
}

/** Vertex tuple: [x,y,z, nx,ny,nz, r,g,b, aWindWeight, aFlutter, aPhase] */
function V(x, y, z, nx, ny, nz, r, g, b, w, fl, ph) {
  return [x, y, z, nx, ny, nz, r, g, b, w, fl, ph];
}

function pushTri(part, a, b, c) {
  // Make the winding agree with the authored vertex normal. Most of this
  // vegetation is thin and rendered DoubleSide; without this, back-face normal
  // flipping would invert the lighting on roughly half of the triangles.
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const gx = uy * vz - uz * vy;
  const gy = uz * vx - ux * vz;
  const gz = ux * vy - uy * vx;
  const nx = a[3] + b[3] + c[3];
  const ny = a[4] + b[4] + c[4];
  const nz = a[5] + b[5] + c[5];
  if (gx * nx + gy * ny + gz * nz < 0) {
    const tmp = b;
    b = c;
    c = tmp;
  }
  part.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  part.nrm.push(a[3], a[4], a[5], b[3], b[4], b[5], c[3], c[4], c[5]);
  part.col.push(a[6], a[7], a[8], b[6], b[7], b[8], c[6], c[7], c[8]);
  part.wind.push(a[9], b[9], c[9]);
  part.flutter.push(a[10], b[10], c[10]);
  part.phase.push(a[11], b[11], c[11]);
}

function faceNormal(a, b, c, upBias) {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  if (upBias && ny < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  return [nx, ny, nz];
}

function partToGeometry(part) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(part.nrm, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(part.col, 3));
  geometry.setAttribute('aWindWeight', new THREE.Float32BufferAttribute(part.wind, 1));
  geometry.setAttribute('aFlutter', new THREE.Float32BufferAttribute(part.flutter, 1));
  geometry.setAttribute('aPhase', new THREE.Float32BufferAttribute(part.phase, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

// ---------------------------------------------------------------------------
// Coconut palm
// ---------------------------------------------------------------------------

/**
 * Builds one complete palm (trunk + crown boot + bracts + individual fronds +
 * coconuts) into a single merged BufferGeometry, in local space with the base
 * at y = 0. The caller sinks the mesh 0.1 into the terrain.
 */
function buildPalmGeometry(seed) {
  const rng = mulberry32(seed);
  const part = newPart();

  // -- trunk parameters ------------------------------------------------------
  const height = 6.8 + rng() * 5.0; // 6.8 .. 11.8 m
  const ringCount = 22 + Math.floor(rng() * 7); // 22 .. 28 rings
  const radial = 8 + Math.floor(rng() * 3); // 8 .. 10 sides
  const leanAzimuth = rng() * TAU;
  const leanAmount = height * (0.055 + rng() * 0.16);
  const leanX = Math.cos(leanAzimuth) * leanAmount;
  const leanZ = Math.sin(leanAzimuth) * leanAmount;
  const curvePhase = rng() * TAU;
  const sideCurve = (rng() - 0.5) * height * 0.16;
  const perpX = -Math.sin(leanAzimuth);
  const perpZ = Math.cos(leanAzimuth);
  const twist = (rng() - 0.5) * 0.55;
  const rBase = 0.30 + rng() * 0.05; // ~0.32 at the base
  const rTip = 0.145 + rng() * 0.03; // ~0.16 at the crown
  const barkFreq = 1.2 + rng() * 1.6;
  const barkPhase = rng() * TAU;
  const ringPhase = rng() * TAU;

  // -- spine + parallel-transported frames -----------------------------------
  const sx = new Float64Array(ringCount);
  const sy = new Float64Array(ringCount);
  const sz = new Float64Array(ringCount);
  const tx = new Float64Array(ringCount);
  const ty = new Float64Array(ringCount);
  const tz = new Float64Array(ringCount);
  const fx = new Float64Array(ringCount); // side (radial) axis
  const fy = new Float64Array(ringCount);
  const fz = new Float64Array(ringCount);
  const ux = new Float64Array(ringCount); // second radial axis
  const uy = new Float64Array(ringCount);
  const uz = new Float64Array(ringCount);

  for (let i = 0; i < ringCount; i++) {
    const t = i / (ringCount - 1);
    const bend = Math.pow(t, 1.55) * (1 - 0.12 * Math.exp(-t * 6));
    const wave = Math.sin(Math.PI * t) * Math.sin(t * (2.0 + curvePhase * 0.2) + curvePhase) * sideCurve;
    sx[i] = leanX * bend + perpX * wave;
    sy[i] = height * (t + 0.02 * Math.sin(Math.PI * t));
    sz[i] = leanZ * bend + perpZ * wave;
  }

  for (let i = 0; i < ringCount; i++) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(ringCount - 1, i + 1);
    let ax = sx[i1] - sx[i0];
    let ay = sy[i1] - sy[i0];
    let az = sz[i1] - sz[i0];
    const alen = Math.hypot(ax, ay, az) || 1;
    ax /= alen;
    ay /= alen;
    az /= alen;
    tx[i] = ax;
    ty[i] = ay;
    tz[i] = az;

    if (i === 0) {
      // side = tangent x worldUp, fall back to world X for vertical tangents.
      fx[0] = -az;
      fy[0] = 0;
      fz[0] = ax;
      let fl = Math.hypot(fx[0], fy[0], fz[0]);
      if (fl < 1e-3) {
        fx[0] = 1;
        fy[0] = 0;
        fz[0] = 0;
        fl = 1;
      }
      fx[0] /= fl;
      fz[0] /= fl;
    } else {
      // Parallel transport the previous side vector onto the new ring plane.
      let px = fx[i - 1];
      let py = fy[i - 1];
      let pz = fz[i - 1];
      const dot = px * ax + py * ay + pz * az;
      px -= ax * dot;
      py -= ay * dot;
      pz -= az * dot;
      let pl = Math.hypot(px, py, pz);
      if (pl < 1e-3) {
        px = 1;
        py = 0;
        pz = 0;
        pl = 1;
      }
      fx[i] = px / pl;
      fy[i] = py / pl;
      fz[i] = pz / pl;
    }
    // up = tangent x side
    ux[i] = ty[i] * fz[i] - tz[i] * fy[i];
    uy[i] = tz[i] * fx[i] - tx[i] * fz[i];
    uz[i] = tx[i] * fy[i] - ty[i] * fx[i];
  }

  const dbR = C.barkLight.r - C.barkDark.r;
  const dbG = C.barkLight.g - C.barkDark.g;
  const dbB = C.barkLight.b - C.barkDark.b;

  // -- lofted trunk rings ----------------------------------------------------
  const ringVerts = [];
  for (let i = 0; i < ringCount; i++) {
    const t = i / (ringCount - 1);
    const ringBand = 0.5 + 0.5 * Math.sin(i * barkFreq + barkPhase);
    const baseAO = 0.70 + 0.30 * smoothstep(0, 0.12, t);
    const crownAO = 1 - 0.12 * smoothstep(0.9, 1.0, t);
    const bandMix = THREE.MathUtils.clamp(0.16 + 0.72 * ringBand, 0, 1);

    const taperMix = Math.pow(t, 0.82);
    const taper = rBase + (rTip - rBase) * taperMix;
    const flare = 1 + 0.85 * Math.pow(Math.max(0, 1 - t / 0.09), 2);
    const ringBulge = 1 + 0.035 * Math.sin(i * 2.3 + ringPhase);

    const verts = [];
    for (let j = 0; j < radial; j++) {
      const theta = (j / radial) * TAU + twist * t;
      const cs = Math.cos(theta);
      const sn = Math.sin(theta);
      const lobe = 1
        + 0.075 * Math.sin(theta * 2 + t * 5.5 + curvePhase)
        + 0.035 * Math.sin(theta * 3 - t * 3 + ringPhase);
      const radius = taper * flare * ringBulge * lobe;

      const dx = fx[i] * cs + ux[i] * sn;
      const dy = fy[i] * cs + uy[i] * sn;
      const dz = fz[i] * cs + uz[i] * sn;

      const grain = 0.90 + 0.20 * hash11(i * 13.7 + j * 7.31 + seed * 0.0001);
      const ao = baseAO * crownAO * grain;
      // Seam shading: faint dark cracks between bark plates.
      const seam = 1 - 0.18 * Math.pow(1 - Math.abs(Math.sin(theta * radial * 0.5)), 3);

      const cr = (C.barkDark.r + dbR * bandMix) * ao * seam;
      const cg = (C.barkDark.g + dbG * bandMix) * ao * seam;
      const cb = (C.barkDark.b + dbB * bandMix) * ao * seam;

      const windWeight = 0.55 * Math.pow(t, 1.6);
      verts.push(
        V(
          sx[i] + dx * radius,
          sy[i] + dy * radius,
          sz[i] + dz * radius,
          dx, dy, dz,
          cr, cg, cb,
          windWeight, 0, 0,
        ),
      );
    }
    ringVerts.push(verts);
  }

  for (let i = 0; i < ringCount - 1; i++) {
    const a = ringVerts[i];
    const b = ringVerts[i + 1];
    for (let j = 0; j < radial; j++) {
      const j2 = (j + 1) % radial;
      pushTri(part, a[j], a[j2], b[j2]);
      pushTri(part, a[j], b[j2], b[j]);
    }
  }

  const crownX = sx[ringCount - 1];
  const crownY = sy[ringCount - 1];
  const crownZ = sz[ringCount - 1];
  const crownTanX = tx[ringCount - 1];
  const crownTanY = ty[ringCount - 1];
  const crownTanZ = tz[ringCount - 1];

  // -- root flare fins -------------------------------------------------------
  const finBaseY = -0.12;
  for (let k = 0; k < 5; k++) {
    const theta = (k / 5) * TAU + (rng() - 0.5) * 0.5;
    const dirX = fx[0] * Math.cos(theta) + ux[0] * Math.sin(theta);
    const dirZ = fz[0] * Math.cos(theta) + uz[0] * Math.sin(theta);
    const dirLen = Math.hypot(dirX, dirZ) || 1;
    const ndx = dirX / dirLen;
    const ndz = dirZ / dirLen;
    const px = -ndz; // horizontal perpendicular, gives the fin thickness
    const pz = ndx;
    const finLen = rBase * (2.1 + rng() * 0.5);

    const ax = sx[0] + ndx * finLen;
    const az = sz[0] + ndz * finLen;
    const bx = sx[0] + ndx * finLen * 0.32 + px * 0.06;
    const bz = sz[0] + ndz * finLen * 0.32 + pz * 0.06;
    const cx = sx[0] + ndx * finLen * 0.32 - px * 0.06;
    const cz = sz[0] + ndz * finLen * 0.32 - pz * 0.06;

    const darkR = C.barkSeam.r * 1.1;
    const darkG = C.barkSeam.g * 1.1;
    const darkB = C.barkSeam.b * 1.1;
    const midR = (C.barkDark.r + C.barkSeam.r) * 0.5;
    const midG = (C.barkDark.g + C.barkSeam.g) * 0.5;
    const midB = (C.barkDark.b + C.barkSeam.b) * 0.5;

    const a = V(ax, finBaseY, az, 0, 1, 0, midR, midG, midB, 0.02, 0, 0);
    const b = V(bx, finBaseY, bz, 0, 1, 0, darkR, darkG, darkB, 0.02, 0, 0);
    const c = V(cx, finBaseY, cz, 0, 1, 0, darkR, darkG, darkB, 0.02, 0, 0);
    const top = V(sx[0] + ndx * 0.05, 0.55 + rng() * 0.15, sz[0] + ndz * 0.05,
      ndx, 0.4, ndz, midR, midG, midB, 0.04, 0, 0);
    pushTri(part, a, b, top);
    pushTri(part, a, top, c);
    pushTri(part, b, c, top);
  }

  // -- crown boot / collar ---------------------------------------------------
  const bootOffsets = [-0.62, -0.34, -0.04, 0.16];
  const bootRadii = [1.85, 2.18, 1.60, 0.72];
  const bootSegs = 9;
  const bootRings = [];
  for (let m = 0; m < bootOffsets.length; m++) {
    const mR = rTip * bootRadii[m] * (1 + 0.05 * Math.sin(m * 2.1 + ringPhase));
    const mY = crownY + bootOffsets[m] * THREE.MathUtils.clamp(height / 10, 0.8, 1.2);
    const bootMix = m / (bootOffsets.length - 1);
    const ring = [];
    for (let j = 0; j < bootSegs; j++) {
      const th = (j / bootSegs) * TAU;
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      const r = mR * (1 + 0.08 * Math.sin(th * 3 + m * 1.7));
      const nx = cs;
      const ny = 0.42;
      const nz = sn;
      const nlen = Math.hypot(nx, ny, nz);
      const grain = 0.9 + 0.2 * hash11(j * 3.1 + m * 8.7);
      const cr = (C.bootDark.r + (C.bootGreen.r - C.bootDark.r) * (0.35 + 0.65 * bootMix)) * grain;
      const cg = (C.bootDark.g + (C.bootGreen.g - C.bootDark.g) * (0.35 + 0.65 * bootMix)) * grain;
      const cb = (C.bootDark.b + (C.bootGreen.b - C.bootDark.b) * (0.35 + 0.65 * bootMix)) * grain;
      ring.push(
        V(
          crownX + cs * r,
          mY + ny * 0.03,
          crownZ + sn * r,
          nx / nlen, ny / nlen, nz / nlen,
          cr, cg, cb,
          0.55, 0, 0,
        ),
      );
    }
    bootRings.push(ring);
  }
  for (let m = 0; m < bootRings.length - 1; m++) {
    const a = bootRings[m];
    const b = bootRings[m + 1];
    for (let j = 0; j < bootSegs; j++) {
      const j2 = (j + 1) % bootSegs;
      pushTri(part, a[j], a[j2], b[j2]);
      pushTri(part, a[j], b[j2], b[j]);
    }
  }

  // -- young bracts (leafy crown base) --------------------------------------
  const bractCount = 7 + Math.floor(rng() * 3);
  const bractBaseR = C.bract.r;
  const bractBaseG = C.bract.g;
  const bractBaseB = C.bract.b;
  for (let k = 0; k < bractCount; k++) {
    const yaw = rng() * TAU;
    const pitch = 0.35 + rng() * 0.8;
    const len = 0.32 + rng() * 0.34;
    const dirX = Math.cos(pitch) * Math.cos(yaw);
    const dirY = Math.sin(pitch);
    const dirZ = Math.cos(pitch) * Math.sin(yaw);
    const sideX = -Math.sin(yaw);
    const sideZ = Math.cos(yaw);
    const ox = crownX + dirX * 0.03;
    const oy = crownY + 0.06 + dirY * 0.03;
    const oz = crownZ + dirZ * 0.03;
    const halfW = 0.028 + rng() * 0.022;
    const a = V(ox + sideX * halfW, oy, oz + sideZ * halfW,
      0, 1, 0, bractBaseR * 0.8, bractBaseG * 0.8, bractBaseB * 0.8, 0.55, 0.05, 0);
    const b = V(ox - sideX * halfW, oy, oz - sideZ * halfW,
      0, 1, 0, bractBaseR * 0.8, bractBaseG * 0.8, bractBaseB * 0.8, 0.55, 0.05, 0);
    const tipX = ox + dirX * len;
    const tipY = oy + dirY * len;
    const tipZ = oz + dirZ * len;
    const c = V(tipX, tipY, tipZ, 0, 1, 0,
      C.frondTip.r, C.frondTip.g, C.frondTip.b, 0.62, 0.30, 0);
    const n = faceNormal(a, b, c, false);
    a[3] = n[0];
    a[4] = n[1];
    a[5] = n[2];
    b[3] = n[0];
    b[4] = n[1];
    b[5] = n[2];
    c[3] = n[0];
    c[4] = n[1];
    c[5] = n[2];
    pushTri(part, a, b, c);
  }

  // -- fronds ---------------------------------------------------------------
  const frondCount = 12 + Math.floor(rng() * 3); // 12 .. 14
  const rankPitch = [0.90, 0.58, 0.32, 0.12];
  for (let k = 0; k < frondCount; k++) {
    const yaw = k * GOLDEN_ANGLE + (rng() - 0.5) * 0.32;
    const pitch = Math.max(0.02, rankPitch[k % 4] + (rng() - 0.5) * 0.18);
    const frondLength = height * (0.26 + rng() * 0.12);
    const droop = 0.52 + rng() * 0.62;
    const phase = rng();
    const tint = 0.88 + rng() * 0.24;
    const attachR = 0.05 + rng() * 0.07;
    const ox = crownX + Math.cos(yaw) * attachR;
    const oy = crownY + 0.04 + rng() * 0.06;
    const oz = crownZ + Math.sin(yaw) * attachR;
    buildFrond(part, rng, ox, oy, oz, yaw, pitch, frondLength, droop, phase, tint);
  }

  // -- coconuts -------------------------------------------------------------
  const coconutCount = 3 + Math.floor(rng() * 4); // 3 .. 6
  buildCoconuts(part, rng, crownX, crownY, crownZ, coconutCount);

  const geometry = partToGeometry(part);
  // Fronds move in the wind; give culling some extra room.
  if (geometry.boundingSphere) geometry.boundingSphere.radius += 2.6;

  return { geometry, height };
}

/**
 * One individual frond: a real lofted rachis ribbon plus pairs of separate
 * leaflet triangles (feathered silhouette, ragged tips, V-shaped fold as the
 * leaflets droop away from the rib).
 */
function buildFrond(part, rng, ox, oy, oz, yaw, pitch, length, droop, phase, tint) {
  const N = 24 + Math.floor(rng() * 5); // spine samples (dense feathering)
  const segLen = length / (N - 1);

  const px = new Float64Array(N);
  const py = new Float64Array(N);
  const pz = new Float64Array(N);

  let x = ox;
  let y = oy;
  let z = oz;
  for (let i = 0; i < N; i++) {
    px[i] = x;
    py[i] = y;
    pz[i] = z;
    const t = i / (N - 1);
    const ang = pitch - droop * Math.pow(t, 1.35);
    // Gentle S in plan view so fronds are not straight spokes.
    const wig = Math.sin(t * Math.PI * 1.15 + phase * TAU * 0.7) * 0.22 * (0.35 + t);
    const hd = yaw + wig;
    x += Math.cos(ang) * Math.cos(hd) * segLen;
    y += Math.sin(ang) * segLen;
    z += Math.cos(ang) * Math.sin(hd) * segLen;
  }

  // Tangents and horizontal side axes along the rachis.
  const tnx = new Float64Array(N);
  const tny = new Float64Array(N);
  const tnz = new Float64Array(N);
  const sdx = new Float64Array(N);
  const sdz = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(N - 1, i + 1);
    let ax = px[i1] - px[i0];
    let ay = py[i1] - py[i0];
    let az = pz[i1] - pz[i0];
    const l = Math.hypot(ax, ay, az) || 1;
    ax /= l;
    ay /= l;
    az /= l;
    tnx[i] = ax;
    tny[i] = ay;
    tnz[i] = az;
    // side = normalize(cross(tangent, worldUp)) -> horizontal, perpendicular.
    let sx = -az;
    let sz = ax;
    let sl = Math.hypot(sx, sz);
    if (sl < 1e-4) {
      sx = 1;
      sz = 0;
      sl = 1;
    }
    sdx[i] = sx / sl;
    sdz[i] = sz / sl;
  }

  const ribR = C.frondRib.r * tint;
  const ribG = C.frondRib.g * tint;
  const ribB = C.frondRib.b * tint;
  const baseR = C.frondBase.r * tint;
  const baseG = C.frondBase.g * tint;
  const baseB = C.frondBase.b * tint;
  const midR = C.frondMid.r * tint;
  const midG = C.frondMid.g * tint;
  const midB = C.frondMid.b * tint;
  const tipR = C.frondTip.r * tint;
  const tipG = C.frondTip.g * tint;
  const tipB = C.frondTip.b * tint;

  const maxLeaf = 0.215 * length;

  // -- leaflets -------------------------------------------------------------
  // Narrow strap-like leaflets in a V around the rachis. Individual kite
  // shapes with visible gaps read as a feather, not a saw-toothed blade.
  for (let i = 2; i <= N - 2; i++) {
    const t = i / (N - 1);
    const env = Math.sin(Math.PI * Math.pow(t, 0.68));
    const wWind = 0.55 + 0.45 * Math.pow(t, 1.2);
    const flBase = 0.90 * Math.pow(t, 1.25);

    // Leaf colour moves from yellow-green at the rib to deep green at the tips.
    const rootMix = THREE.MathUtils.clamp(0.45 + 0.55 * t, 0, 1);
    const lr = baseR + (midR - baseR) * rootMix;
    const lg = baseG + (midG - baseG) * rootMix;
    const lb = baseB + (midB - baseB) * rootMix;
    const tipMix = THREE.MathUtils.clamp(0.30 + 0.70 * t, 0, 1);
    const tr = midR + (tipR - midR) * tipMix;
    const tg = midG + (tipG - midG) * tipMix;
    const tb = midB + (tipB - midB) * tipMix;

    for (let s = -1; s <= 1; s += 2) {
      const notchRoll = rng();
      if (notchRoll < 0.03) continue; // ragged gap
      let leafLen = maxLeaf * env * (0.80 + rng() * 0.44);
      if (notchRoll > 0.90) leafLen *= 0.42; // deep notch

      // Sweep leaflets toward the tip and hang them below the rachis (V fold).
      const fwdMix = 0.55 + rng() * 0.35;
      const downMix = 0.20 + 0.58 * t + rng() * 0.24;
      let dx = sdx[i] * s + tnx[i] * fwdMix;
      let dy = tny[i] * fwdMix - downMix;
      let dz = sdz[i] * s + tnz[i] * fwdMix;
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;

      // Width axis: horizontal, perpendicular to the leaflet.
      let wx = -dz;
      let wz = dx;
      const wl = Math.hypot(wx, wz) || 1;
      wx /= wl;
      wz /= wl;

      const halfW = leafLen * (0.075 + rng() * 0.035);
      const midX = px[i] + dx * leafLen * 0.46 + wx * 0;
      const midY = py[i] + dy * leafLen * 0.46 + leafLen * 0.035; // slight crease lift
      const midZ = pz[i] + dz * leafLen * 0.46;
      const tipX = px[i] + dx * leafLen;
      const tipY = py[i] + dy * leafLen - leafLen * 0.07; // tip droop
      const tipZ = pz[i] + dz * leafLen;

      const jitter = 0.92 + 0.16 * hash11(i * 17.3 + s * 5.1 + phase * 11.7);
      const midR2 = (lr + tr) * 0.5;
      const midG2 = (lg + tg) * 0.5;
      const midB2 = (lb + tb) * 0.5;

      const rootV = V(px[i], py[i], pz[i], 0, 1, 0,
        lr * jitter, lg * jitter, lb * jitter, wWind, flBase, phase);
      const sideA = V(midX + wx * halfW, midY, midZ + wz * halfW, 0, 1, 0,
        midR2 * jitter, midG2 * jitter, midB2 * jitter, wWind + 0.05, flBase + 0.10, phase);
      const sideB = V(midX - wx * halfW, midY, midZ - wz * halfW, 0, 1, 0,
        midR2 * jitter, midG2 * jitter, midB2 * jitter, wWind + 0.05, flBase + 0.10, phase);
      const tipV = V(tipX, tipY, tipZ, 0, 1, 0,
        tr * jitter, tg * jitter, tb * jitter, Math.min(1.1, wWind + 0.10),
        Math.min(1.35, flBase + 0.20), phase);

      const n = faceNormal(rootV, sideA, tipV, true);
      for (const v of [rootV, sideA, sideB, tipV]) {
        v[3] = n[0]; v[4] = n[1]; v[5] = n[2];
      }
      pushTri(part, rootV, sideA, tipV);
      pushTri(part, rootV, tipV, sideB);
    }
  }

  // -- rachis ribbon (midrib) ----------------------------------------------
  for (let i = 0; i < N - 1; i++) {
    const t0 = i / (N - 1);
    const t1 = (i + 1) / (N - 1);
    const rw0 = 0.011 * (1 - 0.55 * t0) + 0.003;
    const rw1 = 0.011 * (1 - 0.55 * t1) + 0.003;

    const a = V(
      px[i] + sdx[i] * rw0, py[i] + 0.004, pz[i] + sdz[i] * rw0,
      0, 1, 0,
      ribR + (baseR - ribR) * t0, ribG + (baseG - ribG) * t0, ribB + (baseB - ribB) * t0,
      0.55 + 0.45 * t0, 0.85 * Math.pow(t0, 1.25), phase,
    );
    const b = V(
      px[i] - sdx[i] * rw0, py[i] + 0.004, pz[i] - sdz[i] * rw0,
      0, 1, 0,
      ribR + (baseR - ribR) * t0, ribG + (baseG - ribG) * t0, ribB + (baseB - ribB) * t0,
      0.55 + 0.45 * t0, 0.85 * Math.pow(t0, 1.25), phase,
    );
    const c = V(
      px[i + 1] - sdx[i + 1] * rw1, py[i + 1] + 0.004, pz[i + 1] - sdz[i + 1] * rw1,
      0, 1, 0,
      ribR + (baseR - ribR) * t1, ribG + (baseG - ribG) * t1, ribB + (baseB - ribB) * t1,
      0.55 + 0.45 * t1, 0.85 * Math.pow(t1, 1.25), phase,
    );
    const d = V(
      px[i + 1] + sdx[i + 1] * rw1, py[i + 1] + 0.004, pz[i + 1] + sdz[i + 1] * rw1,
      0, 1, 0,
      ribR + (baseR - ribR) * t1, ribG + (baseG - ribG) * t1, ribB + (baseB - ribB) * t1,
      0.55 + 0.45 * t1, 0.85 * Math.pow(t1, 1.25), phase,
    );
    const n = faceNormal(a, b, c, true);
    for (const v of [a, b, c, d]) {
      v[3] = n[0];
      v[4] = n[1];
      v[5] = n[2];
    }
    pushTri(part, a, b, c);
    pushTri(part, b, d, c);
  }

  // -- tapered tip ----------------------------------------------------------
  const last = N - 1;
  const tA = V(px[last] + sdx[last] * 0.006, py[last], pz[last] + sdz[last] * 0.006,
    0, 1, 0, tipR, tipG, tipB, 1.05, 1.0, phase);
  const tB = V(px[last] - sdx[last] * 0.006, py[last], pz[last] - sdz[last] * 0.006,
    0, 1, 0, tipR, tipG, tipB, 1.05, 1.0, phase);
  const tC = V(px[last] + tnx[last] * length * 0.1, py[last] + tny[last] * length * 0.1 - 0.01,
    pz[last] + tnz[last] * length * 0.1, 0, 1, 0, tipR, tipG, tipB, 1.05, 1.0, phase);
  const tn = faceNormal(tA, tB, tC, true);
  tA[3] = tn[0]; tA[4] = tn[1]; tA[5] = tn[2];
  tB[3] = tn[0]; tB[4] = tn[1]; tB[5] = tn[2];
  tC[3] = tn[0]; tC[4] = tn[1]; tC[5] = tn[2];
  pushTri(part, tA, tB, tC);
}

/** Lumpy low-poly coconuts clustered around the crown. */
function buildCoconuts(part, rng, cx, cy, cz, count) {
  const tPos = COCONUT_TEMPLATE.attributes.position;
  const tNrm = COCONUT_TEMPLATE.attributes.normal;
  const vertCount = tPos.count;

  const eul = new THREE.Euler();
  const rot = new THREE.Matrix4();
  const me = rot.elements;

  for (let k = 0; k < count; k++) {
    const a = (k / count) * TAU + (rng() - 0.5) * 0.8;
    const rad = 0.20 + rng() * 0.17;
    const px = cx + Math.cos(a) * rad;
    const pz = cz + Math.sin(a) * rad;
    const py = cy - 0.14 - rng() * 0.26;
    const cr = 0.10 + rng() * 0.055;
    const squash = 1.12 + rng() * 0.22;
    eul.set((rng() - 0.5) * 0.9, rng() * TAU, (rng() - 0.5) * 0.9);
    rot.makeRotationFromEuler(eul);

    const lumpSeed = rng() * 100;
    const bright = 0.82 + rng() * 0.36;

    for (let i = 0; i < vertCount; i += 3) {
      const tri = [];
      for (let v = 0; v < 3; v++) {
        const idx = i + v;
        const lump = 0.88 + 0.20 * hash11(idx * 1.37 + lumpSeed);
        const lx = tPos.getX(idx) * cr * lump;
        const ly = tPos.getY(idx) * cr * squash * lump;
        const lz = tPos.getZ(idx) * cr * lump;
        const rx = me[0] * lx + me[4] * ly + me[8] * lz;
        const ry = me[1] * lx + me[5] * ly + me[9] * lz;
        const rz = me[2] * lx + me[6] * ly + me[10] * lz;
        const nx0 = tNrm.getX(idx);
        const ny0 = tNrm.getY(idx);
        const nz0 = tNrm.getZ(idx);
        let nx = me[0] * nx0 + me[4] * ny0 + me[8] * nz0;
        let ny = me[1] * nx0 + me[5] * ny0 + me[9] * nz0;
        let nz = me[2] * nx0 + me[6] * ny0 + me[10] * nz0;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;

        const mott = 0.28 + 0.62 * hash11(idx * 2.71 + lumpSeed * 1.7);
        const br = (C.coconutDark.r + (C.coconutLight.r - C.coconutDark.r) * mott) * bright;
        const bg = (C.coconutDark.g + (C.coconutLight.g - C.coconutDark.g) * mott) * bright;
        const bb = (C.coconutDark.b + (C.coconutLight.b - C.coconutDark.b) * mott) * bright;

        tri.push(V(px + rx, py + ry, pz + rz, nx, ny, nz, br, bg, bb, 0.55, 0, 0));
      }
      pushTri(part, tri[0], tri[1], tri[2]);
    }
  }
}

// ---------------------------------------------------------------------------
// Palm placement — deterministic, heightAt/slopeAt driven
// ---------------------------------------------------------------------------

function placePalmSites() {
  const rng = mulberry32(0x5eedf10a);
  const sites = [];

  // Three passes: the first finds the gently-sloping beach fringe palms, the
  // later ones relax the slope/spacing limits only as far as needed to fill
  // the grove. Keeps the silhouettes elegant while guaranteeing >= 20 palms.
  const phases = [
    { hMin: 0.9, hMax: 6.0, gradient: 0.62, spacing: 4.6, attempts: 22000 },
    { hMin: 0.9, hMax: 6.2, gradient: 0.90, spacing: 4.3, attempts: 90000 },
    { hMin: 0.85, hMax: 6.5, gradient: 1.05, spacing: 4.0, attempts: 120000 },
  ];

  for (let phase = 0; phase < phases.length; phase++) {
    const spec = phases[phase];
    let attempts = 0;
    while (sites.length < PALM_TARGET && attempts < spec.attempts) {
      attempts += 1;
      const angle = rng() * TAU;
      const coast = coastRadius(angle);
      const inlandMax = Math.min(16, coast - 3);
      if (inlandMax < 5) continue;
      const inland = 3 + rng() * (inlandMax - 3);
      const dist = coast - inland;
      if (dist < 2.5) continue;

      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      if (Math.abs(x) > WORLD_HALF - 12 || Math.abs(z) > WORLD_HALF - 12) continue;

      const h = heightAt(x, z);
      if (h < spec.hMin || h > spec.hMax) continue;

      const ldx = x - LIGHTHOUSE_SITE.x;
      const ldz = z - LIGHTHOUSE_SITE.z;
      if (ldx * ldx + ldz * ldz < LIGHTHOUSE_CLEARANCE * LIGHTHOUSE_CLEARANCE) continue;

      if (terrainGradient(x, z, h, 0.6) > spec.gradient) continue;

      let spaced = true;
      for (let i = 0; i < sites.length; i++) {
        const dx = x - sites[i].x;
        const dz = z - sites[i].z;
        if (dx * dx + dz * dz < spec.spacing * spec.spacing) {
          spaced = false;
          break;
        }
      }
      if (!spaced) continue;

      sites.push({ x, z, h, seed: (rng() * 0xffffffff) >>> 0 });
      rng();
      rng();
    }
    if (sites.length >= PALM_TARGET) break;
  }

  return sites;
}

/**
 * A single transparent decal mesh of soft radial contact shadows at every palm
 * base. Real-time shadow maps are disabled in this build, so these small
 * grounding shadows do a lot for the sense of contact with the sand.
 */
function createPalmContactShadows(sites) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(0,0,0,0.62)');
  grad.addColorStop(0.38, 'rgba(0,0,0,0.47)');
  grad.addColorStop(0.72, 'rgba(0,0,0,0.16)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.MeshBasicMaterial({
    name: 'PalmContactShadow',
    map: texture,
    transparent: true,
    depthWrite: false,
    opacity: 0.68,
    color: 0x000000,
    toneMapped: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });

  const up = new THREE.Vector3(0, 1, 0);
  const normal = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const yawQuat = new THREE.Quaternion();
  const matrix = new THREE.Matrix4();
  const positions = [];
  const scaleVec = new THREE.Vector3();
  const rng = mulberry32(0xc0c0a1);

  const geometries = [];
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const eps = 0.55;
    const hx = heightAt(site.x + eps, site.z) - heightAt(site.x - eps, site.z);
    const hz = heightAt(site.x, site.z + eps) - heightAt(site.x, site.z - eps);
    normal.set(-hx / (2 * eps), 1, -hz / (2 * eps)).normalize();
    quat.setFromUnitVectors(up, normal);
    yawQuat.setFromAxisAngle(up, rng() * TAU);
    quat.multiply(yawQuat);
    const s = 3.2 + rng() * 1.4;
    scaleVec.set(s, 1, s * (0.82 + rng() * 0.32));
    matrix.compose(new THREE.Vector3(site.x, site.h + 0.035, site.z), quat, scaleVec);
    geo.applyMatrix4(matrix);
    geometries.push(geo);
  }
  const merged = mergeGeometries(geometries, false);
  for (const g of geometries) g.dispose();
  if (!merged) return null;
  merged.computeBoundingSphere();
  const mesh = new THREE.Mesh(merged, material);
  mesh.name = 'palmContactShadows';
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return mesh;
}

function createPalmMeshes(sites, materials, depthMaterial) {
  const meshes = [];
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    const { geometry } = buildPalmGeometry(site.seed);
    const mesh = new THREE.Mesh(geometry, materials[i % materials.length]);
    mesh.name = `palm_${i}`;
    mesh.position.set(site.x, site.h - 0.1, site.z); // sink the base 0.1 m
    mesh.castShadow = i % 3 !== 0; // two thirds cast shadows
    mesh.receiveShadow = true;
    if (mesh.castShadow) mesh.customDepthMaterial = depthMaterial;
    meshes.push(mesh);
  }
  return meshes;
}

// ---------------------------------------------------------------------------
// Grass — one InstancedMesh, fully GPU animated
// ---------------------------------------------------------------------------

/**
 * One grass clump: three crossed, tapered blades (12 vertices, 6 triangles).
 * Base is dark, tips are golden-green; vertex colours are tinted per instance.
 */
function createGrassGeometry() {
  // A clump is three crossed blades curved into an arc. Each blade has a base
  // row, a mid row and a pointed tip (5 vertices, 3 triangles) for a much
  // softer silhouette than a single flat quad.
  const positions = [];
  const normals = [];
  const colors = [];
  const wind = [];
  const flutter = [];
  const phase = [];
  const indices = [];

  const bladeHeights = [1.0, 0.82, 0.90];
  const bladeWidths = [0.105, 0.088, 0.078]; // base width in metres
  const bendMid = [0.10, 0.08, 0.11];
  const bendTip = [0.24, 0.20, 0.28];
  const greenness = [0.22, 0.55, 0.38]; // 0 = golden tip, 1 = green tip

  const tipR = C.grassTip.r;
  const tipG = C.grassTip.g;
  const tipB = C.grassTip.b;
  const mixR = C.frondMid.r;
  const mixG = C.frondMid.g;
  const mixB = C.frondMid.b;

  for (let b = 0; b < 3; b++) {
    const yaw = (b / 3) * TAU + (b === 1 ? 0.16 : 0);
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    // forward = (cs, 0, sn); side = (-sn, 0, cs)
    const h = bladeHeights[b];
    const hw = bladeWidths[b] * 0.5;
    const mw = hw * 0.62;
    const fMid = bendMid[b];
    const fTip = bendTip[b];
    const base = b * 5;

    // Up-biased normal so a field of blades catches the sun (double-sided
    // material flips it for the back of the blade).
    const nX = -sn * 0.45;
    const nY = 1.0;
    const nZ = cs * 0.45;
    const nLen = Math.hypot(nX, nY, nZ);

    // Vertex ring coordinates: 0/1 base, 2/3 mid, 4 tip.
    const vx = [-sn * hw, sn * hw, -sn * mw + cs * fMid, sn * mw + cs * fMid, cs * fTip];
    const vy = [0, 0, h * 0.56, h * 0.56, h];
    const vz = [cs * hw, -cs * hw, cs * mw + sn * fMid, -cs * mw + sn * fMid, sn * fTip];

    const green = greenness[b];
    const tr = tipR + (mixR - tipR) * green;
    const tg = tipG + (mixG - tipG) * green;
    const tb = tipB + (mixB - tipB) * green;
    const mr = C.grassBase.r + (tr - C.grassBase.r) * 0.55;
    const mg = C.grassBase.g + (tg - C.grassBase.g) * 0.55;
    const mb = C.grassBase.b + (tb - C.grassBase.b) * 0.55;

    for (let v = 0; v < 5; v++) {
      positions.push(vx[v], vy[v], vz[v]);
      normals.push(nX / nLen, nY / nLen, nZ / nLen);
      if (v < 2) {
        colors.push(C.grassBase.r * 0.68, C.grassBase.g * 0.68, C.grassBase.b * 0.68);
        wind.push(0);
        flutter.push(0.06);
      } else if (v < 4) {
        colors.push(mr, mg, mb);
        wind.push(0.5);
        flutter.push(0.45);
      } else {
        colors.push(tr, tg, tb);
        wind.push(1.0);
        flutter.push(1.0);
      }
      phase.push((b / 3) * TAU);
    }

    addBladeTriangle(indices, positions, base, base + 1, base + 3);
    addBladeTriangle(indices, positions, base, base + 3, base + 2);
    addBladeTriangle(indices, positions, base + 2, base + 3, base + 4);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('aWindWeight', new THREE.Float32BufferAttribute(wind, 1));
  geometry.setAttribute('aFlutter', new THREE.Float32BufferAttribute(flutter, 1));
  geometry.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Triangle winding helper for the indexed grass tuft: flip i1/i2 when the
 * implied face normal points downward (all blades use an up-biased normal).
 */
function addBladeTriangle(indices, positions, i0, i1, i2) {
  const ax = positions[i0 * 3];
  const ay = positions[i0 * 3 + 1];
  const az = positions[i0 * 3 + 2];
  const ux = positions[i1 * 3] - ax;
  const uy = positions[i1 * 3 + 1] - ay;
  const uz = positions[i1 * 3 + 2] - az;
  const vx = positions[i2 * 3] - ax;
  const vy = positions[i2 * 3 + 1] - ay;
  const vz = positions[i2 * 3 + 2] - az;
  const ny = uz * vx - ux * vz; // Y component of the face normal
  if (ny < 0) indices.push(i0, i2, i1);
  else indices.push(i0, i1, i2);
}

function makeGrassPlacement(rng, x, z, h) {
  const patch = fbm2(x * 0.11 + 21.7, z * 0.11 - 13.2, 2);
  const dry = THREE.MathUtils.clamp((0.52 - patch) * 1.6 + (rng() - 0.5) * 0.7, 0, 1);
  const brightness = 0.82 + rng() * 0.36;
  return {
    x,
    z,
    h,
    yaw: rng() * TAU,
    scaleXZ: 0.86 + rng() * 0.62,
    scaleY: 0.34 + rng() * 0.44,
    // Tints stay close to 1.0: they modulate the baked vertex gradient.
    tintR: (0.80 + dry * 0.36 + (rng() - 0.5) * 0.16) * brightness,
    tintG: (0.94 + dry * 0.16 + (rng() - 0.5) * 0.14) * brightness,
    tintB: (0.78 + (1 - dry) * 0.20 + (rng() - 0.5) * 0.12) * brightness,
  };
}

function placeGrass(palmSites) {
  const rng = mulberry32(0x0f10a7);
  const placements = [];
  let attempts = 0;

  while (placements.length < GRASS_COUNT && attempts < 170000) {
    attempts += 1;
    const angle = rng() * TAU;
    const coast = coastRadius(angle);

    // Target the grassy lowland ring: from just above the dry sand to the
    // foot of the central hill. The summit and the beach stay clear.
    const inlandMax = Math.min(18, coast - 3);
    if (inlandMax < 5) continue;
    const inland = 3.5 + rng() * (inlandMax - 3.5);
    const dist = coast - inland;
    if (dist < 2) continue;

    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    if (Math.abs(x) > WORLD_HALF - 8 || Math.abs(z) > WORLD_HALF - 8) continue;

    const h = heightAt(x, z);
    if (h < 1.0 || h > 8.6) continue; // beach / wet sand and rocky summit stay clear

    const ldx = x - LIGHTHOUSE_SITE.x;
    const ldz = z - LIGHTHOUSE_SITE.z;
    if (ldx * ldx + ldz * ldz < LIGHTHOUSE_PLAZA_CLEARANCE * LIGHTHOUSE_PLAZA_CLEARANCE) continue;

    let nearPalm = false;
    let palmProximity = 1;
    for (let i = 0; i < palmSites.length; i++) {
      const dx = x - palmSites[i].x;
      const dz = z - palmSites[i].z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 1.44) {
        nearPalm = true;
        break;
      }
      if (d2 < 12) palmProximity = Math.min(palmProximity, 0.55);
    }
    if (nearPalm) continue;

    if (terrainGradient(x, z, h, 0.65) > 1.15) continue;

    // Patchy meadows: broad FBM clumps with a shoreline fade.
    const patch = fbm2(x * 0.11 + 21.7, z * 0.11 - 13.2, 2);
    const patchFade = 0.50 + 0.50 * smoothstep(0.24, 0.70, patch);
    const shoreFade = 0.65 + 0.35 * smoothstep(1.0, 1.8, h);
    if (rng() > patchFade * shoreFade * palmProximity) continue;

    placements.push(makeGrassPlacement(rng, x, z, h));
  }

  // Deterministic fallback: guarantee the exact count even if the stochastic
  // sampler gets unlucky near the end.
  if (placements.length < GRASS_COUNT) {
    const fillRng = mulberry32(0x5a17f111);
    const step = 0.8;
    for (let z = -38; z <= 38 && placements.length < GRASS_COUNT; z += step) {
      for (let x = -38; x <= 38 && placements.length < GRASS_COUNT; x += step) {
        const jx = x + (fillRng() - 0.5) * step * 0.9;
        const jz = z + (fillRng() - 0.5) * step * 0.9;
        const h = heightAt(jx, jz);
        if (h < 1.0 || h > 8.6) continue;
        const ldx = jx - LIGHTHOUSE_SITE.x;
        const ldz = jz - LIGHTHOUSE_SITE.z;
        if (ldx * ldx + ldz * ldz < LIGHTHOUSE_PLAZA_CLEARANCE * LIGHTHOUSE_PLAZA_CLEARANCE) continue;
        placements.push(makeGrassPlacement(fillRng, jx, jz, h));
      }
    }
  }

  return placements;
}

function createInstancedMesh(geometry, material, placements, name, castShadow) {
  const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const tint = new THREE.Color();

  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    euler.set(0, p.yaw, 0);
    quat.setFromEuler(euler);
    pos.set(p.x, p.h - (p.sink !== undefined ? p.sink : 0.015), p.z);
    scale.set(p.scaleXZ, p.scaleY, p.scaleXZ);
    matrix.compose(pos, quat, scale);
    mesh.setMatrixAt(i, matrix);

    tint.setRGB(p.tintR, p.tintG, p.tintB);
    mesh.setColorAt(i, tint);
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// Shrubs & wildflowers (extra instanced draws, same wind material)
// ---------------------------------------------------------------------------

/** Low-poly bush: three overlapping faceted lobes with a dark-to-light gradient. */
/**
 * A low, leaf-clad bush: a few dark faceted cores to hide gaps, plus a shell
 * of individual leaf quads for a fluffy silhouette. Replaces the solid
 * "green boulder" look of a plain icosahedron.
 */
function createBushGeometry() {
  const rng = mulberry32(0xb0551);
  const coreParts = [];

  for (let k = 0; k < 3; k++) {
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const s = 0.15 + rng() * 0.09;
    geo.scale(s * (0.9 + rng() * 0.3), s * (0.8 + rng() * 0.3), s * (0.9 + rng() * 0.3));
    geo.translate((rng() - 0.5) * 0.3, 0.22 + rng() * 0.16, (rng() - 0.5) * 0.3);
    geo.deleteAttribute('uv');
    geo.computeVertexNormals();

    const posAttr = geo.attributes.position;
    const count = posAttr.count;
    const colors = new Float32Array(count * 3);
    const winds = new Float32Array(count);
    const flutters = new Float32Array(count);
    const phases = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const x = posAttr.getX(i);
      const y = posAttr.getY(i);
      const z = posAttr.getZ(i);
      const upMix = THREE.MathUtils.clamp(y / 0.6, 0, 1);
      const mottle = 0.6 + 0.6 * hash11(i * 3.7 + x * 5.1 + z * 2.3 + k * 1.9);
      const mr = C.shrubBase.r * 0.8 + (C.shrubTop.r - C.shrubBase.r * 0.8) * upMix;
      const mg = C.shrubBase.g * 0.8 + (C.shrubTop.g - C.shrubBase.g * 0.8) * upMix;
      const mb = C.shrubBase.b * 0.8 + (C.shrubTop.b - C.shrubBase.b * 0.8) * upMix;
      colors[i * 3] = mr * mottle;
      colors[i * 3 + 1] = mg * mottle;
      colors[i * 3 + 2] = mb * mottle;
      winds[i] = 0.08 + 0.16 * upMix;
      flutters[i] = 0.04;
      phases[i] = hash11(i * 4.3 + k * 2.1) * TAU;
    }

    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('aWindWeight', new THREE.Float32BufferAttribute(winds, 1));
    geo.setAttribute('aFlutter', new THREE.Float32BufferAttribute(flutters, 1));
    geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
    coreParts.push(geo);
  }

  const core = mergeGeometries(coreParts, false);
  for (const geo of coreParts) geo.dispose();

  // Leaf shell: diamond-ish leaflets arranged over the crown of the bush.
  const leaves = newPart();
  const leafCount = 26 + Math.floor(rng() * 10);
  for (let k = 0; k < leafCount; k++) {
    const a = rng() * TAU;
    const up = 0.22 + rng() * 0.68;
    const shell = (1 - up * 0.35) * (0.30 + rng() * 0.18);
    const cx = Math.cos(a) * shell;
    const cz = Math.sin(a) * shell;
    const cy = 0.18 + up * 0.55;
    // Leaf plane: outward + up, with a random roll.
    let ox = Math.cos(a) * (0.55 + rng() * 0.4);
    let oy = 0.35 + up * 0.8 + rng() * 0.2;
    let oz = Math.sin(a) * (0.55 + rng() * 0.4);
    const ol = Math.hypot(ox, oy, oz) || 1;
    ox /= ol; oy /= ol; oz /= ol;
    const len = 0.15 + rng() * 0.13;
    const wid = 0.045 + rng() * 0.04;
    // side = normalize(cross(outward, worldUp))
    let sx = -oz;
    let sz = ox;
    const sl = Math.hypot(sx, sz) || 1;
    sx /= sl; sz /= sl;

    const upMix = THREE.MathUtils.clamp(cy / 0.75, 0, 1);
    const mottle = 0.62 + 0.62 * hash11(k * 5.3 + 0.7);
    const leafR = (C.shrubBase.r * 0.7 + (C.shrubTop.r - C.shrubBase.r * 0.7) * (0.35 + 0.65 * upMix)) * mottle;
    const leafG = (C.shrubBase.g * 0.7 + (C.shrubTop.g - C.shrubBase.g * 0.7) * (0.35 + 0.65 * upMix)) * mottle;
    const leafB = (C.shrubBase.b * 0.7 + (C.shrubTop.b - C.shrubBase.b * 0.7) * (0.35 + 0.65 * upMix)) * mottle;
    const tipR = leafR * 1.16;
    const tipG = leafG * 1.14;
    const tipB = leafB * 1.1;

    const windW = 0.16 + 0.42 * upMix;
    const fl = 0.14 + 0.30 * upMix;
    const ph = rng();

    const p0 = V(cx + sx * wid, cy + 0.02, cz + sz * wid, 0, 1, 0,
      leafR, leafG, leafB, windW, fl, ph);
    const p1 = V(cx + ox * len, cy + oy * len * 0.6 + 0.02, cz + oz * len, 0, 1, 0,
      tipR, tipG, tipB, windW + 0.1, fl + 0.1, ph);
    const p2 = V(cx - sx * wid, cy + 0.02, cz - sz * wid, 0, 1, 0,
      leafR * 0.9, leafG * 0.9, leafB * 0.9, windW, fl, ph);
    const p3 = V(cx - ox * len * 0.22, cy - oy * 0.03 + 0.02, cz - oz * len * 0.22, 0, 1, 0,
      leafR, leafG, leafB, windW, fl, ph);

    const n = faceNormal(p0, p1, p2, false);
    for (const v of [p0, p1, p2, p3]) {
      v[3] = n[0]; v[4] = n[1]; v[5] = n[2];
    }
    pushTri(leaves, p0, p1, p2);
    pushTri(leaves, p0, p2, p3);
  }

  const leafGeo = partToGeometry(leaves);
  const merged = mergeGeometries([core, leafGeo], false);
  core.dispose();
  leafGeo.dispose();
  merged.translate(0, -0.12, 0); // leaf shell starts above the root; bury the base
  merged.computeBoundingSphere();
  return merged;
}

function placeShrubs() {
  const rng = mulberry32(0x5a4b5);
  const placements = [];
  let guard = 0;

  while (placements.length < SHRUB_COUNT && guard < 30000) {
    guard += 1;
    const angle = rng() * TAU;
    const coast = coastRadius(angle);
    const inlandMax = Math.min(18, coast - 3);
    if (inlandMax < 5) continue;
    const dist = coast - (5 + rng() * (inlandMax - 5));
    if (dist < 3) continue;
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    if (Math.abs(x) > WORLD_HALF - 10 || Math.abs(z) > WORLD_HALF - 10) continue;
    const h = heightAt(x, z);
    if (h < 1.1 || h > 7.2) continue;
    const ldx = x - LIGHTHOUSE_SITE.x;
    const ldz = z - LIGHTHOUSE_SITE.z;
    if (ldx * ldx + ldz * ldz < 121) continue;
    if (terrainGradient(x, z, h, 0.55) > 1.4) continue;

    let spaced = true;
    for (let i = 0; i < placements.length; i++) {
      const dx = x - placements[i].x;
      const dz = z - placements[i].z;
      if (dx * dx + dz * dz < 1.1) {
        spaced = false;
        break;
      }
    }
    if (!spaced) continue;

    const s = 0.5 + rng() * 0.45;
    placements.push({
      x,
      z,
      h,
      yaw: rng() * TAU,
      scaleXZ: s * (0.9 + rng() * 0.25),
      scaleY: s * (0.8 + rng() * 0.35),
      tintR: 0.82 + rng() * 0.34,
      tintG: 0.88 + rng() * 0.26,
      tintB: 0.78 + rng() * 0.26,
      sink: 0.05,
    });
  }

  return placements;
}

/** A tiny wildflower: four leaning stems with pale crossed petal quads. */
function createFlowerGeometry() {
  const part = newPart();
  const rng = mulberry32(0xf10a3);

  for (let s = 0; s < 4; s++) {
    const a = (s / 4) * TAU + rng() * 0.6;
    const off = 0.025 + rng() * 0.06;
    const bx = Math.cos(a) * off;
    const bz = Math.sin(a) * off;
    const height = 0.2 + rng() * 0.18;
    const lean = 0.05 + rng() * 0.09;
    const tipX = bx + Math.cos(a) * lean;
    const tipZ = bz + Math.sin(a) * lean;
    const phase = s * 1.7;

    // Stem: one narrow triangle.
    const stemHalf = 0.008;
    const stemA = V(bx - stemHalf, 0, bz, 0, 1, 0,
      C.flowerStem.r * 0.7, C.flowerStem.g * 0.7, C.flowerStem.b * 0.7, 0, 0.0, phase);
    const stemB = V(bx + stemHalf, 0, bz, 0, 1, 0,
      C.flowerStem.r * 0.7, C.flowerStem.g * 0.7, C.flowerStem.b * 0.7, 0, 0.0, phase);
    const stemC = V(tipX, height, tipZ, 0, 1, 0,
      C.flowerStem.r, C.flowerStem.g, C.flowerStem.b, 0.85, 0.9, phase);
    let n = faceNormal(stemA, stemB, stemC, true);
    stemA[3] = n[0]; stemA[4] = n[1]; stemA[5] = n[2];
    stemB[3] = n[0]; stemB[4] = n[1]; stemB[5] = n[2];
    stemC[3] = n[0]; stemC[4] = n[1]; stemC[5] = n[2];
    pushTri(part, stemA, stemB, stemC);

    // Petals: two crossed quads at the stem tip.
    const petal = 0.035 + rng() * 0.025;
    for (let q = 0; q < 2; q++) {
      const qa = a + q * (Math.PI / 2);
      const px = Math.cos(qa) * petal;
      const pz = Math.sin(qa) * petal;
      const qy = 0.012;
      const p0 = V(tipX - px, height + qy, tipZ - pz, 0, 1, 0,
        C.flowerPetal.r, C.flowerPetal.g, C.flowerPetal.b, 0.9, 0.98, phase);
      const p1 = V(tipX + px, height + qy, tipZ + pz, 0, 1, 0,
        C.flowerPetal.r, C.flowerPetal.g, C.flowerPetal.b, 0.9, 0.98, phase);
      const p2 = V(tipX + px * 0.35, height + qy + 0.01, tipZ + pz * 0.35, 0, 1, 0,
        C.glint.r, C.glint.g, C.glint.b, 0.92, 1.0, phase);
      const p3 = V(tipX - px * 0.35, height + qy + 0.01, tipZ - pz * 0.35, 0, 1, 0,
        C.glint.r, C.glint.g, C.glint.b, 0.92, 1.0, phase);
      n = faceNormal(p0, p1, p2, true);
      for (const v of [p0, p1, p2, p3]) {
        v[3] = n[0]; v[4] = n[1]; v[5] = n[2];
      }
      pushTri(part, p0, p1, p2);
      pushTri(part, p0, p2, p3);
    }
  }

  const geometry = partToGeometry(part);
  return geometry;
}

/**
 * A denser, smaller scrub layer for the upper mountain. The lowland shrubs
 * are sampled in a coastal ring, so without this the summit would read as a
 * bald grey dome from every orbit angle.
 */
function placeMountainScrub() {
  const rng = mulberry32(0x7a1b5c);
  const placements = [];
  let guard = 0;

  while (placements.length < MOUNTAIN_SCRUB_COUNT && guard < 90000) {
    guard += 1;
    const angle = rng() * TAU;
    const dist = 4 + Math.sqrt(rng()) * 28;
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    const h = heightAt(x, z);
    if (h < 7.4 || h > 18.2) continue;

    const ldx = x - LIGHTHOUSE_SITE.x;
    const ldz = z - LIGHTHOUSE_SITE.z;
    if (ldx * ldx + ldz * ldz < 110) continue;
    if (terrainGradient(x, z, h, 0.6) > 1.6) continue;

    let spaced = true;
    for (let i = 0; i < placements.length; i++) {
      const dx = x - placements[i].x;
      const dz = z - placements[i].z;
      if (dx * dx + dz * dz < 0.42) {
        spaced = false;
        break;
      }
    }
    if (!spaced) continue;

    const s = 0.38 + rng() * 0.55;
    const shade = 0.7 + rng() * 0.35;
    placements.push({
      x,
      z,
      h,
      yaw: rng() * TAU,
      scaleXZ: s * (0.85 + rng() * 0.4),
      scaleY: s * (0.7 + rng() * 0.55),
      tintR: (0.60 + rng() * 0.2) * shade,
      tintG: (0.80 + rng() * 0.22) * shade,
      tintB: (0.54 + rng() * 0.16) * shade,
    });
  }
  return placements;
}

function placeFlowers() {
  const rng = mulberry32(0xf10e5);
  const placements = [];
  let guard = 0;

  while (placements.length < FLOWER_COUNT && guard < 20000) {
    guard += 1;
    const angle = rng() * TAU;
    const coast = coastRadius(angle);
    const inlandMax = Math.min(18, coast - 3);
    if (inlandMax < 5) continue;
    const dist = coast - (5.5 + rng() * (inlandMax - 5.5));
    if (dist < 3) continue;
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    if (Math.abs(x) > WORLD_HALF - 10 || Math.abs(z) > WORLD_HALF - 10) continue;
    const h = heightAt(x, z);
    if (h < 1.05 || h > 6.5) continue;
    const ldx = x - LIGHTHOUSE_SITE.x;
    const ldz = z - LIGHTHOUSE_SITE.z;
    if (ldx * ldx + ldz * ldz < 121) continue;
    if (terrainGradient(x, z, h, 0.55) > 1.0) continue;

    let spaced = true;
    for (let i = 0; i < placements.length; i++) {
      const dx = x - placements[i].x;
      const dz = z - placements[i].z;
      if (dx * dx + dz * dz < 0.75) {
        spaced = false;
        break;
      }
    }
    if (!spaced) continue;

    // Four soft wildflower tints (white / butter yellow / rose / pale lilac).
    const kind = Math.floor(rng() * 4);
    const s = 0.8 + rng() * 0.5;
    let tr = 1.0;
    let tg = 0.96;
    let tb = 0.88;
    if (kind === 1) { tr = 1.22; tg = 1.02; tb = 0.5; }
    else if (kind === 2) { tr = 1.16; tg = 0.74; tb = 0.78; }
    else if (kind === 3) { tr = 0.9; tg = 0.84; tb = 1.15; }

    placements.push({
      x,
      z,
      h,
      yaw: rng() * TAU,
      scaleXZ: s,
      scaleY: s * (0.9 + rng() * 0.3),
      tintR: tr,
      tintG: tg,
      tintB: tb,
    });
  }

  return placements;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Build all vegetation, add it to `scene`, and return the shared update handle.
 */
export function createVegetation(scene) {
  const group = new THREE.Group();
  group.name = 'vegetation';

  // Uniform objects shared by every vegetation material: updating
  // `.value` here updates every compiled shader in one place.
  const uniforms = {
    uTime: { value: 0 },
    uWindStrength: { value: 0.35 },
    uWindDir: { value: new THREE.Vector2(1, 0.35).normalize() },
    uStorm: { value: 0 },
    uTransColor: { value: new THREE.Color(0.10, 0.085, 0.055) },
  };

  const palmMaterials = createPalmMaterials(uniforms);
  const palmDepthMaterial = createPalmDepthMaterial(uniforms);
  const groundMaterial = createGroundMaterial(uniforms);

  // -- palms ----------------------------------------------------------------
  const palmSites = placePalmSites();
  const palms = createPalmMeshes(palmSites, palmMaterials, palmDepthMaterial);
  for (const palm of palms) group.add(palm);

  const palmShadows = createPalmContactShadows(palmSites);
  if (palmShadows) group.add(palmShadows);

  // -- grass ----------------------------------------------------------------
  const grassPlacements = placeGrass(palmSites);
  const grassGeometry = createGrassGeometry();
  const grassMesh = createInstancedMesh(
    grassGeometry,
    groundMaterial,
    grassPlacements,
    'grass',
    false,
  );
  group.add(grassMesh);

  // -- shrubs & wildflowers (cheap, same material / same wind) --------------
  const shrubPlacements = placeShrubs();
  const shrubGeometry = createBushGeometry();
  const shrubMesh = createInstancedMesh(
    shrubGeometry,
    groundMaterial,
    shrubPlacements,
    'shrubs',
    false,
  );
  group.add(shrubMesh);

  // Upper-mountain scrub hides the otherwise bare summit and gives the ridge a
  // dark, textured silhouette against the sky.
  const mountainScrubPlacements = placeMountainScrub();
  const mountainScrubMesh = createInstancedMesh(
    shrubGeometry,
    groundMaterial,
    mountainScrubPlacements,
    'mountainScrub',
    false,
  );
  group.add(mountainScrubMesh);

  const flowerPlacements = placeFlowers();
  const flowerGeometry = createFlowerGeometry();
  const flowerMesh = createInstancedMesh(
    flowerGeometry,
    groundMaterial,
    flowerPlacements,
    'wildflowers',
    false,
  );
  group.add(flowerMesh);

  if (scene && typeof scene.add === 'function') scene.add(group);

  const palmCount = palms.length;
  const grassCount = grassPlacements.length;

  // -- per-frame update: uniform writes only, zero allocations --------------
  let elapsed = 0;
  const windDir = uniforms.uWindDir.value;
  const transColor = uniforms.uTransColor.value;

  function update(dt, env) {
    const step = dt > 0 ? (dt < 0.1 ? dt : 0.1) : 0;
    elapsed += step;
    uniforms.uTime.value = elapsed;

    if (!env) return;

    const strength = env.windStrength;
    uniforms.uWindStrength.value = Number.isFinite(strength)
      ? THREE.MathUtils.clamp(strength, 0, 2)
      : 0.35;

    const dir = env.windDir;
    if (dir && (dir.x !== 0 || dir.y !== 0)) {
      windDir.set(dir.x, dir.y);
      const len = Math.hypot(windDir.x, windDir.y) || 1;
      windDir.x /= len;
      windDir.y /= len;
    }

    const storm = env.stormMix;
    uniforms.uStorm.value = Number.isFinite(storm)
      ? THREE.MathUtils.clamp(storm, 0, 1.5)
      : 0;

    // Faked leaf translucency follows the sun and fades at night / in storms.
    const day = Number.isFinite(env.dayFactor) ? env.dayFactor : 1;
    const sun = env.sunColor || C.glint;
    const trans = 0.10 * (0.30 + 0.70 * day) * (1 - 0.45 * uniforms.uStorm.value);
    transColor.setRGB(sun.r * trans, sun.g * trans, sun.b * trans);
  }

  return {
    group,
    update,
    palmCount,
    grassCount,
  };
}
