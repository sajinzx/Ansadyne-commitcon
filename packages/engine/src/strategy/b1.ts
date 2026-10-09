// M10 §10.2 — B1: reactive crew-chief rules from the observation and simple bookkeeping (no filter).
import type { Action, B1Thresholds, Belief, ObsHistory, Observation, Plan } from '@pitwall/shared';
import type { ModelBundle } from '../vehicle/model';
import { driverStatus } from './drivers';
import { availableTyres, burnEstimate, compoundFor, pitAction, stayAction, wearByAge, type Strategy, type StrategyContext, type StrategyOutput } from './strategy';

export interface B1Options {
  thresholds: B1Thresholds;
  reserveLaps: number;
  alwaysTyres?: boolean;
}

export type B1Rule = 'fuel' | 'caution' | 'wetIn' | 'wetOut' | 'wear' | 'driver' | null;

/** Evaluate the B1 rules; returns the action and which rule fired. */
export function b1Decide(obs: Observation, history: ObsHistory, model: ModelBundle, opt: B1Options): { action: Action; rule: B1Rule } {
  const th = opt.thresholds;
  const stay = { action: stayAction(), rule: null as B1Rule };
  if (!obs.ego.running) return stay;
  // the next lap is an out-lap: pitting is not allowed
  if (obs.ego.lastLapFlags.inLap) return stay;
  const L = model.lapLength;
  const entryFrac = model.lane.entryS / L;
  const F = obs.ego.fuelGauge_kg;
  const q = burnEstimate(model, obs);
  const W = wearByAge(model, obs);
  const cap = model.cfg.car.fuel.capacity_kg;
  const want = compoundFor(obs.wetness_est);
  const tyresIf = (thresh: number) => (opt.alwaysTyres || W >= thresh ? availableTyres(obs, want) : 'none');

  // laps still to run including the lap in which the flag falls (time-certain race)
  const tLap = obs.ego.lastLap_s > 60 && obs.ego.lastLap_s < 400 ? obs.ego.lastLap_s : model.lapRef;
  const lapsToGo = Math.ceil(Math.max(0, obs.remaining_s) / tLap) + 1;
  const qGreen = burnEstimate(model, { ...obs, flag: 'green' });
  const enoughToFinish = F >= qGreen * (lapsToGo + 0.3);
  if (!enoughToFinish && F - q - qGreen * entryFrac < opt.reserveLaps * qGreen) {
    return { action: pitAction(model, obs, F, tyresIf(th.fuelTyreWear)), rule: 'fuel' };
  }
  const drv = driverStatus(obs, model);
  if (lapsToGo > 6 && obs.flag === 'caution' && obs.pitOpen && (obs.ego.fuelUsedSinceStop_kg >= th.cautionFuelUsed * cap || W >= th.cautionWear)) {
    return { action: pitAction(model, obs, F, tyresIf(th.cautionTyreWear)), rule: 'caution' };
  }
  // driver change: take it under a caution once the current driver has done their minimum, or at the last moment
  const cautionChange = obs.flag === 'caution' && obs.pitOpen && drv.need_s > 0 && drv.ownNeed_s <= 0 && obs.remaining_s > drv.need_s + 2 * tLap;
  if (drv.due || cautionChange) {
    if (obs.flag === 'green' || obs.pitOpen) return { action: pitAction(model, obs, F, tyresIf(th.cautionTyreWear)), rule: 'driver' };
  }
  if (obs.ego.compound === 'dry' && obs.wetness_est >= th.wetIn && obs.ego.setsLeft.wet > 0) {
    return { action: pitAction(model, obs, F, 'wet'), rule: 'wetIn' };
  }
  if (obs.ego.compound === 'wet' && obs.ego.setsLeft.dry > 0) {
    const recent = [...history.last.slice(-2), obs];
    if (recent.length >= 3 && recent.every((o) => o.wetness_est <= th.wetOut)) {
      return { action: pitAction(model, obs, F, 'dry'), rule: 'wetOut' };
    }
  }
  if (lapsToGo > 6 && W >= th.wearLimit) {
    return { action: pitAction(model, obs, F, availableTyres(obs, want)), rule: 'wear' };
  }
  return stay;
}

/** Laps until B1's fuel or wear rule would fire (for the stint timeline and OPT candidates). */
export function projectNextStop(obs: Observation, model: ModelBundle, opt: B1Options): number {
  const L = model.lapLength;
  const q = burnEstimate(model, { ...obs, flag: 'green' });
  const fuelLaps = Math.floor((obs.ego.fuelGauge_kg - q * (1 + model.lane.entryS / L) - opt.reserveLaps * q) / q) + 1;
  const kBase = model.cfg.car.tyres[obs.ego.compound].kBase_per_lap;
  const wearLaps = Math.floor((opt.thresholds.wearLimit - wearByAge(model, obs)) / kBase) + 1;
  return Math.max(0, Math.min(fuelLaps, wearLaps));
}

export class B1Strategy implements Strategy {
  readonly id = 'B1' as const;
  private plan: Plan | null = null;
  constructor(private readonly opt: B1Options) {}

  decide(obs: Observation, history: ObsHistory, _belief: Belief | null, ctx: StrategyContext): StrategyOutput {
    const { action, rule } = b1Decide(obs, history, ctx.model, this.opt);
    const next = action.pit ? 0 : projectNextStop(obs, ctx.model, this.opt);
    this.plan = {
      stops: [{ lap: obs.lap + 1 + next, refuel: 'helper', tyres: 'dry' }],
      mode: null,
      source: 'b1_projection',
      committedLap: obs.lap,
    };
    return { action, plan: this.plan, note: rule ?? undefined };
  }
  getState(): unknown {
    return { plan: this.plan };
  }
  setState(s: unknown): void {
    this.plan = (s as { plan: Plan | null }).plan;
  }
  currentPlan(): Plan | null {
    return this.plan;
  }
}

export function defaultB1Options(model: ModelBundle): B1Options {
  return { thresholds: model.cfg.planner.b1, reserveLaps: model.cfg.car.fuel.reserveLaps };
}
