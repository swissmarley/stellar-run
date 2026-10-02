import * as THREE from 'three';

/**
 * Hand-written shader materials. Colours are authored and output in display (sRGB) space: three's colour
 * management is disabled in renderer.ts, so no conversions happen anywhere (cheap and predictable).
 */

/** Uniforms shared by every lit material (biome lighting and fog); updated once per frame. */
export const SHARED = {
  uTime: { value: 0 },
  uLightDir: { value: new THREE.Vector3(0.35, 0.8, 0.45).normalize() },
  uLightColor: { value: new THREE.Color(0xffffff) },
  uAmbient: { value: new THREE.Color(0x303040) },
  uFogColor: { value: new THREE.Color(0x101018) },
  uFogNear: { value: 60 },
  uFogFar: { value: 240 },
  uRimColor: { value: new THREE.Color(0xd55e00) },
  uPhase: { value: 0 },
};

const LIT_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aGlow;
uniform float uTime;
uniform float uFogNear;
uniform float uFogFar;
uniform float uSpin;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
varying float vGlow;
varying float vFog;
varying float vDepth;

mat3 axisRot(vec3 axis, float a) {
  float s = sin(a), c = cos(a), oc = 1.0 - c;
  return mat3(oc*axis.x*axis.x + c, oc*axis.x*axis.y + axis.z*s, oc*axis.z*axis.x - axis.y*s,
              oc*axis.x*axis.y - axis.z*s, oc*axis.y*axis.y + c, oc*axis.y*axis.z + axis.x*s,
              oc*axis.z*axis.x + axis.y*s, oc*axis.y*axis.z - axis.x*s, oc*axis.z*axis.z + c);
}

void main() {
  mat4 im = mat4(1.0);
#ifdef USE_INSTANCING
  im = instanceMatrix;
#endif
  vec3 p = position;
  vec3 n = normal;
  if (uSpin > 0.0) {
    vec3 t = im[3].xyz;
    float h = fract(sin(dot(t, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    vec3 axis = normalize(vec3(h - 0.5, 1.0 - h, 0.4 + h));
    mat3 R = axisRot(axis, uTime * uSpin * (0.35 + h) + h * 6.2831);
    p = R * p;
    n = R * n;
  }
  vec4 world = modelMatrix * im * vec4(p, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * mat3(im) * n);
  vColor = aColor;
  vGlow = aGlow;
  vec4 mv = viewMatrix * world;
  vFog = smoothstep(uFogNear, uFogFar, -mv.z);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const LIT_FRAG = /* glsl */ `
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform vec3 uBody;
uniform vec3 uGlowColor;
uniform vec3 uRimColor;
uniform float uRimStrength;
uniform float uRimPower;
uniform float uFlat;
uniform float uOpacity;
uniform float uNearCut;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
varying float vGlow;
varying float vFog;
varying float vDepth;

// Interleaved gradient noise (Jimenez 2014): objects passing the lens dissolve instead of filling the screen.
float dither(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void main() {
  if (uNearCut > 0.0 && smoothstep(uNearCut, uNearCut + 2.5, vDepth) <= dither(gl_FragCoord.xy)) discard;
  vec3 n = normalize(vNormal);
  if (uFlat > 0.5) n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  vec3 v = normalize(cameraPosition - vWorld);
  if (dot(n, v) < 0.0 && uFlat < 0.5) n = -n;
  float diff = max(dot(n, uLightDir), 0.0);
  float rim = pow(1.0 - clamp(abs(dot(n, v)), 0.0, 1.0), uRimPower);
  vec3 lit = uBody * vColor * (uAmbient + uLightColor * diff);
  vec3 col = mix(lit, uGlowColor * (0.75 + 0.25 * vColor), vGlow);
  col += uRimColor * rim * uRimStrength;
  col = mix(col, uFogColor, vFog);
  gl_FragColor = vec4(col, uOpacity);
}
`;

export interface LitOptions {
  body: number;
  glow?: number;
  rim?: number;
  rimStrength?: number;
  rimPower?: number;
  flat?: boolean;
  spin?: number;
  transparent?: boolean;
  opacity?: number;
  /** Fragments closer than this to the camera dissolve (0 disables; the player ship uses 0). */
  nearCut?: number;
}

export type LitMaterial = THREE.ShaderMaterial & {
  uniforms: {
    uBody: { value: THREE.Color };
    uGlowColor: { value: THREE.Color };
    uRimColor: { value: THREE.Color };
    uRimStrength: { value: number };
    uOpacity: { value: number };
    uSpin: { value: number };
  };
};

/** Lit, fogged, rim-lit material used by every solid object (instanced or not). */
export function litMaterial(o: LitOptions): LitMaterial {
  const m = new THREE.ShaderMaterial({
    vertexShader: LIT_VERT,
    fragmentShader: LIT_FRAG,
    uniforms: {
      uTime: SHARED.uTime,
      uLightDir: SHARED.uLightDir,
      uLightColor: SHARED.uLightColor,
      uAmbient: SHARED.uAmbient,
      uFogColor: SHARED.uFogColor,
      uFogNear: SHARED.uFogNear,
      uFogFar: SHARED.uFogFar,
      uBody: { value: new THREE.Color(o.body) },
      uGlowColor: { value: new THREE.Color(o.glow ?? 0xffffff) },
      uRimColor: o.rim === undefined ? SHARED.uRimColor : { value: new THREE.Color(o.rim) },
      uRimStrength: { value: o.rimStrength ?? 0.9 },
      uRimPower: { value: o.rimPower ?? 2.2 },
      uFlat: { value: o.flat ? 1 : 0 },
      uSpin: { value: o.spin ?? 0 },
      uOpacity: { value: o.opacity ?? 1 },
      uNearCut: { value: o.nearCut ?? 2.5 },
    },
    transparent: o.transparent ?? false,
  });
  return m as LitMaterial;
}

const GLOW_VERT = /* glsl */ `
uniform float uFogNear;
uniform float uFogFar;
varying vec2 vUv;
varying float vFog;
void main() {
  mat4 im = mat4(1.0);
#ifdef USE_INSTANCING
  im = instanceMatrix;
#endif
  vUv = uv;
  // Camera-facing billboard: offset in view space by the instance/model scale.
  vec4 centre = viewMatrix * modelMatrix * im * vec4(0.0, 0.0, 0.0, 1.0);
  float sx = length((modelMatrix * im)[0].xyz);
  vec4 mv = centre + vec4(position.xy * sx, 0.0, 0.0);
  vFog = smoothstep(uFogNear, uFogFar, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const GLOW_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vUv;
varying float vFog;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.0, d);
  a = a * a * uIntensity * (1.0 - vFog);
  gl_FragColor = vec4(uColor * a, a);
}
`;

export type GlowMaterial = THREE.ShaderMaterial & {
  uniforms: { uColor: { value: THREE.Color }; uIntensity: { value: number } };
};

/** Additive radial glow billboard (engine flames, halos). */
export function glowMaterial(color: number, intensity = 1): GlowMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: intensity },
      uFogNear: SHARED.uFogNear,
      uFogFar: SHARED.uFogFar,
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }) as GlowMaterial;
}
