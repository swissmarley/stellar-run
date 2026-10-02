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
