// M08 §8.2 — truth state. NEVER imported by strategy/**, estimator/** or planner/** (lint rule R3).
import type { Compound, DnfCause, DriverSpec, FieldCar, Mode, RaceEvent, StrategyId, Stint, CarLapRecord } from '@pitwall/shared';
import type { ModelBundle } from '../vehicle/model';
import type { Predraw } from '../rng/predraw';
import { newTyreTemp } from '../vehicle/tyre';
import { lineupFor } from '../strategy/drivers';

export type ForcedReason = 'fuel' | 'wearLimit' | 'puncture' | 'repair' | 'driveTime';

export interface PendingOutLap {
  service_s: number;
  refuelApplied_kg: number;
  tyres: 'none' | Compound;
  t_line: number;
  repaired: boolean;
  /** incoming driver index, or null when the same driver stays in */
  driverTo: number | null;
}

export interface CarTruth {
  no: number;
  idx: number;
  field: FieldCar;
  running: boolean;
  classified: boolean;
  dnf?: { cause: DnfCause; atTime_s: number; atLapDist_m: number };
  laps: number; // line crossings completed
  lapStart_s: number;
  lastLapTime_s: number;
  crossings: number[];
  fuel_kg: number;
  compound: Compound;
  wear: number;
  tyreTemp_C: number;
  tyreAgeLaps: number;
  lapsSinceStop: number;
  lnX: number;
  lnY: number;
  lnZ: number;
  coeff: { bY: number; bZ: number; heat: number };
  pace: { paceFactor: number; gripSkill: number };
  mode: Mode;
  setsLeft: { dry: number; wet: number };
  stopIndex: number;
  stops: number;
  pendingOutLap: PendingOutLap | null;
  forced: ForcedReason[];
  repair_s: number;
  stints: Stint[];
  fuelUsedSinceStop_kg: number;
  lastRefuelApplied_kg: number | null;
  /** tread-depth measurement of the set removed at the last stop (reported on the out-lap only) */
  treadMeasured: { wear: number; laps: number; compound: Compound } | null;
  /** driver line-up, who is driving, drive-time bookkeeping */
  drivers: { lineup: DriverSpec[]; current: number; total_s: number[]; continuous_s: number };
  /** classified behind compliant finishers: a driver missed the minimum drive time */
  driveViolation: boolean;
  lastLap: CarLapRecord | null;
  lastLapFlags: { inLap: boolean; outLap: boolean; caution: boolean; incident: boolean };
  pittedThisCaution: boolean;
  fuelSpikeLaps: number;
  gapAhead_s: number;
  gapBehind_s: number;
  position: number;
}

export interface CautionState {
  active: boolean;
  t_c: number;
  durationLaps: number;
  leaderCrossings: number;
  pitOpenTime: number | null;
  t_end: number | null;
  cause: 'background' | 'incident' | 'failure' | 'injected';
  startStep: number;
}

export interface WorldTruth {
  id: StrategyId;
  step: number;
  caution: CautionState | null;
  /** every caution of the race (same objects as `caution`, kept after they end) */
  cautionLog: CautionState[];
  lastCautionEndStep: number;
  pendingCautionStart_s: number | null;
  pendingCautionCause: 'incident' | 'failure' | null;
  forceCautionThisStep: boolean;
  cars: CarTruth[];
  finish: { T_finish_s: number | null };
  events: RaceEvent[];
  finished: boolean;
}

export function initWorld(id: StrategyId, model: ModelBundle, pd: Predraw, field: FieldCar[], egoNo: number, egoGrid: number): WorldTruth {
  const car = model.cfg.car;
  const race = model.cfg.race;
  // grid: our car takes egoGrid; rivals keep their relative order
  const rivals = field.filter((c) => c.no !== egoNo).sort((a, b) => a.grid - b.grid);
  const ego = field.find((c) => c.no === egoNo)!;
  const order: FieldCar[] = [...rivals];
  order.splice(Math.max(0, Math.min(rivals.length, egoGrid - 1)), 0, ego);
  const gridSlot = new Map(order.map((c, i) => [c.no, i + 1]));
  const sets = model.tyreSets;
  const lineup = lineupFor(model);
  const cars: CarTruth[] = field.map((fc, idx) => {
    const isEgo = fc.no === egoNo;
    const g = gridSlot.get(fc.no)!;
    const start = 0.6 * (g - 1);
    return {
      no: fc.no,
      idx,
      field: fc,
      running: true,
      classified: false,
      laps: 0,
      lapStart_s: start,
      lastLapTime_s: 0,
      crossings: [],
      fuel_kg: race.startingFuel_kg,
      compound: race.startingCompound,
      wear: 0,
      tyreTemp_C: newTyreTemp(car, 22) + 20, // tyres warmed by formation laps
      tyreAgeLaps: 0,
      lapsSinceStop: 0,
      lnX: 0,
      lnY: 0,
      lnZ: 0,
      coeff: {
        bY: 0.1 * pd.kBaseN.get(idx) * model.coeffSpread,
        bZ: 0.03 * pd.qBaseN.get(idx) * model.coeffSpread,
        heat: Math.exp(0.08 * pd.heatN.get(idx)),
      },
      pace: isEgo
        ? { paceFactor: fc.paceFactor, gripSkill: fc.gripSkill }
        : {
            paceFactor: fc.paceFactor * Math.exp(0.002 * pd.rivalPaceN.get(idx)),
            gripSkill: fc.gripSkill * Math.exp(0.002 * pd.rivalGripN.get(idx)),
          },
      mode: 'normal',
      setsLeft: { dry: sets.dry - (race.startingCompound === 'dry' ? 1 : 0), wet: sets.wet - (race.startingCompound === 'wet' ? 1 : 0) },
      stopIndex: 0,
      stops: 0,
      pendingOutLap: null,
      forced: [],
      repair_s: 0,
      stints: [{ startLap: 0, compound: race.startingCompound, startFuel_kg: race.startingFuel_kg, laps: 0 }],
      fuelUsedSinceStop_kg: 0,
      lastRefuelApplied_kg: null,
      treadMeasured: null,
      drivers: { lineup: lineup.map((d) => ({ ...d })), current: 0, total_s: lineup.map(() => 0), continuous_s: 0 },
      driveViolation: false,
      lastLap: null,
      lastLapFlags: { inLap: false, outLap: false, caution: false, incident: false },
      pittedThisCaution: false,
      fuelSpikeLaps: 0,
      gapAhead_s: 0.6,
      gapBehind_s: 0.6,
      position: g,
    };
  });
  return {
    id,
    step: 0,
    caution: null,
    cautionLog: [],
    lastCautionEndStep: -100,
    pendingCautionStart_s: null,
    pendingCautionCause: null,
    forceCautionThisStep: false,
    cars,
    finish: { T_finish_s: null },
    events: [],
    finished: false,
  };
}
