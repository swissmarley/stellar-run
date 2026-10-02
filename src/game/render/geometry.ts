import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Archetype, ShipDef } from '../../data/types.ts';

/**
 * Procedural placeholder meshes (CC0, generated at boot). Every geometry carries `aColor` (vertex tint)
 * and `aGlow` (0 = lit surface, 1 = unlit glow). Swap any of them for an authored mesh by returning a
 * BufferGeometry with the same two attributes from `archetypeGeometry`.
 */

function paint(g: THREE.BufferGeometry, color: number, glow: number): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const n = geo.attributes.position!.count;
  const c = new THREE.Color(color);
  const col = new Float32Array(n * 3);
  const gl = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
    gl[i] = glow;
  }
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aGlow', new THREE.BufferAttribute(gl, 1));
  for (const k of Object.keys(geo.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'aColor' && k !== 'aGlow' && k !== 'uv')
      geo.deleteAttribute(k);
  }
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return geo;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('mergeGeometries failed');
  g.computeBoundingSphere();
  return g;
}

/** Value noise on the unit sphere, a pure function of position so shared vertices displace identically. */
function hash3(x: number, y: number, z: number, seed: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 19.19) * 43758.5453;
  return h - Math.floor(h);
}

function noise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  let acc = 0;
  for (let dz = 0; dz <= 1; dz++)
    for (let dy = 0; dy <= 1; dy++)
      for (let dx = 0; dx <= 1; dx++) {
        const wt = (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
        acc += wt * hash3(xi + dx, yi + dy, zi + dz, seed);
      }
  return acc;
}

/** Lumpy low-poly rock with max radius 1. */
export function rockGeometry(seed: number, detail: number, roughness: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const pos = g.attributes.position!;
  const p = new THREE.Vector3();
  let maxR = 0;
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).normalize();
    const n1 = noise3(p.x * 1.6, p.y * 1.6, p.z * 1.6, seed);
    const n2 = noise3(p.x * 4.1, p.y * 4.1, p.z * 4.1, seed + 7);
    const r = 1 + roughness * (n1 - 0.5) * 1.6 + roughness * 0.45 * (n2 - 0.5);
    p.multiplyScalar(r);
    pos.setXYZ(i, p.x, p.y * 0.86, p.z);
    maxR = Math.max(maxR, p.length());
  }
  g.scale(1 / maxR, 1 / maxR, 1 / maxR);
  g.computeVertexNormals();
  return paint(g, 0xffffff, 0);
}

/** Unit box (half extents 0.5) with an emissive core stripe. */
function beamGeometry(): THREE.BufferGeometry {
  const shell = paint(new THREE.BoxGeometry(1, 1, 1), 0x8a8f99, 0);
  const core = paint(new THREE.BoxGeometry(1.002, 0.35, 1.02), 0xffffff, 1);
  return merge([shell, core]);
}

function pylonGeometry(): THREE.BufferGeometry {
  const shell = paint(new THREE.BoxGeometry(1, 1, 1), 0x7c828c, 0);
  const core = paint(new THREE.BoxGeometry(0.4, 1.002, 1.02), 0xffffff, 1);
  return merge([shell, core]);
}

function girderGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [paint(new THREE.BoxGeometry(1, 1, 1), 0x8d8a84, 0)];
  // Rivet stripes so the long axis reads at speed.
  for (let k = -2; k <= 2; k++) {
    const stripe = new THREE.BoxGeometry(0.04, 1.01, 1.01);
    stripe.translate(k * 0.2, 0, 0);
    parts.push(paint(stripe, 0x4a4844, 0));
  }
  return merge(parts);
}

function plateGeometry(): THREE.BufferGeometry {
  const plate = paint(new THREE.BoxGeometry(1, 1, 1), 0x9a9fa6, 0);
  const lights = new THREE.BoxGeometry(0.9, 0.06, 1.05);
  lights.translate(0, 0.3, 0);
  return merge([plate, paint(lights, 0xffffff, 1)]);
}

function crateGeometry(): THREE.BufferGeometry {
  const box = paint(new THREE.BoxGeometry(1, 1, 1), 0xb08a5a, 0);
  const band = paint(new THREE.BoxGeometry(1.02, 0.12, 1.02), 0x3a3530, 0);
  return merge([box, band]);
}

function mineGeometry(): THREE.BufferGeometry {
  const core = paint(new THREE.IcosahedronGeometry(0.7, 0), 0x55555c, 0);
  const spikes: THREE.BufferGeometry[] = [core];
  const dirs = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ] as const;
  for (const [x, y, z] of dirs) {
    const s = new THREE.ConeGeometry(0.16, 0.45, 5);
    s.translate(0, 0.78, 0);
    s.lookAt(new THREE.Vector3(x, y, z));
    spikes.push(paint(s, 0xffffff, 1));
  }
  const g = merge(spikes);
  g.scale(1 / 1.0, 1 / 1.0, 1 / 1.0);
  return g;
}

