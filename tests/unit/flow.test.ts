import { describe, expect, it } from 'vitest';
import { Flow, type FlowState } from '../../src/core/meta/flow.ts';
import { TUNING } from '../../src/data/tuning.ts';

function advance(f: Flow, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 60) f.update(1 / 60);
}

describe('Flow state machine', () => {
  it('death → hitstop → dying → results, and retry is allowed after the input delay', () => {
    const f = new Flow();
    expect(f.start()).toBe(true);
    f.died(false);
    expect(f.state).toBe('hitstop');
    advance(f, TUNING.HIT_STOP + 0.02);
    expect(f.state).toBe('dying');
    advance(f, TUNING.DEATH_SEQUENCE + 0.02);
    expect(f.state).toBe('results');
    expect(f.start()).toBe(false);
    advance(f, TUNING.RESULTS_INPUT_DELAY + 0.02);
    expect(f.start()).toBe(true);
  });

  it('death to a new run fits in the 2 s budget', () => {
    const budget = TUNING.HIT_STOP + TUNING.DEATH_SEQUENCE + TUNING.RESULTS_INPUT_DELAY;
    expect(budget).toBeLessThan(2);
  });

  it('revive offer times out to results; accept resumes running', () => {
    const f = new Flow();
    f.start();
    f.died(true);
    advance(f, TUNING.HIT_STOP + TUNING.DEATH_SEQUENCE + 0.05);
    expect(f.state).toBe('revive');
    expect(f.acceptRevive()).toBe(true);
    expect(f.state).toBe('running');
    f.died(true);
    advance(f, TUNING.HIT_STOP + TUNING.DEATH_SEQUENCE + TUNING.REVIVE_OFFER_TIME + 0.1);
    expect(f.state).toBe('results');
  });

  it('has no softlocks: every state can reach running within bounded time using public actions', () => {
    const states: FlowState[] = ['menu', 'running', 'paused', 'hitstop', 'dying', 'revive', 'results'];
    for (const s of states) {
      const f = new Flow();
      // Drive into state s.
      if (s !== 'menu') f.start();
      if (s === 'paused') f.pause();
      if (s === 'hitstop' || s === 'dying' || s === 'revive' || s === 'results') f.died(s === 'revive');
      if (s === 'dying') advance(f, TUNING.HIT_STOP + 0.02);
      if (s === 'revive' || s === 'results') advance(f, TUNING.HIT_STOP + TUNING.DEATH_SEQUENCE + 0.05);
      expect(f.state).toBe(s);
      // Escape: try every action repeatedly with time passing.
      for (let i = 0; i < 600 && f.state !== 'running'; i++) {
        f.update(1 / 60);
        f.resume();
        f.declineRevive();
        f.start();
      }
      expect(f.state, `stuck in ${s}`).toBe('running');
    }
  });
});
