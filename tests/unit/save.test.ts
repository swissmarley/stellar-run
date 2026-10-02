import { describe, expect, it } from 'vitest';
import {
  buyCosmetic,
  buyShip,
  buyUpgrade,
  equipCosmetic,
  nextUpgradeCost,
  reviveCost,
} from '../../src/core/meta/economy.ts';
import {
  applyRun,
  claimMission,
  dailyMissions,
  dayKey,
  ensureMissions,
} from '../../src/core/meta/missions.ts';
import {
  defaultProfile,
  migrate,
  PROFILE_VERSION,
  type Profile,
  sanitizeProfile,
} from '../../src/core/meta/profile.ts';
import { decode, encode, MemoryStore, SlotStore } from '../../src/core/meta/save-codec.ts';
import type { RunSim } from '../../src/core/sim/run-sim.ts';
import { defaultSettings, SETTINGS_VERSION, sanitizeSettings } from '../../src/services/settings.ts';

function profileStore(store = new MemoryStore()): SlotStore<Profile> {
  return new SlotStore(store, 'test.profile', PROFILE_VERSION, sanitizeProfile, migrate, defaultProfile);
}

function richProfile(): Profile {
  const p = defaultProfile();
  p.shards = 5000;
  buyShip(p, 'viper');
  p.selectedShip = 'viper';
  buyUpgrade(p, 'thrusters');
  buyUpgrade(p, 'thrusters');
  buyCosmetic(p, 'paint_jade');
  equipCosmetic(p, 'paint_jade');
  p.best = { score: 12345.5, distance: 4321 };
  p.stats.runs = 17;
  p.missions = { day: '2026-10-02', list: dailyMissions('2026-10-02') };
  p.leaderboard.push({ score: 999, distance: 300, ship: 'comet', date: '2026-10-02' });
  p.director = { skill: 0.25, runs: 17 };
  return p;
}

describe('save system', () => {
  it('round-trips a full profile exactly', () => {
    const s = profileStore();
    const p = richProfile();
    expect(s.save(p)).toBe(true);
    const fresh = profileStore(s.store as MemoryStore);
    const r = fresh.load();
    expect(r.from).not.toBeNull();
    expect(r.value).toEqual(p);
    expect(r.notes).toEqual([]);
  });

  it('alternates slots, so the previous copy survives a corrupted newest slot', () => {
    const mem = new MemoryStore();
    const s = profileStore(mem);
    const p = richProfile();
    s.save(p);
    p.shards = 1234;
    s.save(p);
    expect(mem.data.size).toBe(2);
    // Corrupt the newest slot (bit flip inside the payload).
    const newestKey = [...mem.data.entries()].sort(
      (a, b) => JSON.parse(b[1]).seq - JSON.parse(a[1]).seq,
    )[0]![0];
    const env = mem.data.get(newestKey)!;
    mem.data.set(newestKey, env.replace('1234', '1235'));
    const r = profileStore(mem).load();
    expect(r.value.shards).toBe(richProfile().shards);
    expect(r.notes.join()).toMatch(/checksum mismatch/);
  });

  it('recovers from truncation and garbage in either slot; both bad → defaults', () => {
    const mem = new MemoryStore();
    const s = profileStore(mem);
    s.save(richProfile());
    s.save(richProfile());
    const [ka, kb] = [...mem.data.keys()];
    mem.data.set(ka!, mem.data.get(ka!)!.slice(0, 40));
    expect(profileStore(mem).load().value.shards).toBe(richProfile().shards);
    mem.data.set(kb!, '{{{{ not json');
    const r = profileStore(mem).load();
    expect(r.from).toBeNull();
    expect(r.value).toEqual(defaultProfile());
    expect(r.notes.length).toBe(2);
  });

  it('an interrupted write never destroys the last good save', () => {
    const mem = new MemoryStore();
    const s = profileStore(mem);
    const p = richProfile();
    s.save(p);
    mem.failWrites = true;
    p.shards = 1;
    expect(s.save(p)).toBe(false);
    expect(s.lastError).toBe('QuotaExceededError');
    mem.failWrites = false;
    expect(profileStore(mem).load().value.shards).toBe(richProfile().shards);
  });

  it('never overwrites a save from a newer game version', () => {
    const mem = new MemoryStore();
    mem.setItem('test.profile.A', encode({ shards: 77, futureField: true }, PROFILE_VERSION + 1, 9));
    const s = profileStore(mem);
    const r = s.load();
    expect(r.readOnly).toBe(true);
    expect(s.save(defaultProfile())).toBe(false);
    expect(decode(mem.getItem('test.profile.A')).ok).toBe(true);
    expect(mem.getItem('test.profile.B')).toBeNull();
  });

  it('migrates a v1 save (coins/ship fields) to the current schema', () => {
    const mem = new MemoryStore();
    mem.setItem(
      'test.profile.B',
      encode({ coins: 640, ship: 'bulwark', ships: ['comet', 'bulwark'], upgrades: { tractor: 2 } }, 1, 3),
    );
    const r = profileStore(mem).load();
    expect(r.value.shards).toBe(640);
    expect(r.value.selectedShip).toBe('bulwark');
    expect(r.value.ownedShips).toEqual(['comet', 'bulwark']);
    expect(r.value.upgrades).toEqual({ tractor: 2 });
  });

  it('sanitises hostile or broken data', () => {
    const p = sanitizeProfile({
      shards: -5,
      ownedShips: ['viper', 'not-a-ship', 'viper', 42],
      selectedShip: 'ghost',
      upgrades: { thrusters: 99, bogus: 3, tractor: Number.NaN },
      paint: 'trail_ion',
      best: { score: Number.POSITIVE_INFINITY },
      missions: { day: 7, list: [{ id: 'nope' }, null, { id: 'boosts', target: -3, progress: 'x' }] },
      leaderboard: [{ score: 10, ship: 'evil' }],
      director: { skill: 99 },
    });
    expect(p.shards).toBe(0);
    expect(p.ownedShips).toEqual(['comet', 'viper']);
    expect(p.selectedShip).toBe('comet');
    expect(p.upgrades).toEqual({ thrusters: 3 });
    expect(p.paint).toBe('paint_factory');
    expect(p.best.score).toBe(0);
    expect(p.missions.list).toEqual([{ id: 'boosts', target: 1, progress: 0, claimed: false }]);
    expect(p.leaderboard[0]!.ship).toBe('comet');
    expect(p.director.skill).toBe(1);
  });

  it('settings round-trip and reject invalid values', () => {
    const mem = new MemoryStore();
    const s = new SlotStore(
      mem,
      'test.settings',
      SETTINGS_VERSION,
      sanitizeSettings,
      (r) => r,
      defaultSettings,
    );
    const st = defaultSettings();
    st.controls.steering = 'tilt';
    st.controls.keys.boost = ['KeyB'];
    st.a11y.textScale = 1.3;
    s.save(st);
    expect(s.load().value).toEqual(st);
    const bad = sanitizeSettings({
      controls: { steering: 'mind', dragSensitivity: 99, keys: { left: [] } },
      a11y: { textScale: 7 },
    });
    expect(bad.controls.steering).toBe('drag');
    expect(bad.controls.dragSensitivity).toBe(2.5);
    expect(bad.controls.keys.left).toEqual(['ArrowLeft', 'KeyA']);
    expect(bad.a11y.textScale).toBe(1.5);
  });
});

