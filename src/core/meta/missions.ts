import { BIOMES } from '../../data/biomes.ts';
import { MISSIONS } from '../../data/missions.ts';
import type { MissionDef } from '../../data/types.ts';
import { hashString } from '../det/hash.ts';
import { Rng } from '../det/rng.ts';
import type { RunSim } from '../sim/run-sim.ts';
import type { MissionState, Profile } from './profile.ts';

/**
 * UTC calendar day key, e.g. "2026-10-02", from a Unix time supplied by the caller (core never reads the
 * clock). Integer civil-from-days conversion (H. Hinnant), so it needs no Date object.
 */
export function dayKey(epochMs: number): string {
  let z = Math.floor(epochMs / 86_400_000) + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  z = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return `${z}-${month < 10 ? '0' : ''}${month}-${day < 10 ? '0' : ''}${day}`;
}

/** Three distinct daily missions, identical for every player on the same UTC day. */
export function dailyMissions(day: string): MissionState[] {
  const rng = new Rng(hashString(`missions:${day}`));
  const pool = MISSIONS.slice();
  const out: MissionState[] = [];
  while (out.length < 3 && pool.length > 0) {
    const m = pool.splice(rng.int(pool.length), 1)[0]!;
    const raw = rng.range(m.target[0], m.target[1] + m.step);
    const target = Math.max(m.step, Math.min(m.target[1], Math.floor(raw / m.step) * m.step));
    out.push({ id: m.id, target, progress: 0, claimed: false });
  }
  return out;
}

export function missionDef(id: string): MissionDef | undefined {
  return MISSIONS.find((m) => m.id === id);
}

export function missionText(m: MissionState): string {
  const d = missionDef(m.id);
  if (!d) return m.id;
  if (d.type === 'reachBiome') return d.text.replace('{biome}', BIOMES[m.target]?.name ?? 'next biome');
  return d.text.replace('{n}', m.target.toLocaleString('en-US'));
}

/** Refreshes the mission list when the UTC day changed. */
export function ensureMissions(p: Profile, day: string): void {
  if (p.missions.day !== day || p.missions.list.length === 0) p.missions = { day, list: dailyMissions(day) };
}

/** Applies a finished run to mission progress. Returns ids of missions completed by this run. */
export function applyRun(p: Profile, sim: RunSim): string[] {
  const done: string[] = [];
  for (const m of p.missions.list) {
    const d = missionDef(m.id);
    if (!d || m.claimed || m.progress >= m.target) continue;
    switch (d.type) {
      case 'distanceRun':
        m.progress = Math.max(m.progress, Math.floor(sim.s));
        break;
      case 'distanceTotal':
        m.progress += Math.floor(sim.s);
        break;
      case 'nearMissRun':
        m.progress = Math.max(m.progress, sim.nearMisses);
        break;
      case 'nearMissTotal':
        m.progress += sim.nearMisses;
        break;
      case 'shardsTotal':
        m.progress += sim.shards;
        break;
      case 'abilityUses':
        m.progress += sim.abilityUses;
        break;
      case 'boosts':
        m.progress += sim.boosts;
        break;
      case 'scoreRun':
        m.progress = Math.max(m.progress, Math.floor(sim.score));
        break;
      case 'reachBiome':
        if ((sim.biomeMask >> m.target) & 1) m.progress = m.target;
        break;
      case 'perfects':
        m.progress += sim.perfects;
        break;
    }
    if (m.progress >= m.target) {
      m.progress = m.target;
      done.push(missionText(m));
    }
  }
  return done;
}

/** Claims a completed mission's reward. Returns the shards granted (0 if not claimable). */
export function claimMission(p: Profile, id: string): number {
  const m = p.missions.list.find((x) => x.id === id);
  const d = missionDef(id);
  if (!m || !d || m.claimed || m.progress < m.target) return 0;
  m.claimed = true;
  p.shards += d.reward;
  return d.reward;
}
