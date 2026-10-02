import * as THREE from 'three';
import { type ChunkData, KIND_DRONE, SHAPE_SPHERE } from '../../core/sim/chunk.ts';
import { obstaclePos, posOut } from '../../core/sim/hazards.ts';
import type { RunSim } from '../../core/sim/run-sim.ts';
import { OBSTACLES } from '../../data/obstacles.ts';
import { TUNING } from '../../data/tuning.ts';
import type { Archetype } from '../../data/types.ts';
import { archetypeGeometry, shardGeometry } from './geometry.ts';
import { type LitMaterial, litMaterial } from './materials.ts';

const ARCHETYPES: readonly Archetype[] = [
  'rock',
  'rockLarge',
  'pylon',
  'beam',
  'girder',
  'plate',
  'crate',
  'mine',
  'drone',
  'singularity',
];
const ARCH_INDEX: Record<Archetype, number> = Object.fromEntries(ARCHETYPES.map((a, i) => [a, i])) as Record<
  Archetype,
  number
>;
/** Visual scale per unit of collision radius (spheres): the mesh bulk sits on the hitbox, peaks overhang. */
const SPHERE_VISUAL: Record<Archetype, number> = {
  rock: 1 / 0.86,
  rockLarge: 1 / 0.88,
  mine: 1 / 0.7,
  drone: 1 / 0.75,
  singularity: 1,
  pylon: 1,
  beam: 1,
  girder: 1,
  plate: 1,
  crate: 1,
};

/** Per-archetype materials, shared by every chunk slot. Colours are retinted per biome by the FX layer. */
export class WorldMaterials {
  readonly byArch: LitMaterial[];
  readonly shard: LitMaterial;

  constructor() {
    this.byArch = ARCHETYPES.map((a): LitMaterial => {
      switch (a) {
        case 'rock':
          return litMaterial({ body: 0x8a776a, flat: true, spin: 0.3, rimStrength: 0.85 });
        case 'rockLarge':
          return litMaterial({ body: 0x7d6c62, flat: true, spin: 0.08, rimStrength: 0.8 });
        case 'beam':
        case 'pylon':
          return litMaterial({ body: 0x9aa0aa, glow: 0xe69f00, flat: true, rimStrength: 0.7 });
        case 'girder':
          return litMaterial({ body: 0xa09a90, flat: true, rimStrength: 0.75 });
        case 'plate':
          return litMaterial({ body: 0xa3a8ae, glow: 0xdff7ee, flat: true, rimStrength: 0.7 });
        case 'crate':
          return litMaterial({ body: 0xc29a66, flat: true, spin: 0.4, rimStrength: 0.75 });
        case 'mine':
          return litMaterial({ body: 0x5a5a62, glow: 0xd55e00, flat: true, spin: 0.6, rimStrength: 0.9 });
        case 'drone':
          return litMaterial({ body: 0x4a4e58, glow: 0xf0e442, flat: true, rimStrength: 0.95 });
        default:
          return litMaterial({ body: 0x000000, rim: 0xff8a3d, rimStrength: 2.6, rimPower: 1.6 });
      }
    });
    this.shard = litMaterial({
      body: 0x56b4e9,
      glow: 0x9fdcff,
      flat: true,
      spin: 1.6,
      rim: 0xffffff,
      rimStrength: 0.6,
    });
  }
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/** Pooled view of one chunk slot: instanced meshes per archetype plus shards. */
class SlotView {
  readonly group = new THREE.Group();
  readonly meshes: THREE.InstancedMesh[];
  readonly shards: THREE.InstancedMesh;
  readonly counts: Int32Array;
  /** Obstacle i → archetype index and instance index. */
  readonly instArch = new Uint8Array(TUNING.MAX_OBSTACLES_PER_CHUNK);
  readonly instIdx = new Uint16Array(TUNING.MAX_OBSTACLES_PER_CHUNK);
  readonly drones = new Int16Array(TUNING.MAX_OBSTACLES_PER_CHUNK);
  droneCount = 0;
  builtIndex = -1;
  builtVersion = -1;

  constructor(mats: WorldMaterials) {
    this.counts = new Int32Array(ARCHETYPES.length);
    this.meshes = ARCHETYPES.map((a, k) => {
      const m = new THREE.InstancedMesh(
        archetypeGeometry(a),
        mats.byArch[k]!,
        TUNING.MAX_OBSTACLES_PER_CHUNK,
      );
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.visible = false;
      m.count = 0;
      this.group.add(m);
      return m;
    });
    this.shards = new THREE.InstancedMesh(shardGeometry(), mats.shard, TUNING.MAX_SHARDS_PER_CHUNK);
    this.shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shards.frustumCulled = false;
    this.shards.visible = false;
    this.group.add(this.shards);
    this.group.visible = false;
  }

