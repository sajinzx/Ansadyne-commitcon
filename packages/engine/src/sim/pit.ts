// M07 — one pit route model: pure timing and fuel functions (shared by the engine, baselines and planner).
import type { Compound } from '@pitwall/shared';
import type { ModelBundle } from '../vehicle/model';
import { lapFraction } from '../vehicle/model';

export interface ServiceInputs {
  refuel_kg: number;
  tyres: 'none' | Compound;
  driverChange: boolean;
  /** pre-drawn variability for this stop; omit for expected (noise-free) service */
  logN?: number;
  slowU?: number;
  slowAddU?: number;
  repair_s?: number;
}

/** Service time in the box (M07 §7.5). */
export function serviceTime(model: ModelBundle, i: ServiceInputs): number {
  const car = model.cfg.car;
  const rules = model.cfg.race.rules;
  const tFuel = i.refuel_kg / car.pit.refuelRate_kg_s;
  const tTyres = i.tyres !== 'none' ? car.pit.tyreChange4_s : 0;
  const tDriver = i.driverChange ? car.pit.driverChange_s : 0;
  let base = rules.serviceMode.value === 'parallel' ? Math.max(tFuel, tTyres, tDriver) : Math.max(tFuel, tDriver) + tTyres;
  base = Math.max(base, rules.minPitService_s.value);
  let svc = base;
  if (i.logN !== undefined) {
    svc = base * Math.exp(car.pit.serviceLogSigma * i.logN);
    if ((i.slowU ?? 1) < car.pit.slowStopProb) {
      const [lo, hi] = car.pit.slowStopAdd_s;
      svc += lo + (hi - lo) * (i.slowAddU ?? 0);
    }
  }
  return Math.max(svc, i.repair_s ?? 0);
}

/** Expected service time (lognormal mean factor and slow-stop mean included). */
export function expectedService(model: ModelBundle, refuel_kg: number, tyres: 'none' | Compound): number {
  const car = model.cfg.car;
  const base = serviceTime(model, { refuel_kg, tyres, driverChange: false });
  const meanFactor = Math.exp(0.5 * car.pit.serviceLogSigma ** 2);
  const [lo, hi] = car.pit.slowStopAdd_s;
  return base * meanFactor + car.pit.slowStopProb * (lo + hi) / 2;
}

/** In-lap: track 0 → pit entry, entry loss, lane to the timing line (the lap ends inside the lane). */
export function inLapTime(model: ModelBundle, tLap: number, caution: boolean): number {
  const L = model.lane;
  return tLap * lapFraction(model, L.entryS, caution) + L.entryLoss + L.toLine;
}

/** Out-lap: lane line → box, service, box → exit, exit loss, track exit → line. */
export function outLapTime(model: ModelBundle, service: number, tLapNext: number, caution: boolean): number {
  const L = model.lane;
  return L.lineToBox + service + L.boxToExit + L.exitLoss + tLapNext * (1 - lapFraction(model, L.exitS, caution));
}

/** Time between the in-lap's line crossing and box arrival. */
export function lineToBoxTime(model: ModelBundle): number {
  return model.lane.lineToBox;
}

export function totalPit(model: ModelBundle, service: number): number {
  const L = model.lane;
  return L.entryLoss + L.transit + service + L.exitLoss;
}

/** Track time a car would have spent on the bypassed stretch (entry → line → exit). */
export function tStretch(model: ModelBundle, tLap: number, caution: boolean): number {
  const L = model.lane;
  return tLap * (1 - lapFraction(model, L.entryS, caution)) + tLap * lapFraction(model, L.exitS, caution);
}

export function netPitLoss(model: ModelBundle, service: number, tLap: number, caution: boolean): number {
  return totalPit(model, service) - tStretch(model, tLap, caution);
}

/** Fuel left on arrival at pit entry (the lane burns nothing). */
export function fuelAtBox(model: ModelBundle, F: number, q: number): number {
  return F - (q * model.lane.entryS) / model.lapLength;
}

/**
 * Refuel helper (M07 §7.4), using estimates only.
 * @param fHat estimated fuel at the start of the in-lap, qHat estimated burn per lap
 * @param tBoxHat estimated race time at box arrival, tLapHat expected lap time
 */
export function refuelRequest(model: ModelBundle, fHat: number, qHat: number, tBoxHat: number, tLapHat: number): number {
  const fBox = fuelAtBox(model, fHat, qHat);
  const cap = model.cfg.car.fuel.capacity_kg;
  const lapsLeft = Math.ceil(Math.max(0, model.cfg.race.duration_s - tBoxHat) / tLapHat) + 1;
  const want = qHat * (lapsLeft + model.cfg.car.fuel.reserveLaps) - fBox;
  return Math.max(0, Math.min(want, cap - Math.max(0, fBox)));
}

export interface PitDiagnostics {
  fullStop_s: number;
  netGreen_s: number;
  netCaution_s: number;
}

export function pitDiagnostics(model: ModelBundle): PitDiagnostics {
  const svc = serviceTime(model, { refuel_kg: 80, tyres: 'dry', driverChange: false });
  const full = totalPit(model, svc);
  const tPace = model.cfg.race.caution.paceLapFactor * model.lapRef;
  return {
    fullStop_s: full,
    netGreen_s: full - tStretch(model, model.lapRef, false),
    netCaution_s: full - tStretch(model, tPace, true),
  };
}
