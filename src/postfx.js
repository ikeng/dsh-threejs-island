import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

/**
 * ACES filmic output with a physical-ish bloom, a linear colour-grade pass and
 * a light finishing pass (radial chromatic aberration, vignette, grain, dither).
 *
 * Pass order:
 *   scene (HDR linear) -> bloom -> grade -> ACES + sRGB -> finish (display space)
 */

const GradeShader = {
  name: 'IslaGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uStorm: { value: 0 },
    uNight: { value: 0 },
    uDay: { value: 1 },
    uLightning: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uStorm;
    uniform float uNight;
    uniform float uDay;
    uniform float uLightning;
    varying vec2 vUv;

    void main() {
      vec3 raw = texture2D(tDiffuse, vUv).rgb;
      float luma = dot(raw, vec3(0.2126, 0.7152, 0.0722));
      vec3 c = raw;

      // --- filmic split toning (cool, slightly green shadows; warm highlights) ---
      vec3 shadowTint = mix(vec3(0.93, 0.985, 1.05), vec3(0.9, 0.97, 1.04), uStorm);
      vec3 highlightTint = mix(vec3(1.055, 1.005, 0.925), vec3(1.0, 0.99, 0.965), uStorm);
      c *= mix(shadowTint, highlightTint, smoothstep(0.05, 0.85, luma));

      // saturation: keep the HDR highlight ratios intact while enriching mids
      c = mix(vec3(luma), c, 1.115 + 0.035 * uDay - 0.08 * uStorm);
      c = mix(c, c * vec3(0.86, 0.935, 1.02), 0.34 * uStorm);

      // storm/dawn/ dusk tint and a soft shoulder lift in the shadows
      c += (1.0 - smoothstep(0.0, 0.35, luma)) * vec3(0.0035, 0.005, 0.008) * (0.5 + uNight);
      c += uLightning * vec3(0.16, 0.21, 0.32);

      // gentle lens vignette in linear space
      vec2 centered = (vUv - 0.5) * vec2(uResolution.x / max(uResolution.y, 1.0), 1.0);
      float edge = smoothstep(0.28, 0.92, length(centered));
      c *= 1.0 - edge * (0.16 + 0.05 * uStorm);

      gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
    }
  `,
};

const FinishShader = {
  name: 'IslaFinishShader',
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uGrain: { value: 0.045 },
    uVignette: { value: 0.36 },
    uStorm: { value: 0 },
    uNight: { value: 0 },
    uLightning: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uGrain;
    uniform float uVignette;
    uniform float uStorm;
    uniform float uNight;
    uniform float uLightning;
    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = vUv;
      vec2 d = uv - 0.5;
      float r2 = dot(d, d);

      // radial chromatic aberration, slightly stronger in storm/night
      float ca = (0.00055 + 0.0011 * uStorm + 0.00035 * uNight) * smoothstep(0.0, 0.55, r2);
      vec3 c;
      c.r = texture2D(tDiffuse, uv + d * ca).r;
      c.g = texture2D(tDiffuse, uv).g;
      c.b = texture2D(tDiffuse, uv - d * ca).b;

      // lens vignette
      float vig = smoothstep(0.97, 0.26, length(d * vec2(1.0, 1.03)));
      c *= mix(1.0, vig, uVignette);

      // display-space film grain: strongest in the midtones
      vec2 grainUv = uv * uResolution;
      float n = hash12(grainUv + fract(uTime * 0.91) * 517.0) - 0.5;
      float midtone = 1.0 - abs(dot(c, vec3(0.333)) * 2.0 - 1.0);
      c += n * uGrain * (0.35 + 0.65 * midtone);

      // gentle display-space contrast + barely-there lifted blacks
      c = (c - 0.5) * 1.075 + 0.5;
      c = c * 0.996 + 0.0035;
      c += smoothstep(0.72, 1.0, c.g) * vec3(0.007, 0.003, -0.002);

      // lightning flash on the exposed frame
      c += uLightning * 0.035;

      // ordered-ish dither to prevent sky banding
      float dither = hash12(uv * uResolution + 13.7) / 255.0;
      c += (dither - 0.5 / 255.0);

      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
  `,
};

function makeComposerTarget(renderer, samples) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(
    Math.max(1, size.x),
    Math.max(1, size.y),
    {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      samples,
    },
  );
  target.texture.name = 'Isla.Composer';
  target.texture.colorSpace = THREE.NoColorSpace;
  return target;
}

export function createPostFX(renderer, scene, camera) {
  // MSAA render targets cause sampler conflicts on some ANGLE/Metal setups
  // (and we do our own finishing pass anyway), so the composer stays single-sample.
  const samples = 0;

  const composer = new EffectComposer(renderer, makeComposerTarget(renderer, samples));
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(window.innerWidth, window.innerHeight);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.48,
    0.72,
    0.82,
  );
  bloomPass.threshold = 0.82;
  bloomPass.strength = 0.48;
  bloomPass.radius = 0.72;
  composer.addPass(bloomPass);

  const gradePass = new ShaderPass(GradeShader);
  gradePass.uniforms.uResolution.value.set(
    renderer.domElement.width,
    renderer.domElement.height,
  );
  composer.addPass(gradePass);

  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  const finishPass = new ShaderPass(FinishShader);
  finishPass.uniforms.uResolution.value.set(
    renderer.domElement.width,
    renderer.domElement.height,
  );
  composer.addPass(finishPass);

  // Final anti-aliasing on the display-space image (the scene targets stay
  // single-sampled because MSAA + HDR targets are unreliable on ANGLE/Metal).
  const smaaPass = new SMAAPass();
  composer.addPass(smaaPass);

  let time = 0;

  function updateResolution() {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    gradePass.uniforms.uResolution.value.copy(size);
    finishPass.uniforms.uResolution.value.copy(size);
  }

  function setSize(width, height, pixelRatio = renderer.getPixelRatio()) {
    composer.setPixelRatio(pixelRatio);
    composer.setSize(width, height);
    updateResolution();
  }

  function update(dt, env) {
    time += dt;
    gradePass.uniforms.uTime.value = time;
    gradePass.uniforms.uStorm.value = env.stormMix;
    gradePass.uniforms.uNight.value = env.nightFactor;
    gradePass.uniforms.uDay.value = env.dayFactor;
    gradePass.uniforms.uLightning.value = env.lightning;

    finishPass.uniforms.uTime.value = time;
    finishPass.uniforms.uStorm.value = env.stormMix;
    finishPass.uniforms.uNight.value = env.nightFactor;
    finishPass.uniforms.uLightning.value = env.lightning;
    finishPass.uniforms.uGrain.value = 0.030 + env.stormMix * 0.022 + env.nightFactor * 0.014;
    finishPass.uniforms.uVignette.value = 0.34 + env.nightFactor * 0.12 + env.stormMix * 0.07;

    bloomPass.strength = env.bloomStrength ?? 0.48;
    bloomPass.threshold = env.bloomThreshold ?? 0.82;
    bloomPass.radius = 0.72 + env.nightFactor * 0.12;

    renderer.toneMappingExposure = env.exposure ?? 1;
  }

  function render(dt) {
    composer.render(dt);
  }

  return {
    composer,
    bloomPass,
    renderPass,
    update,
    render,
    setSize,
    updateResolution,
  };
}
