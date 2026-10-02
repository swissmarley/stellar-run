import { h } from '../../ui/dom.ts';

/**
 * Pooled DOM score pop-ups animated by CSS (compositor-only transforms). Restarting a CSS animation without a
 * forced reflow is done by alternating between two identical keyframe names.
 */
export class Popups {
  readonly root: HTMLElement;
  private readonly pool: HTMLElement[] = [];
  private readonly flip: boolean[] = [];
  private next = 0;
  /** Total pop-ups shown (pool test instrumentation). */
  shown = 0;

  constructor(size = 14) {
    this.root = h('div', { class: 'popups', 'aria-hidden': 'true' });
    for (let i = 0; i < size; i++) {
      const el = h('div', { class: 'popup' });
      this.pool.push(el);
      this.flip.push(false);
      this.root.append(el);
    }
  }

  get size(): number {
    return this.pool.length;
  }

  /** Shows `text` centred at (x, y) CSS pixels inside the root. */
  show(text: string, x: number, y: number, kind: '' | 'perfect' | 'shard' | 'big' = ''): void {
    const i = this.next;
    this.next = (this.next + 1) % this.pool.length;
    const el = this.pool[i]!;
    el.textContent = text;
    el.className = kind ? `popup ${kind}` : 'popup';
    el.style.left = `${x.toFixed(0)}px`;
    el.style.top = `${y.toFixed(0)}px`;
    this.flip[i] = !this.flip[i];
    el.style.animationName = this.flip[i] ? 'popA' : 'popB';
    this.shown++;
  }

  clear(): void {
    for (const el of this.pool) el.style.animationName = 'none';
  }
}
