// M09 §9.2 — rival policies. Each rival sees its own observation. Reactive and aggressive-caution rivals also
// cover undercuts: when a car within a few seconds pits under green, they pit next lap if their window is open,
// so our strategy now meets real resistance.
import type { Action, B1Thresholds, ObsHistory, Observation, RivalArchetype } from '@pitwall/shared';
import type { ModelBundle } from '../vehicle/model';
import { b1Decide } from './b1';
import { availableTyres, burnEstimate, compoundFor, pitAction, stayAction } from './strategy';

export interface RivalPolicy {
  archetype: RivalArchetype;
  decide(obs: Observation, history: ObsHistory): Action;
}

/** Jitter every threshold by ±10% with pre-drawn uniforms (fixed once per race). */
export function jitterThresholds(base: B1Thresholds, u: number[]): B1Thresholds {
  const keys = Object.keys(base) as (keyof B1Thresholds)[];
  const out = { ...base };
  keys.forEach((key, i) => {
    out[key] = base[key] * (1 + 0.1 * (2 * (u[i % u.length] ?? 0.5) - 1));
  });
  return out;
}

/** Undercut cover: a car within `window_s` pitted on the last green lap and this car is well into its stint. */
export function shouldCover(obs: Observation, history: ObsHistory, model: ModelBundle, window_s: number, stintShare: number): boolean {
  const prev = history.last[history.last.length - 1];
  if (!prev || !obs.ego.running || obs.ego.lastLapFlags.inLap || obs.flag !== 'green' || !obs.pitOpen) return false;
  const tLap = obs.ego.lastLap_s > 60 && obs.ego.lastLap_s < 400 ? obs.ego.lastLap_s : model.lapRef;
  if (obs.remaining_s / tLap < 8) return false;
  const q0 = model.cfg.car.fuel.qBase_kg_per_lap;
  const stint = Math.floor((model.cfg.car.fuel.capacity_kg - model.cfg.car.fuel.reserveLaps * q0) / q0);
  if (obs.ego.lapsSinceStop < stintShare * stint) return false;
  return obs.rivals.some((r) => {
    const p = prev.rivals.find((x) => x.no === r.no);
    return !!p && r.running && r.stops > p.stops && Math.abs(r.gap_s) <= window_s;
  });
}

export function makeRivalPolicy(archetype: RivalArchetype, model: ModelBundle, u: number[]): RivalPolicy {
  const coverWindow = 3.0 * (0.8 + 0.4 * (u[7] ?? 0.5)); // 2.4–3.6 s, per rival
  const coverShare = 0.55 + 0.2 * (u[6] ?? 0.5); // 55–75% of the fuel window
  const th = jitterThresholds(model.cfg.planner.b1, u);
  const reserve = model.cfg.car.fuel.reserveLaps;
  const cap = model.cfg.car.fuel.capacity_kg;
  const q0 = model.cfg.car.fuel.qBase_kg_per_lap;
  switch (archetype) {
    case 'fixedStint': {
      const stint = Math.floor((cap - reserve * q0) / q0);
      return {
        archetype,
        decide(obs) {
          if (!obs.ego.running || obs.ego.lastLapFlags.inLap) return stayAction();
          const lapsIn = obs.ego.lapsSinceStop;
          const due = lapsIn + 1 >= stint;
          const cautionStop = obs.flag === 'caution' && obs.pitOpen && stint - lapsIn <= 6;
          const fuelLow = obs.ego.fuelGauge_kg - burnEstimate(model, obs) * 2 < reserve * q0;
          if (due || cautionStop || fuelLow) {
            const tyres = obs.ego.stops % 2 === 1 ? availableTyres(obs, compoundFor(obs.wetness_est)) : 'none';
            return pitAction(model, obs, obs.ego.fuelGauge_kg, tyres);
          }
          if (obs.ego.compound === 'dry' && obs.wetness_est >= th.wetIn) return pitAction(model, obs, obs.ego.fuelGauge_kg, availableTyres(obs, 'wet'));
          return stayAction();
        },
      };
    }
    case 'aggressiveCaution':
      return {
        archetype,
        decide(obs, history) {
          const base = b1Decide(obs, history, model, { thresholds: th, reserveLaps: reserve });
          if (base.action.pit) return base.action;
          if (shouldCover(obs, history, model, coverWindow, coverShare)) {
            return pitAction(model, obs, obs.ego.fuelGauge_kg, availableTyres(obs, compoundFor(obs.wetness_est)));
          }
          if (
            obs.ego.running &&
            !obs.ego.lastLapFlags.inLap &&
            obs.flag === 'caution' &&
            obs.pitOpen &&
            obs.ego.fuelUsedSinceStop_kg >= 0.3 * cap
          ) {
            return pitAction(model, obs, obs.ego.fuelGauge_kg, availableTyres(obs, compoundFor(obs.wetness_est)));
          }
          return base.action;
        },
      };
    case 'conservative':
      return {
        archetype,
        decide(obs, history) {
          // never pits under caution unless fuel for < 8 laps remains
          const noCaution: Observation =
            obs.flag === 'caution' && obs.ego.fuelGauge_kg / burnEstimate(model, obs) >= 8 ? { ...obs, pitOpen: false } : obs;
          return b1Decide(noCaution, history, model, { thresholds: th, reserveLaps: 2, alwaysTyres: true }).action;
        },
      };
    case 'reactive':
    default:
      return {
        archetype,
        decide(obs, history) {
          const base = b1Decide(obs, history, model, { thresholds: th, reserveLaps: reserve }).action;
          if (!base.pit && shouldCover(obs, history, model, coverWindow, coverShare)) {
            const W = obs.ego.tyreAgeLaps * model.cfg.car.tyres[obs.ego.compound].kBase_per_lap;
            return pitAction(model, obs, obs.ego.fuelGauge_kg, W >= th.fuelTyreWear ? availableTyres(obs, compoundFor(obs.wetness_est)) : 'none');
          }
          return base;
        },
      };
  }
}
