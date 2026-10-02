import * as THREE from 'three';

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  antialias: boolean;
  pixelRatioCap: number;
}

/**
 * WebGL2 renderer setup. Colour management is disabled: assets are authored in display space and every
 * shader writes display-space colour directly (no per-fragment conversions on mobile GPUs).
 */
export function createRenderer(o: RendererOptions): THREE.WebGLRenderer {
  THREE.ColorManagement.enabled = false;
  const r = new THREE.WebGLRenderer({
    canvas: o.canvas,
    antialias: o.antialias,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
    preserveDrawingBuffer: false,
  });
  r.outputColorSpace = THREE.LinearSRGBColorSpace;
  r.setPixelRatio(Math.min(window.devicePixelRatio || 1, o.pixelRatioCap));
  r.info.autoReset = false;
  return r;
}
