import * as THREE from 'three';
import { SHARED } from './materials.ts';

/**
 * GPU particle pool. Each burst writes its particles' start state once (position in track space, velocity,
 * birth time, life, colour, size) into a ring of attributes; the vertex shader integrates motion, so a frame
 * costs nothing on the CPU. Positions are in track space (x, y, s) and rendered relative to the ship
 * (floating origin), exactly like obstacles.
 */

const VERT = /* glsl */ `
attribute vec3 aVel;
attribute vec2 aLife;
attribute vec3 aColor;
attribute float aSize;
uniform float uTime;
uniform float uShipS;
uniform float uScale;
uniform float uDrag;
varying vec3 vColor;
varying float vFade;
void main() {
  float t = uTime - aLife.x;
  if (t < 0.0 || t > aLife.y) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vFade = 0.0;
    return;
  }
  float k = (1.0 - exp(-uDrag * t)) / uDrag;
  vec3 p = position + aVel * k;
  vec4 mv = viewMatrix * vec4(p.x, p.y, -(p.z - uShipS), 1.0);
  float life = t / aLife.y;
  vFade = 1.0 - life;
  vColor = aColor;
  gl_PointSize = aSize * uScale * (1.0 - life * 0.6) / max(0.5, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vFade;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.1, d) * vFade;
  gl_FragColor = vec4(vColor * a, a);
}
`;

const tmpColor = new THREE.Color();

function upload(attr: THREE.BufferAttribute, width: number, from: number, count: number): void {
  attr.clearUpdateRanges();
  attr.addUpdateRange(from * width, count * width);
  attr.needsUpdate = true;
}

export class Particles {
  readonly points: THREE.Points;
  readonly capacity: number;
  private head = 0;
  private readonly pos: THREE.BufferAttribute;
  private readonly vel: THREE.BufferAttribute;
  private readonly life: THREE.BufferAttribute;
  private readonly col: THREE.BufferAttribute;
  private readonly size: THREE.BufferAttribute;
  readonly uniforms = {
    uTime: { value: 0 },
    uShipS: { value: 0 },
    uScale: { value: 300 },
    uDrag: { value: 2.2 },
  };
  /** Seed for the cosmetic jitter (presentation only). */
  private seed = 1;
  /** Total particles emitted (pool test instrumentation). */
  emitted = 0;

  constructor(capacity = 1024) {
    this.capacity = capacity;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.vel = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    const lifeArr = new Float32Array(capacity * 2);
    for (let i = 0; i < capacity; i++) lifeArr[i * 2] = -1e9;
    this.life = new THREE.BufferAttribute(lifeArr, 2);
    this.col = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.size = new THREE.BufferAttribute(new Float32Array(capacity), 1);
    for (const a of [this.pos, this.vel, this.life, this.col, this.size]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('aVel', this.vel);
    g.setAttribute('aLife', this.life);
    g.setAttribute('aColor', this.col);
    g.setAttribute('aSize', this.size);
    const m = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { ...this.uniforms, uFogNear: SHARED.uFogNear },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 8;
  }

  private rnd(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  setTime(t: number, shipS: number, pixelScale: number): void {
    this.uniforms.uTime.value = t;
    this.uniforms.uShipS.value = shipS;
    this.uniforms.uScale.value = pixelScale;
  }

  /**
   * Emits `n` particles at (x, y, s) with random directions. `speed` m/s, `forward` adds along-track velocity
   * (positive = ahead of the ship), `spread` 0..1 flattens into a lateral ring when 0.
   */
  burst(
    n: number,
    x: number,
    y: number,
    s: number,
    speed: number,
    forward: number,
    life: number,
    color: number,
    size: number,
    ring = false,
  ): void {
    const start = this.head;
    const t0 = this.uniforms.uTime.value;
    tmpColor.setHex(color);
    const P = this.pos.array as Float32Array;
    const V = this.vel.array as Float32Array;
    const L = this.life.array as Float32Array;
    const C = this.col.array as Float32Array;
    const S = this.size.array as Float32Array;
    for (let k = 0; k < n; k++) {
      const i = this.head;
      this.head = (this.head + 1) % this.capacity;
      const a = this.rnd() * Math.PI * 2;
      const zc = ring ? (this.rnd() - 0.5) * 0.2 : this.rnd() * 2 - 1;
      const rr = Math.sqrt(1 - zc * zc);
      const sp = speed * (0.35 + 0.65 * this.rnd());
      P[i * 3] = x;
      P[i * 3 + 1] = y;
      P[i * 3 + 2] = s;
      V[i * 3] = Math.cos(a) * rr * sp;
      V[i * 3 + 1] = Math.sin(a) * rr * sp;
      V[i * 3 + 2] = zc * sp + forward;
      L[i * 2] = t0;
      L[i * 2 + 1] = life * (0.6 + 0.4 * this.rnd());
      const tint = 0.75 + 0.25 * this.rnd();
      C[i * 3] = tmpColor.r * tint;
      C[i * 3 + 1] = tmpColor.g * tint;
      C[i * 3 + 2] = tmpColor.b * tint;
      S[i] = size * (0.6 + 0.8 * this.rnd());
    }
    this.emitted += n;
    // Upload only the touched range (handles ring wrap-around by uploading everything in that case).
    const count = n >= this.capacity || start + n > this.capacity ? this.capacity : n;
    const from = count === this.capacity ? 0 : start;
    upload(this.pos, 3, from, count);
    upload(this.vel, 3, from, count);
    upload(this.life, 2, from, count);
    upload(this.col, 3, from, count);
    upload(this.size, 1, from, count);
  }

  /** Hides every live particle (new run). */
  clear(): void {
    const L = this.life.array as Float32Array;
    for (let i = 0; i < this.capacity; i++) L[i * 2] = -1e9;
    this.life.clearUpdateRanges();
    this.life.needsUpdate = true;
  }
}
