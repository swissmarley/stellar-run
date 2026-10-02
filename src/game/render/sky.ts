import * as THREE from 'three';

/**
 * Procedural nebula sky: a camera-centred sphere sampling a tileable fBm texture baked once at boot (three
 * layers with different scales and parallax), plus hash-based stars. No image assets; the palette comes from
 * the biome and is tweened by the game.
 */

function hash2(x: number, y: number, seed: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

/** Tileable value-noise fBm in [0,1] (period `size` in both axes). */
function fbm(size: number, seed: number, octaves: number, base: number): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 0.5;
  let freq = base;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = freq;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells;
        const fy = (y / size) * cells;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const x1 = (x0 + 1) % cells;
        const y1 = (y0 + 1) % cells;
        const a = hash2(x0, y0, seed + o);
        const b = hash2(x1, y0, seed + o);
        const c = hash2(x0, y1, seed + o);
        const d = hash2(x1, y1, seed + o);
        out[y * size + x]! += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
      }
    }
    total += amp;
    amp *= 0.5;
    freq *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / total;
  return out;
}

export function bakeNoiseTexture(size = 256): THREE.DataTexture {
  const r = fbm(size, 1, 5, 4);
  const g = fbm(size, 9, 5, 8);
  const b = fbm(size, 17, 4, 16);
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = Math.round(r[i]! * 255);
    data[i * 4 + 1] = Math.round(g[i]! * 255);
    data[i * 4 + 2] = Math.round(b[i]! * 255);
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w; // at the far plane
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform vec3 uFog;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform vec3 uStars;
uniform vec2 uParallax;
uniform float uTime;
uniform float uDetail;
varying vec3 vDir;

float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5453); }

void main() {
  vec3 d = normalize(vDir);
  vec2 uv = vec2(atan(d.x, -d.z) * 0.15915494, d.y * 0.5 + 0.5);
  float n1 = texture2D(uNoise, uv * vec2(2.0, 1.0) + uParallax * 0.004 + vec2(uTime * 0.0015, 0.0)).r;
  float n2 = texture2D(uNoise, uv * vec2(3.0, 1.5) + uParallax * 0.010 - vec2(uTime * 0.0025, 0.0)).g;
  vec3 col = uFog * 0.85;
  col = mix(col, uColA, smoothstep(0.42, 0.85, n1) * 0.55);
  col = mix(col, uColB, smoothstep(0.45, 0.9, n2) * 0.5);
  if (uDetail > 0.5) {
    float n3 = texture2D(uNoise, uv * vec2(6.0, 3.0) + uParallax * 0.02).b;
    col += uColC * pow(smoothstep(0.5, 1.0, n3 * (0.6 + n1)), 2.0) * 0.35;
  }
  // Stars: one candidate per cell, brightness twinkles slowly.
  vec2 sp = uv * vec2(720.0, 360.0);
  vec2 cell = floor(sp);
  float h = hash(cell);
  float star = step(0.992, h) * smoothstep(0.42, 0.0, length(fract(sp) - 0.5));
  star *= 0.6 + 0.4 * sin(uTime * (1.0 + h * 3.0) + h * 40.0);
  col += uStars * star * (0.6 + 0.8 * fract(h * 97.0));
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly uniforms: {
    uNoise: { value: THREE.Texture };
    uFog: { value: THREE.Color };
    uColA: { value: THREE.Color };
    uColB: { value: THREE.Color };
    uColC: { value: THREE.Color };
    uStars: { value: THREE.Color };
    uParallax: { value: THREE.Vector2 };
    uTime: { value: number };
    uDetail: { value: number };
  };

  constructor(noise: THREE.Texture) {
    this.uniforms = {
      uNoise: { value: noise },
      uFog: { value: new THREE.Color(0x101018) },
      uColA: { value: new THREE.Color(0x3a1f4a) },
      uColB: { value: new THREE.Color(0x1a2a4a) },
      uColC: { value: new THREE.Color(0x56b4e9) },
      uStars: { value: new THREE.Color(0xffffff) },
      uParallax: { value: new THREE.Vector2() },
      uTime: { value: 0 },
      uDetail: { value: 1 },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(300, 24, 16), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
  }

  follow(camera: THREE.Camera, shipX: number, shipY: number, t: number): void {
    this.mesh.position.copy(camera.position);
    this.uniforms.uParallax.value.set(shipX, shipY);
    this.uniforms.uTime.value = t;
  }
}
