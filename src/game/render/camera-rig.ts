import * as THREE from 'three';
import { TUNING } from '../../data/tuning.ts';

const DEG = Math.PI / 180;

/**
 * Chase camera: spring-follows the ship, FOV kick on boost, trauma-based shake (near-misses, death),
 * partial banking, and an aspect-aware FOV so the corridor fits portrait phones, foldables and desktops.
 */
export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(TUNING.FOV_BASE, 9 / 19.5, 0.1, 600);
  private readonly pos = new THREE.Vector3(0, TUNING.CAMERA_HEIGHT, TUNING.CAMERA_DISTANCE);
  private readonly look = new THREE.Vector3(0, 0, -TUNING.CAMERA_LOOK_AHEAD);
  private readonly tmp = new THREE.Vector3();
  private fov: number = TUNING.FOV_BASE;
  private trauma = 0;
  private aspect = 9 / 19.5;
  /** 0..1 user setting (accessibility). */
  shakeScale = 1;
  /** Reduced motion: no shake, small FOV kick. */
  reducedMotion = false;

  setAspect(aspect: number): void {
    this.aspect = aspect;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  addTrauma(v: number): void {
    this.trauma = Math.min(1, this.trauma + v);
  }

  reset(): void {
    this.trauma = 0;
    this.pos.set(0, TUNING.CAMERA_HEIGHT, TUNING.CAMERA_DISTANCE);
    this.look.set(0, 0, -TUNING.CAMERA_LOOK_AHEAD);
  }

  /** speed01: cruise speed in [0,1]; boost01: boost blend; bank: ship bank (radians). */
  update(x: number, y: number, speed01: number, boost01: number, bank: number, dt: number, t: number): void {
    const f = TUNING.CAMERA_FOLLOW;
    const k = 1 - Math.exp(-dt * TUNING.CAMERA_SPRING);
    this.tmp.set(x * f, y * f + TUNING.CAMERA_HEIGHT, TUNING.CAMERA_DISTANCE);
    this.pos.lerp(this.tmp, k);
    this.tmp.set(x * 0.85, y * 0.85, -TUNING.CAMERA_LOOK_AHEAD);
    this.look.lerp(this.tmp, k);

    const kick = this.reducedMotion ? 0.3 : 1;
    const targetFov =
      TUNING.FOV_BASE + kick * (TUNING.FOV_SPEED_KICK * speed01 + TUNING.FOV_BOOST_KICK * boost01);
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-dt * 6));
    // Keep the horizontal FOV bounded on wide aspects (foldables, desktop).
    const vfov = this.fov * DEG;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.aspect);
    const hmax = TUNING.HFOV_MAX * DEG;
    const finalV = hfov > hmax ? 2 * Math.atan(Math.tan(hmax / 2) / this.aspect) : vfov;
    this.camera.fov = finalV / DEG;

    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
    this.camera.rotateZ(bank * TUNING.CAMERA_BANK_FACTOR);

    if (this.trauma > 0) {
      const amt = this.reducedMotion ? 0 : this.trauma * this.trauma * this.shakeScale;
      if (amt > 0) {
        const o = TUNING.SHAKE_MAX_OFFSET * amt;
        this.camera.position.x += o * Math.sin(t * 61.3);
        this.camera.position.y += o * Math.sin(t * 47.9 + 1.7);
        this.camera.rotateZ(0.04 * amt * Math.sin(t * 37.1 + 0.3));
      }
      this.trauma = Math.max(0, this.trauma - TUNING.SHAKE_DECAY * dt);
    }
    this.camera.updateProjectionMatrix();
  }
}
