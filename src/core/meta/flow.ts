import { TUNING } from '../../data/tuning.ts';

export type FlowState = 'menu' | 'running' | 'paused' | 'hitstop' | 'dying' | 'revive' | 'results';

/**
 * Game-flow state machine (wall-clock driven, pure). The game and the headless bot both drive it, so
 * softlocks (a state with no way out) are caught by tests rather than players.
 *
 *   menu → running ⇄ paused
 *   running → hitstop → dying → (revive → running | results) → running | menu
 */
export class Flow {
  state: FlowState = 'menu';
  /** Wall seconds spent in the current state. */
  t = 0;
  canRevive = false;
  runs = 0;
  /** Monotonic counter of transitions (cheap change detection for UI). */
  version = 0;

  private go(s: FlowState): void {
    this.state = s;
    this.t = 0;
    this.version++;
  }

  /** Starts a run from menu or results. Returns false if not allowed right now. */
  start(): boolean {
    if (this.state === 'menu' || (this.state === 'results' && this.t >= TUNING.RESULTS_INPUT_DELAY)) {
      this.runs++;
      this.go('running');
      return true;
    }
    return false;
  }

  pause(): boolean {
    if (this.state !== 'running') return false;
    this.go('paused');
    return true;
  }

  resume(): boolean {
    if (this.state !== 'paused') return false;
    this.go('running');
    return true;
  }

  /** The sim reported a death. */
  died(canRevive: boolean): void {
    if (this.state !== 'running') return;
    this.canRevive = canRevive;
    this.go('hitstop');
  }

  acceptRevive(): boolean {
    if (this.state !== 'revive') return false;
    this.canRevive = false;
    this.go('running');
    return true;
  }

  declineRevive(): boolean {
    if (this.state !== 'revive') return false;
    this.go('results');
    return true;
  }

  toMenu(): boolean {
    if (this.state !== 'results' && this.state !== 'paused') return false;
    this.go('menu');
    return true;
  }

  update(dt: number): void {
    this.t += dt;
    switch (this.state) {
      case 'hitstop':
        if (this.t >= TUNING.HIT_STOP) this.go('dying');
        break;
      case 'dying':
        if (this.t >= TUNING.DEATH_SEQUENCE) this.go(this.canRevive ? 'revive' : 'results');
        break;
      case 'revive':
        if (this.t >= TUNING.REVIVE_OFFER_TIME) this.go('results');
        break;
      default:
        break;
    }
  }

  /** Whether sim ticks should run in this state. */
  get simulating(): boolean {
    return this.state === 'running';
  }
}
