// M10 §10.1 — strategy interface. Strategies see only observations, history and their own belief (R3).
import type { Action, Belief, Compound, Decision, ObsHistory, Observation, Plan, StrategyId } from '@pitwall/shared';
import type { ModelBundle } from '../vehicle/model';
import { nominalBurn } from '../vehicle/fuel';
import { refuelRequest } from '../sim/pit';

export interface StrategyContext {
  model: ModelBundle;
  masterSeed: number;
  decisionIdx: number;
}

export interface StrategyOutput {
  action: Action;
  plan?: Plan | null;
  decision?: Decision;
  trigger?: string;
  note?: string;
}

export interface Strategy {
  id: StrategyId;
  decide(obs: Observation, history: ObsHistory, belief: Belief | null, ctx: StrategyContext): StrategyOutput;
  getState(): unknown;
  setState(s: unknown): void;
  /** current plan for display (stint timeline), if any */
  currentPlan(): Plan | null;
}

export function stayAction(mode: Action['mode'] = 'normal'): Action {
  return { pit: false, refuel_kg: 0, tyres: 'none', driverChange: false, mode };
}

/** Compound suited to the observed conditions. */
export function compoundFor(wetness: number): Compound {
  return wetness >= 0.25 ? 'wet' : 'dry';
}

/** Pick an available compound: preferred if a set is left, else the other, else none. */
export function availableTyres(obs: Observation, preferred: Compound): 'none' | Compound {
  if (obs.ego.setsLeft[preferred] > 0) return preferred;
  const other: Compound = preferred === 'dry' ? 'wet' : 'dry';
  if (preferred === 'wet' && obs.ego.setsLeft.dry > 0 && obs.wetness_est < 0.3) return other;
  return 'none';
}

/** Expected burn per lap from the observation (green nominal, caution-adjusted). */
export function burnEstimate(model: ModelBundle, obs: Observation, mode: Action['mode'] = 'normal'): number {
  return nominalBurn(model.cfg.car, mode, obs.flag === 'caution' ? 1 : 0);
}

/** Pit action with fuel from the refuel helper (estimates only). */
export function pitAction(model: ModelBundle, obs: Observation, fuelEst: number, tyres: 'none' | Compound, mode: Action['mode'] = 'normal'): Action {
  const qGreen = nominalBurn(model.cfg.car, mode);
  const tLap = obs.ego.lastLap_s > 60 && obs.ego.lastLap_s < 400 ? obs.ego.lastLap_s : model.lapRef;
  const refuel = refuelRequest(model, fuelEst, qGreen, obs.raceTime_s + tLap, model.lapRef);
  return { pit: true, refuel_kg: refuel, tyres, driverChange: false, mode };
}

/** Rough wear estimate from tyre age and the prior wear rate (B1 bookkeeping, no filter). */
export function wearByAge(model: ModelBundle, obs: Observation): number {
  return obs.ego.tyreAgeLaps * model.cfg.car.tyres[obs.ego.compound].kBase_per_lap;
}
