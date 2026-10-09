// M10 §10.3 — B0: static plan by exact dynamic programming under average conditions.
// Every stop fills by F_after(j) = min(capacity, q̄·(K − j + reserve)) where j is the out-lap index, so fuel at
// any lap is a function of the lap and the laps since the last stop: the DP state (k, a, s) needs no fuel bins.
import type { Belief, ObsHistory, Observation, Plan, PlanStop } from '@pitwall/shared';
import type { ModelBundle } from '../vehicle/model';
import { surrogateLap } from '../vehicle/model';
import { sCar, tyreTempNext, newTyreTemp, wearRate } from '../vehicle/tyre';
import { sTrack } from '../track/surface';
import { expectedService, netPitLoss } from '../sim/pit';
import { availableTyres, compoundFor, pitAction, stayAction, type Strategy, type StrategyContext, type StrategyOutput } from './strategy';
import { refuelRequest } from '../sim/pit';
import { trafficMoments } from '../estimator/ekf';

export interface DpParams {
  K: number; // laps to plan
  capacity: number;
  startFuel: number;
  qBar: number; // average burn per lap
  reserveLaps: number;
  aMax: number; // max laps on a set
  lapTime: (k: number, a: number, mass: number) => number; // racing lap time on a set aged a
  pitLoss: (refuel: number, tyres: boolean) => number; // net time lost by a stop
  entryFrac: number;
  wearLimitAge: number; // a at which the wear limit is reached
}

export interface DpResult {
  total: number;
  stops: { lap: number; refuel: number; tyres: boolean }[];
}

/** Fuel at the start of lap k with s laps since the stop whose out-lap was lap k − s. */
export function fuelAt(p: DpParams, k: number, s: number): number {
  const j = k - s;
  const after = j === 0 ? p.startFuel : Math.min(p.capacity, p.qBar * (p.K - j + p.reserveLaps));
  return after - p.qBar * s;
}

type Act = 0 | 1 | 2; // stay, pit fuel, pit fuel + tyres

export function solveDp(p: DpParams): DpResult {
  const { K, aMax } = p;
  const S = Math.ceil(p.capacity / p.qBar) + 2;
  const idx = (a: number, s: number) => a * (S + 1) + s;
  const size = (aMax + 1) * (S + 1);
  let next = new Float64Array(size); // V_{k+1}
  const choice: Int8Array[] = [];
  for (let k = K - 1; k >= 0; k--) {
    const cur = new Float64Array(size).fill(Infinity);
    const ch = new Int8Array(size).fill(-1);
    for (let a = 0; a <= aMax; a++) {
      for (let s = 0; s <= Math.min(S, k); s++) {
        const F = fuelAt(p, k, s);
        if (F < 0) continue;
        const mass = F - p.qBar / 2;
        const tLap = p.lapTime(k, a, mass);
        const lapsLeft = K - k;
        // stay: must be able to reach the box at the end of the next lap, unless the fuel reaches the flag
        const stayOk = (F >= p.qBar * (1 + p.entryFrac) || F >= p.qBar * lapsLeft) && a + 1 < p.wearLimitAge;
        if (stayOk) {
          const v = tLap + (k + 1 < K ? next[idx(Math.min(a + 1, aMax), Math.min(s + 1, S))] : 0);
          if (v < cur[idx(a, s)]) {
            cur[idx(a, s)] = v;
            ch[idx(a, s)] = 0;
          }
        }
        // pit at the end of lap k (not on an out-lap, not on the first lap, not on the last lap)
        if (s > 0 && k + 1 < K && F >= p.qBar * p.entryFrac) {
          const fBox = F - p.qBar * p.entryFrac;
          // the fill rule sets the out-lap fuel; a stop that would have to remove fuel is not allowed
          if (fBox > fuelAt(p, k + 1, 0) + 1e-9) continue;
          const refuel = fuelAt(p, k + 1, 0) - fBox;
          for (const act of [1, 2] as Act[]) {
            const tyres = act === 2;
            const a2 = tyres ? 0 : Math.min(a + 1, aMax);
            if (!tyres && a + 1 >= p.wearLimitAge) continue;
            const v = tLap + p.pitLoss(refuel, tyres) + next[idx(a2, 0)];
            if (v < cur[idx(a, s)]) {
              cur[idx(a, s)] = v;
              ch[idx(a, s)] = act;
            }
          }
        }
      }
    }
    choice[k] = ch;
    next = cur;
  }
  // forward pass from (k = 0, a = 0, s = 0)
  const stops: DpResult['stops'] = [];
  let a = 0;
  let s = 0;
  for (let k = 0; k < K; k++) {
    const act = choice[k][idx(a, s)];
    if (act === 1 || act === 2) {
      const F = fuelAt(p, k, s);
      const fBox = F - p.qBar * p.entryFrac;
      stops.push({ lap: k + 1, refuel: Math.max(0, fuelAt(p, k + 1, 0) - fBox), tyres: act === 2 });
      a = act === 2 ? 0 : Math.min(a + 1, p.aMax);
      s = 0;
    } else {
      a = Math.min(a + 1, p.aMax);
      s = Math.min(s + 1, Math.ceil(p.capacity / p.qBar) + 2);
    }
  }
  return { total: next[idx(0, 0)], stops };
}