  build(c: ChunkData): void {
    this.builtIndex = c.index;
    this.counts.fill(0);
    this.droneCount = 0;
    for (let i = 0; i < c.obsCount; i++) {
      const def = OBSTACLES[c.obsDef[i]!]!;
      const a = ARCH_INDEX[def.archetype];
      const j = this.counts[a]!++;
      this.instArch[i] = a;
      this.instIdx[i] = j;
      if (c.obsKind[i] === KIND_DRONE) this.drones[this.droneCount++] = i;
      this.writeObstacle(c, i, c.obsX[i]!, c.obsY[i]!);
    }
    for (let a = 0; a < this.meshes.length; a++) {
      const m = this.meshes[a]!;
      m.count = this.counts[a]!;
      m.visible = m.count > 0;
      m.instanceMatrix.needsUpdate = true;
    }
    for (let i = 0; i < c.shardCount; i++) {
      tmpP.set(c.shardX[i]!, c.shardY[i]!, -(c.shardS[i]! - c.startS));
      tmpM.makeTranslation(tmpP.x, tmpP.y, tmpP.z);
      this.shards.setMatrixAt(i, c.shardTaken[i] ? HIDDEN : tmpM);
    }
    this.shards.count = c.shardCount;
    this.shards.visible = c.shardCount > 0;
    this.shards.instanceMatrix.needsUpdate = true;
    this.group.visible = true;
  }

  writeObstacle(c: ChunkData, i: number, x: number, y: number): void {
    const a = this.instArch[i]!;
    const m = this.meshes[a]!;
    if (!c.isActive(i)) {
      m.setMatrixAt(this.instIdx[i]!, HIDDEN);
      return;
    }
    tmpP.set(x, y, -(c.obsS[i]! - c.startS));
    if (c.obsShape[i] === SHAPE_SPHERE) {
      const k = c.obsR[i]! * SPHERE_VISUAL[ARCHETYPES[a]!];
      tmpS.set(k, k, k);
      const seed = c.obsSeed[i]!;
      tmpE.set(seed * 11.3, seed * 7.1, seed * 3.7);
      tmpQ.setFromEuler(tmpE);
    } else {
      tmpS.set(c.obsHX[i]! * 2, c.obsHY[i]! * 2, c.obsHS[i]! * 2);
      tmpQ.identity();
    }
    tmpM.compose(tmpP, tmpQ, tmpS);
    m.setMatrixAt(this.instIdx[i]!, tmpM);
  }

  hideShard(i: number): void {
    this.shards.setMatrixAt(i, HIDDEN);
    this.shards.instanceMatrix.needsUpdate = true;
  }

  hideObstacle(c: ChunkData, i: number): void {
    this.writeObstacle(c, i, 0, 0);
    this.meshes[this.instArch[i]!]!.instanceMatrix.needsUpdate = true;
  }

  /** Per-frame: position the slot relative to the ship (floating origin) and move drones. */
  update(c: ChunkData, shipS: number): void {
    this.group.position.z = shipS - c.startS;
    for (let k = 0; k < this.droneCount; k++) {
      const i = this.drones[k]!;
      if (!c.isActive(i)) continue;
      obstaclePos(c, i, shipS);
      this.writeObstacle(c, i, posOut.x, posOut.y);
    }
    if (this.droneCount > 0) this.meshes[ARCH_INDEX.drone]!.instanceMatrix.needsUpdate = true;
  }
}

/** All resident chunk slots. Rebuilds a slot when the sim generated a new chunk into it. */
export class WorldView {
  readonly root = new THREE.Group();
  readonly mats = new WorldMaterials();
  private readonly slots: SlotView[] = [];

  constructor() {
    for (let i = 0; i < 4; i++) {
      const v = new SlotView(this.mats);
      this.slots.push(v);
      this.root.add(v.group);
    }
  }

  /** Forces every slot to rebuild (new run). */
  invalidate(): void {
    for (const v of this.slots) v.builtIndex = -1;
  }

  update(sim: RunSim, shipS: number): void {
    for (let k = 0; k < 4; k++) {
      const c = sim.chunks[k]!;
      const v = this.slots[k]!;
      if (c.index < 0) {
        v.group.visible = false;
        continue;
      }
      if (v.builtIndex !== c.index) v.build(c);
      v.update(c, shipS);
    }
  }

  shardTaken(sim: RunSim, s: number): void {
    for (let k = 0; k < 4; k++) {
      const c = sim.chunks[k]!;
      if (c.index < 0 || s < c.startS || s > c.endS + 2) continue;
      for (let i = 0; i < c.shardCount; i++) if (c.shardTaken[i]) this.slots[k]!.hideShard(i);
    }
  }

  obstacleDestroyed(sim: RunSim, slot: number, i: number): void {
    const c = sim.chunks[slot]!;
    this.slots[slot]!.hideObstacle(c, i);
  }
}
