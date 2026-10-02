import type { RunSim } from '../../core/sim/run-sim.ts';
import { TUNING } from '../../data/tuning.ts';
import { DigitDisplay, h, PERCENT, SCALE_X } from '../../ui/dom.ts';

const MULT_STR: string[] = [];
for (let k = 0; k <= 32; k++)
  MULT_STR.push(`×${(1 + k * TUNING.COMBO_STEP).toFixed(2).replace(/\.?0+$/, '')}`);

/** Minimal HUD: score and distance at the top, meters and the ability button within thumb reach. */
export class Hud {
  readonly root: HTMLElement;
  readonly pauseBtn: HTMLButtonElement;
  readonly abilityBtn: HTMLButtonElement;
  private readonly score = new DigitDisplay('hud-score-digits', 8);
  private readonly dist = new DigitDisplay('hud-dist-digits', 6);
  private readonly mult: HTMLElement;
  private readonly energy: HTMLElement;
  private readonly focus: HTMLElement;
  private readonly abilityRing: HTMLElement;
  private lastMult = -1;
  private lastEnergy = -1;
  private lastFocus = -1;
  private lastAbility = -1;
  private lastReady = false;

  constructor() {
    this.pauseBtn = h(
      'button',
      { class: 'hud-pause', 'aria-label': 'Pause', type: 'button' },
      h('span'),
      h('span'),
    );
    this.mult = h('div', { class: 'hud-mult', 'aria-live': 'off' }, '×1');
    this.energy = h('i');
    this.focus = h('i');
    this.abilityRing = h('span', { class: 'ring' });
    this.abilityBtn = h(
      'button',
      { class: 'hud-ability', 'aria-label': 'Ability', type: 'button' },
      this.abilityRing,
      h('b', null, '✦'),
    );
    this.root = h(
      'div',
      { class: 'hud' },
      h(
        'div',
        { class: 'hud-top' },
        this.pauseBtn,
        h(
          'div',
          { class: 'hud-score' },
          this.score.el,
          h('div', { class: 'hud-dist' }, this.dist.el, h('small', null, ' m')),
        ),
        this.mult,
      ),
      h(
        'div',
        { class: 'hud-bottom' },
        h(
          'div',
          { class: 'hud-meters' },
          h('div', { class: 'meter meter-energy', 'aria-label': 'Boost energy' }, this.energy),
          h('div', { class: 'meter meter-focus', 'aria-label': 'Focus' }, this.focus),
        ),
        this.abilityBtn,
      ),
    );
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  setLeftHanded(v: boolean): void {
    this.root.classList.toggle('left-handed', v);
  }

  update(sim: RunSim): void {
    this.score.set(sim.score);
    this.dist.set(sim.s);
    const k = Math.round((sim.multiplier - 1) / TUNING.COMBO_STEP);
    if (k !== this.lastMult) {
      this.lastMult = k;
      this.mult.textContent = MULT_STR[Math.min(k, MULT_STR.length - 1)]!;
      this.mult.classList.toggle('hot', k > 0);
    }
    const e = Math.round(sim.energy * 100);
    if (e !== this.lastEnergy) {
      this.lastEnergy = e;
      this.energy.style.transform = SCALE_X[e]!;
    }
    const f = Math.round(sim.focus * 100);
    if (f !== this.lastFocus) {
      this.lastFocus = f;
      this.focus.style.transform = SCALE_X[f]!;
    }
    const a = Math.round(sim.abilityCharge * 100);
    if (a !== this.lastAbility) {
      this.lastAbility = a;
      this.abilityRing.style.setProperty('--p', PERCENT[a]!);
    }
    const ready = sim.abilityCharge >= 1;
    if (ready !== this.lastReady) {
      this.lastReady = ready;
      this.abilityBtn.classList.toggle('ready', ready);
    }
  }
}
