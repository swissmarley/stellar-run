import * as THREE from 'three';

/**
 * Lightweight post pipeline (no three/examples composer): scene → MSAA target → bright pass → separable
 * blur at quarter resolution → composite with per-biome colour grading, vignette and an accessibility-safe
 * flash. With `bloom` and `grade` both off the scene renders straight to the screen (low tier).
 */

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  float w = smoothstep(uThreshold, uThreshold + 0.25, l);
  gl_FragColor = vec4(c * w, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  // 9-tap Gaussian folded into 5 bilinear fetches.
  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270;
  c += texture2D(tSrc, vUv + uDir * 1.3846154).rgb * 0.3162162;
  c += texture2D(tSrc, vUv - uDir * 1.3846154).rgb * 0.3162162;
  c += texture2D(tSrc, vUv + uDir * 3.2307692).rgb * 0.0702703;
  c += texture2D(tSrc, vUv - uDir * 3.2307692).rgb * 0.0702703;
  gl_FragColor = vec4(c, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tMain;
uniform sampler2D tBloom;
uniform float uBloom;
uniform float uGradeOn;
uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;
uniform float uSat;
uniform float uContrast;
uniform float uVignette;
uniform vec3 uFlashColor;
uniform float uFlash;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tMain, vUv).rgb + texture2D(tBloom, vUv).rgb * uBloom;
  if (uGradeOn > 0.5) {
    c = c * uGain + uLift * (1.0 - c);
    c = pow(max(c, vec3(0.0)), 1.0 / uGamma);
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l), c, uSat);
    c = (c - 0.5) * uContrast + 0.5;
    vec2 q = vUv - 0.5;
    float v = smoothstep(0.85, 0.25, length(q * vec2(1.0, 0.75)));
    c *= mix(1.0, v, uVignette);
  }
  c = mix(c, uFlashColor, uFlash);
  gl_FragColor = vec4(c, 1.0);
}
`;

export interface PostOptions {
  bloom: boolean;
  grade: boolean;
  msaa: number;
}

export class PostFX {
  options: PostOptions = { bloom: true, grade: true, msaa: 4 };
  private main: THREE.WebGLRenderTarget | null = null;
  private a: THREE.WebGLRenderTarget | null = null;
  private b: THREE.WebGLRenderTarget | null = null;
  private readonly quad: THREE.Mesh;
  private readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly bright: THREE.ShaderMaterial;
  private readonly blur: THREE.ShaderMaterial;
  private readonly composite: THREE.ShaderMaterial;
  private w = 1;
  private h = 1;
  readonly grading = {
    uLift: { value: new THREE.Vector3(0, 0, 0) },
    uGamma: { value: new THREE.Vector3(1, 1, 1) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uSat: { value: 1 },
    uContrast: { value: 1 },
    uVignette: { value: 0.35 },
    uFlashColor: { value: new THREE.Color(0xffffff) },
    uFlash: { value: 0 },
    uBloom: { value: 0.9 },
  };

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this.bright = new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: BRIGHT_FRAG,
      uniforms: { tSrc: { value: null }, uThreshold: { value: 0.72 } },
      depthTest: false,
      depthWrite: false,
    });
    this.blur = new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
      depthTest: false,
      depthWrite: false,
    });
    this.composite = new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: { tMain: { value: null }, tBloom: { value: null }, uGradeOn: { value: 1 }, ...this.grading },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(g, this.composite);
    this.quad.frustumCulled = false;
  }

  get active(): boolean {
    return this.options.bloom || this.options.grade;
  }

  configure(o: PostOptions): void {
    const changed = o.msaa !== this.options.msaa;
    this.options = { ...o };
    if (changed) this.dispose();
  }

  setSize(w: number, h: number): void {
    this.w = Math.max(1, Math.floor(w));
    this.h = Math.max(1, Math.floor(h));
    if (this.main) {
      this.main.setSize(this.w, this.h);
      this.a!.setSize(Math.max(1, this.w >> 2), Math.max(1, this.h >> 2));
      this.b!.setSize(Math.max(1, this.w >> 2), Math.max(1, this.h >> 2));
    }
  }

  private ensure(): void {
    if (this.main) return;
    const opts = { depthBuffer: false, stencilBuffer: false, type: THREE.UnsignedByteType };
    this.main = new THREE.WebGLRenderTarget(this.w, this.h, {
      samples: this.options.msaa,
      type: THREE.UnsignedByteType,
    });
    this.a = new THREE.WebGLRenderTarget(Math.max(1, this.w >> 2), Math.max(1, this.h >> 2), opts);
    this.b = new THREE.WebGLRenderTarget(Math.max(1, this.w >> 2), Math.max(1, this.h >> 2), opts);
  }

  private pass(
    r: THREE.WebGLRenderer,
    m: THREE.ShaderMaterial,
    target: THREE.WebGLRenderTarget | null,
  ): void {
    this.quad.material = m;
    r.setRenderTarget(target);
    r.render(this.quad, this.cam);
  }

  render(r: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    if (!this.active) {
      r.setRenderTarget(null);
      r.render(scene, camera);
      return;
    }
    this.ensure();
    const main = this.main!;
    r.setRenderTarget(main);
    r.render(scene, camera);
    const cu = this.composite.uniforms;
    cu.tMain!.value = main.texture;
    cu.uGradeOn!.value = this.options.grade ? 1 : 0;
    if (this.options.bloom) {
      const a = this.a!;
      const b = this.b!;
      this.bright.uniforms.tSrc!.value = main.texture;
      this.pass(r, this.bright, a);
      const bu = this.blur.uniforms;
      const dir = bu.uDir!.value as THREE.Vector2;
      for (let i = 0; i < 2; i++) {
        bu.tSrc!.value = a.texture;
        dir.set((1 + i) / a.width, 0);
        this.pass(r, this.blur, b);
        bu.tSrc!.value = b.texture;
        dir.set(0, (1 + i) / a.height);
        this.pass(r, this.blur, a);
      }
      cu.tBloom!.value = a.texture;
    } else {
      cu.tBloom!.value = main.texture;
    }
    const bloomStrength = this.grading.uBloom.value;
    if (!this.options.bloom) this.grading.uBloom.value = 0;
    this.pass(r, this.composite, null);
    this.grading.uBloom.value = bloomStrength;
  }

  dispose(): void {
    this.main?.dispose();
    this.a?.dispose();
    this.b?.dispose();
    this.main = null;
    this.a = null;
    this.b = null;
  }
}
