/** Minimal DOM builder. Attributes starting with "on" become listeners; `class` maps to className. */
type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') el.className = String(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Fixed-width number display that updates individual digit spans without allocating strings. */
export class DigitDisplay {
  readonly el: HTMLElement;
  private readonly spans: HTMLSpanElement[] = [];
  private readonly shown: Int8Array;
  private last = -1;

  constructor(className: string, digits: number) {
    this.el = h('span', { class: className });
    this.shown = new Int8Array(digits).fill(-2);
    for (let i = 0; i < digits; i++) {
      const s = h('span', { class: 'digit' });
      this.spans.push(s);
      this.el.append(s);
    }
  }

  set(value: number): void {
    const v0 = value > 0 ? Math.floor(value) : 0;
    if (v0 === this.last) return;
    this.last = v0;
    let len = 1;
    for (let t = v0; t >= 10; t = Math.floor(t / 10)) len++;
    let v = v0;
    const n = this.spans.length;
    for (let i = n - 1; i >= 0; i--) {
      const code = n - 1 - i < len ? v % 10 : -1;
      v = Math.floor(v / 10);
      if (this.shown[i] !== code) {
        this.shown[i] = code;
        this.spans[i]!.textContent = code < 0 ? '' : DIGITS[code]!;
      }
    }
  }
}

/** Precomputed CSS strings for quantised meter values (no per-frame string building). */
export const SCALE_X: readonly string[] = Array.from(
  { length: 101 },
  (_, i) => `scaleX(${(i / 100).toFixed(2)})`,
);
export const PERCENT: readonly string[] = Array.from({ length: 101 }, (_, i) => `${i}%`);
