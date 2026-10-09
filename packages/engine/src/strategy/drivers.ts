// Driver line-ups and the crew's driver-change policy (endurance rules). Pure functions of observable state,
// shared by every car's crew in the engine and by the planner's rollouts.
import type { Action, DriverSpec, Observation } from '@pitwall/shared';
import type { ModelBundle } from '../vehicle/model';

export function lineupFor(model: ModelBundle): DriverSpec[] {
  const r = model.cfg.race.rules.drivers;
  return r.lineups[String(model.durationHours)] ?? r.lineups['3'] ?? [{ name: 'Driver', pace: 1, rating: 'Platinum' }];
}

export function minDriveFor(model: ModelBundle): number {
  const r = model.cfg.race.rules.drivers;
  return r.minDrive_s[String(model.durationHours)] ?? 0;
}

export interface DriverChoiceInput {
  current: number;
  pace: number[];
  total_s: number[];
  continuous_s: number;
  minDrive_s: number;
  maxContinuous_s: number;
  /** race time left after this stop (s) */
  remainingAfter_s: number;
  /** expected length of the coming stint (s) */
  nextStint_s: number;
}

/**
 * Who drives the next stint:
 * 1. the current driver must hand over before exceeding the continuous limit;
 * 2. once the current driver has met the minimum, hand over to whoever still needs time (largest need first);
 * 3. if the remaining needs only just fit in the time left, hand over now even before the minimum is met;
 * 4. with every minimum met, put the fastest driver in (free at a stop with ≥ 18 kg of fuel: refuelling covers it).
 */
export function chooseDriver(i: DriverChoiceInput): number {
  const n = i.pace.length;
  if (n <= 1) return i.current;
  const need = i.total_s.map((t) => Math.max(0, i.minDrive_s - t));
  const others = [...Array(n).keys()].filter((d) => d !== i.current);
  const neediest = others.reduce((a, b) => (need[b] > need[a] ? b : a), others[0]);
  const fastest = [...Array(n).keys()].reduce((a, b) => (i.pace[b] < i.pace[a] ? b : a), 0);
  if (i.continuous_s + i.nextStint_s > i.maxContinuous_s) return need[neediest] > 0 ? neediest : others.reduce((a, b) => (i.pace[b] < i.pace[a] ? b : a), others[0]);
  const othersNeed = others.reduce((s, d) => s + need[d], 0);
  if (need[i.current] <= 0 && need[neediest] > 0) return neediest;
  if (need[i.current] > 0 && othersNeed > 0 && othersNeed + need[i.current] > 0.85 * i.remainingAfter_s) return neediest;
  if (need.every((x) => x <= 0) && i.current !== fastest && i.remainingAfter_s > 600) return fastest;
  return i.current;
}

/** Fill the driver change of a pit action from the observation (no change if the strategy already chose one). */
export function applyDriverPolicy(action: Action, obs: Observation, model: ModelBundle): Action {
  const d = obs.ego.drivers;
  if (!action.pit || !d || action.driverChange) return action;
  const tLap = obs.ego.lastLap_s > 60 && obs.ego.lastLap_s < 400 ? obs.ego.lastLap_s : model.lapRef;
  const fuelLaps = model.cfg.car.fuel.capacity_kg / model.cfg.car.fuel.qBase_kg_per_lap;
  const next = chooseDriver({
    current: d.current,
    pace: d.lineup.map((x) => x.pace),
    total_s: d.total_s.map((t, k) => (k === d.current ? t + tLap : t)),
    continuous_s: d.continuous_s + tLap,
    minDrive_s: d.minDrive_s,
    maxContinuous_s: d.maxContinuous_s,
    remainingAfter_s: Math.max(0, obs.remaining_s - tLap),
    nextStint_s: Math.min(Math.max(0, obs.remaining_s - tLap), fuelLaps * tLap),
  });
  return next === d.current ? action : { ...action, driverChange: true, nextDriver: next };
}
