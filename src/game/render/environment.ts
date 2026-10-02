import * as THREE from 'three';
import { HALF_H, HALF_W } from '../../data/tuning.ts';
import { type GlowMaterial, glowMaterial } from './materials.ts';

const RAIL_STEP = 12;
const RAIL_COUNT = 28;

/** Corridor guide beacons at the four edges of the flight corridor. Static instances; one group offset per frame. */
export class Rails {
  readonly root = new THREE.Group();
  readonly material: GlowMaterial;

  constructor() {
    this.material = glowMaterial(0xe69f00, 0.9);
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.material, RAIL_COUNT * 4);
    const m = new THREE.Matrix4();
    let k = 0;
    for (let i = 0; i < RAIL_COUNT; i++) {
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const) {
        m.makeScale(0.55, 0.55, 0.55).setPosition(
          sx * (HALF_W + 0.6),
          sy * (HALF_H + 0.6),
          -i * RAIL_STEP + RAIL_STEP,
        );
        mesh.setMatrixAt(k++, m);
      }
    }
    mesh.frustumCulled = false;
    this.root.add(mesh);
  }

  update(shipS: number): void {
    this.root.position.z = shipS % RAIL_STEP;
  }
}

/** Distant star field that rides with the camera (infinitely far). */
export class Stars {
  readonly points: THREE.Points;

  constructor(count = 900) {
    const pos = new Float32Array(count * 3);
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      const u = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos[i * 3] = r * Math.cos(th) * 450;
      pos[i * 3 + 1] = u * 450;
      pos[i * 3 + 2] = r * Math.sin(th) * 450;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = -10;
  }

  follow(camera: THREE.Camera): void {
    this.points.position.copy(camera.position);
  }
}
