import { clear, h } from './dom.ts';

export interface UiActions {
  play(): void;
  resume(): void;
  restart(): void;
  quit(): void;
  retry(): void;
  menu(): void;
  revive(): void;
  declineRevive(): void;
  open(screen: string): void;
}

export interface ResultsData {
  score: number;
  distance: number;
  nearMisses: number;
  perfects: number;
  maxCombo: number;
  shards: number;
  earned: number;
  best: number;
  newBest: boolean;
  missionsCompleted: string[];
}

export type ScreenName = 'menu' | 'pause' | 'results' | 'revive' | string;

/** DOM screens layered over the canvas. Screens are built once and toggled. */
export class Ui {
  readonly root: HTMLElement;
  private readonly screens = new Map<string, HTMLElement>();
  private current: string | null = null;
  private readonly bestEl: HTMLElement;
  private readonly resultsBody: HTMLElement;
  private readonly reviveCost: HTMLElement;
  private readonly reviveBar: HTMLElement;
  readonly menuExtra: HTMLElement;

  constructor(root: HTMLElement, actions: UiActions) {
    this.root = root;
    this.bestEl = h('div', { class: 'menu-best' });
    this.menuExtra = h('nav', { class: 'menu-nav' });
    this.add(
      'menu',
      h(
        'section',
        { class: 'screen screen-menu', 'aria-label': 'Main menu' },
        h(
          'div',
          { class: 'title' },
          h('h1', null, 'STELLAR', h('span', null, 'RUN')),
          h('p', null, 'Thread the void. One thumb. One more run.'),
        ),
        this.bestEl,
        h(
          'div',
          { class: 'menu-actions' },
          h(
            'button',
            { class: 'btn btn-primary btn-play', type: 'button', onclick: () => actions.play() },
            'PLAY',
          ),
          this.menuExtra,
        ),
        h('p', { class: 'menu-hint' }, 'Drag to steer · Tap to boost · Press & hold to focus'),
      ),
    );
    this.add(
      'pause',
      h(
        'section',
        { class: 'screen screen-pause', 'aria-label': 'Paused' },
        h('h2', null, 'Paused'),
        h(
          'div',
          { class: 'stack' },
          h(
            'button',
            { class: 'btn btn-primary', type: 'button', onclick: () => actions.resume() },
            'Resume',
          ),
          h('button', { class: 'btn', type: 'button', onclick: () => actions.restart() }, 'Restart'),
          h('button', { class: 'btn', type: 'button', onclick: () => actions.open('settings') }, 'Settings'),
          h(
            'button',
            { class: 'btn btn-ghost', type: 'button', onclick: () => actions.quit() },
            'Quit to menu',
          ),
        ),
      ),
    );
    this.resultsBody = h('div', { class: 'results-body' });
    this.add(
      'results',
      h(
        'section',
        { class: 'screen screen-results', 'aria-label': 'Run results' },
        this.resultsBody,
        h(
          'div',
          { class: 'stack bottom' },
          h(
            'button',
            { class: 'btn btn-primary btn-retry', type: 'button', onclick: () => actions.retry() },
            'Retry',
          ),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => actions.menu() }, 'Menu'),
        ),
      ),
    );
    this.reviveCost = h('span');
    this.reviveBar = h('i');
    this.add(
      'revive',
      h(
        'section',
        { class: 'screen screen-revive', 'aria-label': 'Revive' },
        h('h2', null, 'Hull breach'),
        h('div', { class: 'revive-timer' }, this.reviveBar),
        h(
          'div',
          { class: 'stack bottom' },
          h(
            'button',
            { class: 'btn btn-primary btn-revive', type: 'button', onclick: () => actions.revive() },
            'Revive  ◆ ',
            this.reviveCost,
          ),
          h(
            'button',
            { class: 'btn btn-ghost', type: 'button', onclick: () => actions.declineRevive() },
            'No thanks',
          ),
        ),
      ),
    );
  }

  add(name: string, el: HTMLElement): void {
    el.classList.add('hidden');
    this.screens.set(name, el);
    this.root.append(el);
  }

  get screen(): string | null {
    return this.current;
  }

  show(name: ScreenName | null): void {
    if (name === this.current) return;
    if (this.current) this.screens.get(this.current)?.classList.add('hidden');
    this.current = name;
    if (name) {
      const el = this.screens.get(name);
      if (!el) throw new Error(`Unknown screen ${name}`);
      el.classList.remove('hidden');
      const first = el.querySelector<HTMLElement>('.btn-primary, button');
      first?.focus({ preventScroll: true });
    }
  }

  setBest(best: number): void {
    this.bestEl.textContent = best > 0 ? `Best ${Math.floor(best).toLocaleString('en-US')}` : '';
  }

  setRevive(cost: number, remaining01: number): void {
    this.reviveCost.textContent = String(cost);
    this.reviveBar.style.transform = `scaleX(${remaining01.toFixed(3)})`;
  }

  setResults(r: ResultsData): void {
    clear(this.resultsBody);
    const row = (label: string, value: string): HTMLElement =>
      h('div', { class: 'row' }, h('span', null, label), h('b', null, value));
    this.resultsBody.append(
      h('h2', null, r.newBest ? 'New best!' : 'Run over'),
      h('div', { class: 'big-score' }, Math.floor(r.score).toLocaleString('en-US')),
      h(
        'div',
        { class: 'rows' },
        row('Distance', `${Math.floor(r.distance).toLocaleString('en-US')} m`),
        row('Near-misses', `${r.nearMisses}${r.perfects > 0 ? ` (${r.perfects} perfect)` : ''}`),
        row('Best combo', `×${r.maxCombo}`),
        row('Shards', String(r.shards)),
        row('Earned', `◆ ${r.earned}`),
        row('Best', Math.floor(r.best).toLocaleString('en-US')),
      ),
      ...r.missionsCompleted.map((m) => h('div', { class: 'mission-done' }, `✓ ${m}`)),
    );
  }
}