/** DP parameters for the model under average conditions (dry, multipliers 1, prior coefficients, no cautions). */
export function dpParams(model: ModelBundle): DpParams {
  const cfg = model.cfg;
  const car = cfg.car;
  const egoField = cfg.field.cars.find((c) => c.no === cfg.field.ego)!;
  const K = Math.ceil(cfg.race.duration_s / model.lapRef) + 1;
  const qBar = car.fuel.qBase_kg_per_lap;
  const trackT = 30;
  const rubber = 0.03;
  const Strk = sTrack(trackT, rubber, 0, cfg.track.meanDryGrip);
  const comp = car.tyres.dry;
  const aMax = Math.ceil(comp.Wlimit / comp.kBase_per_lap) + 2;
  // deterministic tyre trajectory on a dry set: temperature and wear by age
  const temps: number[] = [];
  const wears: number[] = [];
  let T = newTyreTemp(car, 22);
  let W = 0;
  const mMidRef = car.mass_dry_kg.value + car.fuel.capacity_kg / 2;
  let wearLimitAge = aMax + 1;
  for (let a = 0; a <= aMax; a++) {
    temps.push(T);
    wears.push(W);
    if (W >= comp.Wlimit && wearLimitAge > aMax) wearLimitAge = a;
    W += wearRate(car, { compound: 'dry', bY: 0, wearMult: egoField.wearMult, mMid: mMidRef, tyreTemp: T, mode: 'normal', fc: 0, w: 0, Y: 1 });
    T = tyreTempNext(car, T, trackT, 'normal', mMidRef, 1, 0, 0);
  }
  const lapCache = new Map<string, number>();
  const lapTime = (_k: number, a: number, fuelMid: number) => {
    const key = `${a}|${Math.round(fuelMid * 4)}`;
    let v = lapCache.get(key);
    if (v === undefined) {
      const S = sCar(car, { compound: 'dry', w: 0, tyreTemp: temps[a], wear: wears[a], X: 1, gripSkill: egoField.gripSkill, wetSkill: 1 }) * Strk;
      v = surrogateLap(model, S, car.mass_dry_kg.value + Math.max(0, fuelMid), 0, 'normal', 22) * egoField.paceFactor + trafficMoments(cfg.race).mean;
      lapCache.set(key, v);
    }
    return v;
  };
  return {
    K,
    capacity: car.fuel.capacity_kg,
    startFuel: cfg.race.startingFuel_kg,
    qBar,
    reserveLaps: car.fuel.reserveLaps,
    aMax,
    lapTime,
    pitLoss: (refuel, tyres) => netPitLoss(model, expectedService(model, refuel, tyres ? 'dry' : 'none'), model.lapRef, false),
    entryFrac: model.lane.entryS / model.lapLength,
    wearLimitAge,
  };
}

export function b0Plan(model: ModelBundle): Plan {
  const r = solveDp(dpParams(model));
  const stops: PlanStop[] = r.stops.map((s) => ({ lap: s.lap, refuel: s.refuel, tyres: s.tyres ? 'dry' : 'none' }));
  return { stops, mode: null, source: 'b0_dp', committedLap: 0 };
}

export class B0Strategy implements Strategy {
  readonly id = 'B0' as const;
  private plan: Plan;
  constructor(plan: Plan) {
    this.plan = structuredClone(plan);
  }

  decide(obs: Observation, _h: ObsHistory, _b: Belief | null, ctx: StrategyContext): StrategyOutput {
    const lapNext = obs.lap + 1;
    // physically required compound swap
    if (obs.ego.compound === 'dry' && obs.wetness_est > 0.5 && !obs.ego.lastLapFlags.inLap && obs.ego.setsLeft.wet > 0) {
      return { action: pitAction(ctx.model, obs, obs.ego.fuelGauge_kg, 'wet'), plan: this.plan, note: 'compound swap' };
    }
    if (obs.ego.compound === 'wet' && obs.wetness_est < 0.1 && !obs.ego.lastLapFlags.inLap && obs.ego.setsLeft.dry > 0) {
      return { action: pitAction(ctx.model, obs, obs.ego.fuelGauge_kg, 'dry'), plan: this.plan, note: 'compound swap' };
    }
    // drop stops that are in the past (taken or refused)
    this.plan.stops = this.plan.stops.filter((s) => s.lap >= lapNext);
    const stop = this.plan.stops[0];
    if (stop && stop.lap === lapNext && !obs.ego.lastLapFlags.inLap) {
      const tyres = stop.tyres === 'none' ? 'none' : availableTyres(obs, compoundFor(obs.wetness_est));
      const refuel =
        stop.refuel === 'helper'
          ? refuelRequest(ctx.model, obs.ego.fuelGauge_kg, ctx.model.cfg.car.fuel.qBase_kg_per_lap, obs.raceTime_s + ctx.model.lapRef, ctx.model.lapRef)
          : stop.refuel;
      return { action: { pit: true, refuel_kg: refuel, tyres, driverChange: false, mode: 'normal' }, plan: this.plan };
    }
    return { action: stayAction(), plan: this.plan };
  }
  getState(): unknown {
    return { plan: this.plan };
  }
  setState(s: unknown): void {
    this.plan = structuredClone((s as { plan: Plan }).plan);
  }
  currentPlan(): Plan | null {
    return this.plan;
  }
}