describe('economy', () => {
  it('purchases respect funds, ownership, prerequisites and caps', () => {
    const p = defaultProfile();
    expect(buyShip(p, 'viper')).toEqual({ ok: false, reason: 'funds' });
    p.shards = 10_000;
    expect(buyShip(p, 'viper')).toEqual({ ok: true });
    expect(buyShip(p, 'viper')).toEqual({ ok: false, reason: 'owned' });
    expect(buyUpgrade(p, 'reactor')).toEqual({ ok: false, reason: 'locked' });
    expect(buyUpgrade(p, 'afterburner')).toEqual({ ok: true });
    expect(buyUpgrade(p, 'reactor')).toEqual({ ok: true });
    while (nextUpgradeCost(p, 'afterburner') > 0) expect(buyUpgrade(p, 'afterburner').ok).toBe(true);
    expect(buyUpgrade(p, 'afterburner')).toEqual({ ok: false, reason: 'maxed' });
    expect(equipCosmetic(p, 'paint_amber')).toBe(false);
    expect(buyCosmetic(p, 'paint_amber').ok).toBe(true);
    expect(equipCosmetic(p, 'paint_amber')).toBe(true);
    expect(p.paint).toBe('paint_amber');
    expect(reviveCost(0, 0)).toBe(150);
    expect(reviveCost(3000, 0.4)).toBeLessThan(reviveCost(3000, 0));
  });
});

describe('daily missions', () => {
  it('are identical for everyone on a UTC day and change between days', () => {
    expect(dailyMissions('2026-10-02')).toEqual(dailyMissions('2026-10-02'));
    expect(dailyMissions('2026-10-02')).not.toEqual(dailyMissions('2026-10-03'));
    expect(new Set(dailyMissions('2026-10-02').map((m) => m.id)).size).toBe(3);
    expect(dayKey(Date.UTC(2026, 9, 2, 23, 59))).toBe('2026-10-02');
  });

  it('track progress from runs and pay out once', () => {
    const p = defaultProfile();
    ensureMissions(p, '2026-10-02');
    for (const m of p.missions.list) m.target = 1;
    const fakeRun = {
      s: 5000,
      nearMisses: 30,
      shards: 300,
      abilityUses: 9,
      boosts: 50,
      score: 1e6,
      biomeMask: 0b1111,
      perfects: 12,
    } as unknown as RunSim;
    const done = applyRun(p, fakeRun);
    expect(done.length).toBe(3);
    const id = p.missions.list[0]!.id;
    const before = p.shards;
    expect(claimMission(p, id)).toBeGreaterThan(0);
    expect(claimMission(p, id)).toBe(0);
    expect(p.shards).toBeGreaterThan(before);
  });
});
