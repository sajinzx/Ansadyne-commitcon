// M09 §9.2 — rival policies. Each rival sees its own observation and does not react to our strategy.
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

export function makeRivalPolicy(archetype: RivalArchetype, model: ModelBundle, u: number[]): RivalPolicy {
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
          return b1Decide(obs, history, model, { thresholds: th, reserveLaps: reserve }).action;
        },
      };
  }
}
