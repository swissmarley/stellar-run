/**
 * Service-worker registration and the "update ready" flow. A new deploy installs in the background and waits;
 * `ready` becomes true and `onReady` fires. `apply()` activates the waiting worker and reloads once it has
 * taken control. Only the player triggers the reload, so a run is never interrupted.
 */
export class UpdateService {
  ready = false;
  onReady: (() => void) | null = null;
  private reg: ServiceWorkerRegistration | null = null;
  private applying = false;
  private lastCheck = 0;

  get supported(): boolean {
    return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  }

  async register(url: string): Promise<void> {
    if (!this.supported) return;
    const sw = navigator.serviceWorker;
    const hadController = sw.controller !== null;
    try {
      this.reg = await sw.register(url);
    } catch {
      return; // offline support is optional
    }
    const reg = this.reg;
    if (reg.waiting && sw.controller) this.markReady();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && sw.controller) this.markReady();
      });
    });
    sw.addEventListener('controllerchange', () => {
      if (this.applying) window.location.reload();
      // Another tab activated the new version: this page runs old code under the new worker; offer a reload.
      else if (hadController) this.markReady();
    });
    this.lastCheck = Date.now();
  }

  /** Asks the browser to look for a new version (throttled). Call when the app returns to the foreground. */
  check(force = false): void {
    if (!this.reg) return;
    const now = Date.now();
    if (!force && now - this.lastCheck < 10 * 60_000) return;
    this.lastCheck = now;
    this.reg.update().catch(() => {});
  }

  /** Activates the waiting version and reloads into it. */
  apply(): void {
    const waiting = this.reg?.waiting;
    if (!waiting) {
      window.location.reload();
      return;
    }
    this.applying = true;
    waiting.postMessage({ type: 'SKIP_WAITING' });
  }

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.onReady?.();
  }
}
