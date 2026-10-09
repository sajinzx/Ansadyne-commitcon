// M03 §3.5 — start-up calibration of mu_peak to the illustrative reference lap, plus emergent diagnostics.
import type { CarConfig } from '@pitwall/shared';
import type { TrackGeometry } from '../track/geometry';
import { nodeFactors, sTrack } from '../track/surface';
import { QssSolver, airDensity, qssCar, type QssResult } from './qss';
import { REF_AIR_TEMP } from './surrogate';

export interface TauCurve {
  /** node distances (m), length n+1 including the lap end */
  s: Float64Array;
  /** cumulative-time fraction at each node, tau[0] = 0, tau[n] = 1 */
  tau: Float64Array;
}

export function tauAt(curve: TauCurve, sIn: number): number {
  const L = curve.s[curve.s.length - 1];
  const s = Math.max(0, Math.min(L, sIn));
  const ds = curve.s[1] - curve.s[0];
  const i = Math.min(Math.floor(s / ds), curve.s.length - 2);
  const f = (s - curve.s[i]) / ds;
  return curve.tau[i] + (curve.tau[i + 1] - curve.tau[i]) * f;
}

/** Inverse of tau: lap distance at cumulative-time fraction phi. */
export function tauInverse(curve: TauCurve, phi: number): number {
  const p = Math.max(0, Math.min(1, phi));
  let lo = 0;
  let hi = curve.tau.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve.tau[mid] <= p) lo = mid;
    else hi = mid;
  }
  const span = curve.tau[hi] - curve.tau[lo] || 1;
  return curve.s[lo] + ((p - curve.tau[lo]) / span) * (curve.s[hi] - curve.s[lo]);
}

export interface Calibration {
  muPeak: number;
  power_kW: number;
  sRef: number;
  massRef: number;
  rhoRef: number;
  reference: QssResult;
  tau: TauCurve;
  tStretchRef: number;
  physics: {
    c_f_s_per_kg: number;
    topSpeed_kph: number;
    topSpeedAt_m: number;
    topSpeedSegment: string;
    minSpeedS04_kph: number;
    minSpeedS08_kph: number;
    dT_dS: number;
  };
}

export function calibrate(geo: TrackGeometry, car: CarConfig): Calibration {
  const ref = car.referenceConditions;
  const solver = new QssSolver(geo.grid, qssCar(car));
  const nodes = nodeFactors(geo.cfg, geo.grid, ref.wetness, []);
  const sRef = sTrack(ref.trackTemp_C, ref.rubber, ref.wetness, geo.cfg.meanDryGrip); // S_car = 1 at reference
  const massRef = car.mass_dry_kg.value + ref.fuel_kg;
  const rhoRef = airDensity(REF_AIR_TEMP);
  const target = car.lapRef_s.value;
  let power_kW = car.power_kW.value;
  const lapAt = (mu: number, pkw: number) => solver.solve(nodes, mu * sRef, massRef, pkw * 1000, rhoRef).lapTime;

  let lo = 0.8;
  let hi = 2.6;
  let muPeak: number;
  if (lapAt(hi, power_kW) > target || lapAt(lo, power_kW) < target) {
    // unreachable inside the mu range: hold mu at the bound and bisect power within ±15%
    muPeak = lapAt(hi, power_kW) > target ? hi : lo;
    let plo = power_kW * 0.85;
    let phi = power_kW * 1.15;
    for (let it = 0; it < 40; it++) {
      const mid = (plo + phi) / 2;
      if (lapAt(muPeak, mid) > target) plo = mid;
      else phi = mid;
    }
    power_kW = (plo + phi) / 2;
  } else {
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      if (lapAt(mid, power_kW) > target) lo = mid;
      else hi = mid;
    }
    muPeak = (lo + hi) / 2;
  }

  const reference = solver.solve(nodes, muPeak * sRef, massRef, power_kW * 1000, rhoRef, true);
  const n = geo.grid.n;
  const s = new Float64Array(n + 1);
  const tau = new Float64Array(n + 1);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    s[i] = i * geo.grid.ds;
    tau[i] = acc / reference.lapTime;
    acc += reference.dt[i];
  }
  s[n] = geo.lapLength;
  tau[n] = 1;
  const curve: TauCurve = { s, tau };
  const T = reference.lapTime;
  const lane = geo.cfg.pitLane;
  const tStretchRef = T * (1 - tauAt(curve, lane.entry_s_m)) + T * tauAt(curve, lane.exit_s_m);

  const lapMass = (m: number) => solver.solve(nodes, muPeak * sRef, m, power_kW * 1000, rhoRef).lapTime;
  const c_f = (lapMass(massRef + 5) - lapMass(massRef - 5)) / 10;
  const lapS = (S: number) => solver.solve(nodes, muPeak * S, massRef, power_kW * 1000, rhoRef).lapTime;
  const dT_dS = (lapS(sRef + 0.01) - lapS(sRef - 0.01)) / 0.02;
  let vmax = 0;
  let imax = 0;
  for (let i = 0; i < n; i++)
    if (reference.v[i] > vmax) {
      vmax = reference.v[i];
      imax = i;
    }
  const segMin = (id: string) => {
    let m = Infinity;
    for (let i = 0; i < n; i++) if (geo.cfg.segments[geo.grid.seg[i]].id === id) m = Math.min(m, reference.v[i]);
    return m * 3.6;
  };
  return {
    muPeak,
    power_kW,
    sRef,
    massRef,
    rhoRef,
    reference,
    tau: curve,
    tStretchRef,
    physics: {
      c_f_s_per_kg: c_f,
      topSpeed_kph: vmax * 3.6,
      topSpeedAt_m: imax * geo.grid.ds,
      topSpeedSegment: geo.cfg.segments[geo.grid.seg[imax]].id,
      minSpeedS04_kph: segMin('S04'),
      minSpeedS08_kph: segMin('S08'),
      dT_dS,
    },
  };
}