function droneGeometry(): THREE.BufferGeometry {
  const body = paint(new THREE.OctahedronGeometry(0.75, 0), 0x3c3f47, 0);
  const ring = new THREE.TorusGeometry(0.95, 0.09, 4, 16);
  const eye = new THREE.SphereGeometry(0.28, 8, 6);
  eye.translate(0, 0, 0.55);
  return merge([body, paint(ring, 0xffffff, 1), paint(eye, 0xffffff, 1)]);
}

function singularityGeometry(): THREE.BufferGeometry {
  return paint(new THREE.SphereGeometry(1, 24, 16), 0x050307, 0);
}

const cache = new Map<Archetype, THREE.BufferGeometry>();

/** Shared geometry for an archetype. Spheres have radius 1; boxes are unit cubes (scale = full size). */
export function archetypeGeometry(a: Archetype): THREE.BufferGeometry {
  const hit = cache.get(a);
  if (hit) return hit;
  let g: THREE.BufferGeometry;
  switch (a) {
    case 'rock':
      g = rockGeometry(3, 1, 0.32);
      break;
    case 'rockLarge':
      g = rockGeometry(11, 2, 0.3);
      break;
    case 'beam':
      g = beamGeometry();
      break;
    case 'pylon':
      g = pylonGeometry();
      break;
    case 'girder':
      g = girderGeometry();
      break;
    case 'plate':
      g = plateGeometry();
      break;
    case 'crate':
      g = crateGeometry();
      break;
    case 'mine':
      g = mineGeometry();
      break;
    case 'drone':
      g = droneGeometry();
      break;
    case 'singularity':
      g = singularityGeometry();
      break;
  }
  cache.set(a, g);
  return g;
}

/** Pickup shard: a faceted diamond. */
export function shardGeometry(): THREE.BufferGeometry {
  const g = new THREE.OctahedronGeometry(0.42, 0);
  g.scale(0.75, 1.15, 0.75);
  return paint(g, 0xffffff, 0.85);
}

/** Procedural ship mesh from its model parameters (nose points to −Z). */
export function shipGeometry(def: ShipDef): THREE.BufferGeometry {
  const m = def.model;
  const L = m.length;
  const W = m.width;
  const parts: THREE.BufferGeometry[] = [];
  const fuselage = new THREE.ConeGeometry(0.34, L, 6);
  fuselage.rotateX(-Math.PI / 2);
  fuselage.scale(1, 0.62, 1);
  parts.push(paint(fuselage, m.hull, 0));
  const canopy = new THREE.SphereGeometry(0.2, 8, 6);
  canopy.scale(1, 0.7, 1.8);
  canopy.translate(0, 0.16, -0.15);
  parts.push(paint(canopy, 0x1b2733, 0.15));
  // Swept wings: a flattened triangular prism per side.
  for (const side of [-1, 1]) {
    const shape = new THREE.Shape();
    shape.moveTo(0, -0.1);
    shape.lineTo(side * W * 0.5, L * m.wingSweep * 0.5);
    shape.lineTo(side * W * 0.5, L * m.wingSweep * 0.5 + 0.28);
    shape.lineTo(0, L * 0.38);
    const wing = new THREE.ExtrudeGeometry(shape, { depth: 0.07, bevelEnabled: false });
    wing.rotateX(Math.PI / 2);
    wing.translate(0, 0.03, 0);
    parts.push(paint(wing, m.hull, 0));
    const tip = new THREE.BoxGeometry(0.06, 0.06, 0.5);
    tip.translate(side * W * 0.5, 0, L * m.wingSweep * 0.5 + 0.14);
    parts.push(paint(tip, m.trim, 0.6));
  }
  for (let f = 0; f < m.fins; f++) {
    const fin = new THREE.BoxGeometry(0.05, 0.42, 0.55);
    const off = m.fins === 1 ? 0 : (f === 0 ? -1 : 1) * 0.28;
    fin.translate(off, 0.25, L * 0.32);
    parts.push(paint(fin, m.trim, 0));
  }
  const nozzle = new THREE.CylinderGeometry(0.22, 0.28, 0.3, 8);
  nozzle.rotateX(Math.PI / 2);
  nozzle.translate(0, 0, L * 0.5);
  parts.push(paint(nozzle, 0x2a2d33, 0));
  const flame = new THREE.CircleGeometry(0.2, 10);
  flame.translate(0, 0, L * 0.5 + 0.16);
  parts.push(paint(flame, m.engine, 1));
  const g = merge(parts);
  g.computeVertexNormals();
  return g;
}
