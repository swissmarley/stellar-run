import * as THREE from 'three';
import { SHARED } from './materials.ts';

/**
 * Speed lines: an open cylinder around the flight path with additive streaks scrolled by track distance,
 * and dust motes: instanced camera-facing streaks that wrap around the ship. Both are driven purely by
 * uniforms (no per-frame CPU work besides setting three numbers).
 */

const LINES_VERT = /* glsl */ `
varying vec2 vUv;
varying float vZ;
void main() {
  vUv = uv;
  vZ = position.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const LINES_FRAG = /* glsl */ `
uniform float uScroll;
uniform float uIntensity;
uniform vec3 uColor;
varying vec2 vUv;
varying float vZ;
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  float col = floor(vUv.x * 96.0);
  float h = hash(col);
  float lane = fract(vUv.x * 96.0);
  float width = smoothstep(0.5, 0.0, abs(lane - 0.5) * (2.5 + h * 3.0));
  float v = fract(vUv.y * (2.0 + h * 2.0) + uScroll * (0.8 + h * 0.6) + h * 10.0);
  float streak = smoothstep(0.0, 0.05, v) * smoothstep(0.35 + h * 0.3, 0.05, v);
  float ends = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
  float a = width * streak * ends * uIntensity * step(0.45, h);
  gl_FragColor = vec4(uColor * a, a);
}
`;

export class SpeedLines {
  readonly mesh: THREE.Mesh;
  readonly uniforms = {
    uScroll: { value: 0 },
    uIntensity: { value: 0 },
    uColor: { value: new THREE.Color(0xcfe8ff) },
  };

  constructor() {
    const g = new THREE.CylinderGeometry(7.5, 7.5, 150, 32, 1, true);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, -70);
    const m = new THREE.ShaderMaterial({
      vertexShader: LINES_VERT,
      fragmentShader: LINES_FRAG,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  update(shipS: number, speed01: number, boost01: number, reduced: boolean): void {
    this.uniforms.uScroll.value = shipS / 150;
    const k = reduced ? 0.35 : 1;
    this.uniforms.uIntensity.value = k * (0.12 + 0.55 * speed01 * speed01 + 0.6 * boost01);
  }
}

const DUST_VERT = /* glsl */ `
attribute vec3 aOffset;
uniform float uShipS;
uniform float uLen;
uniform float uWidth;
uniform float uFogNear;
uniform float uFogFar;
varying float vAlpha;
const float SPAN = 140.0;
void main() {
  float z = mod(aOffset.z + uShipS, SPAN) - (SPAN - 12.0);
  vec3 head = vec3(aOffset.xy, z);
  vec3 tail = head + vec3(0.0, 0.0, -uLen);
  vec4 h = viewMatrix * modelMatrix * vec4(head, 1.0);
  vec4 t = viewMatrix * modelMatrix * vec4(tail, 1.0);
  vec2 dir = normalize(h.xy - t.xy + vec2(1e-5, 0.0));
  vec2 side = vec2(-dir.y, dir.x) * uWidth;
  vec4 p = mix(t, h, position.y) + vec4(side * position.x, 0.0, 0.0);
  vAlpha = (1.0 - smoothstep(uFogNear * 0.5, uFogFar * 0.6, -p.z)) * smoothstep(-1.0, 6.0, -p.z);
  gl_Position = projectionMatrix * p;
}
`;

const DUST_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
  float a = vAlpha * uOpacity;
  gl_FragColor = vec4(uColor * a, a);
}
`;

export class Dust {
  readonly mesh: THREE.Mesh;
  readonly uniforms = {
    uShipS: { value: 0 },
    uLen: { value: 0.4 },
    uWidth: { value: 0.03 },
    uColor: { value: new THREE.Color(0xdfe8ff) },
    uOpacity: { value: 0.7 },
    uFogNear: SHARED.uFogNear,
    uFogFar: SHARED.uFogFar,
  };
  private readonly geo: THREE.InstancedBufferGeometry;

  constructor(count = 260) {
    const base = new THREE.PlaneGeometry(2, 1, 1, 1);
    base.translate(0, 0.5, 0);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.attributes.position!);
    const off = new Float32Array(count * 3);
    let seed = 99;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      // Keep motes out of the ship's immediate corridor so they never occlude obstacles.
      let x = 0;
      let y = 0;
      do {
        x = (rnd() * 2 - 1) * 16;
        y = (rnd() * 2 - 1) * 12;
      } while (Math.abs(x) < 2.2 && Math.abs(y) < 1.8);
      off[i * 3] = x;
      off[i * 3 + 1] = y;
      off[i * 3 + 2] = rnd() * 140;
    }
    g.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 3));
    g.instanceCount = count;
    this.geo = g;
    const m = new THREE.ShaderMaterial({
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  setCount(n: number): void {
    this.geo.instanceCount = n;
  }

  update(shipS: number, speed01: number, boost01: number, reduced: boolean): void {
    this.uniforms.uShipS.value = shipS;
    this.uniforms.uLen.value = reduced ? 0.3 : 0.25 + speed01 * 2.2 + boost01 * 3.5;
  }
}
