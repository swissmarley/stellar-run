import * as THREE from 'three';
import { SHIPS } from '../../data/ships.ts';
import { TUNING } from '../../data/tuning.ts';
import { shipGeometry } from './geometry.ts';
import { type GlowMaterial, glowMaterial, type LitMaterial, litMaterial } from './materials.ts';

const DEG = Math.PI / 180;

/** The player's ship: procedural mesh, banking/pitch from lateral velocity, engine glow. */
export class ShipView {
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private mesh: THREE.Mesh;
  private readonly material: LitMaterial;
  private readonly flame: THREE.Mesh;
  private readonly flameMat: GlowMaterial;
  private readonly geometries: THREE.BufferGeometry[];
  bank = 0;
  pitch = 0;
  private shipIndex = 0;

  constructor() {
    this.geometries = SHIPS.map((s) => shipGeometry(s));
    this.material = litMaterial({
      body: 0xffffff,
      rim: 0x9fdcff,
      rimStrength: 0.55,
      rimPower: 2.6,
      nearCut: 0,
    });
    this.mesh = new THREE.Mesh(this.geometries[0]!, this.material);
    this.body.add(this.mesh);
    this.flameMat = glowMaterial(0x56b4e9, 1.4);
    this.flame = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.flameMat);
    this.flame.renderOrder = 10;
    this.body.add(this.flame);
    this.root.add(this.body);
  }

  setShip(index: number, engineColor?: number, paint?: number): void {
    this.shipIndex = index;
    const def = SHIPS[index]!;
    this.mesh.geometry = this.geometries[index]!;
    this.flame.position.set(0, 0, def.model.length * 0.5 + 0.3);
    this.flameMat.uniforms.uColor.value.setHex(engineColor ?? def.model.engine);
    this.material.uniforms.uBody.value.setHex(paint ?? 0xffffff);
  }

  /** dt in wall seconds (presentation). vx/vy normalised lateral velocity in [-1, 1]. */
  update(
    x: number,
    y: number,
    vxN: number,
    vyN: number,
    boost01: number,
    dt: number,
    ghost: boolean,
    t: number,
  ): void {
    this.root.position.set(x, y, 0);
    const k = 1 - Math.exp(-dt * 12);
    this.bank += (-vxN * TUNING.BANK_MAX_DEG * DEG - this.bank) * k;
    this.pitch += (vyN * 12 * DEG - this.pitch) * k;
    this.body.rotation.set(this.pitch, 0, this.bank);
    const def = SHIPS[this.shipIndex]!;
    const flicker = 0.9 + 0.1 * Math.sin(t * 60);
    const len = (0.9 + boost01 * 1.6) * flicker;
    this.flame.scale.setScalar(len * def.model.width * 0.55);
    this.flameMat.uniforms.uIntensity.value = 1.1 + boost01 * 1.4;
    this.material.uniforms.uOpacity.value = ghost ? 0.45 + 0.25 * Math.sin(t * 30) : 1;
    this.material.transparent = ghost;
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }
}
