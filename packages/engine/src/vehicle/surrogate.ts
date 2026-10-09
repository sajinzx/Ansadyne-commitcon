// M03 §3.4 — lap-time surrogate table shared by the engine and the planner (one physics model for both).
//
// Interpolation design: wetness changes every segment's grip by nearly the same factor, so lap time
// depends mainly on the *effective* uniform scale S_eff = S · e(w), where e(w) is the length-weighted
// mean node factor at wetness w relative to dry. The table is stored on (S_eff, m, w) and queried at
// the exact S_eff; interpolation across w at fixed S_eff then only carries the small residual
// (segments wetting unevenly), which keeps wet-lap errors small on a coarse w axis.
import type { CarConfig, Mode, SegmentOverride, TrackConfig } from '@pitwall/shared';
import type { TrackGeometry } from '../track/geometry';
import { nodeFactors, overrideFor, segmentNode } from '../track/surface';
import { QssSolver, airDensity, qssCar } from './qss';

/** Domain of the public uniform scale S = S_car · S_track. */
export const S_AXIS = { min: 0.35, max: 1.25 };
/** Internal effective-scale axis (S · e(w)). */
export const SEFF_AXIS = { min: 0.12, max: 1.25, step: 0.025 };
export const W_AXIS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
export const MODES: Mode[] = ['save', 'normal', 'push'];
export const REF_AIR_TEMP = 22;

export class SurrogateRangeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'SurrogateRangeError';
  }
}

export interface SurrogateTable {
  nS: number;
  nM: number;
  nW: number;
  sAxis: Float64Array; // effective scale axis
  mAxis: Float64Array;
  wAxis: Float64Array;
  /** lap time [mode][w][m][s] flattened */
  lap: Float64Array;
  /** sector fractions [mode][w][m][s][3] flattened */
  sec: Float64Array;
  rhoRef: number;
  muPeak: number;
  power: number;
  /** per-segment data for the exact e(w) */
  segs: { len: number; dry: number; wet: number; ov?: SegmentOverride }[];
  dryMean: number;
}

function modeIndex(mode: Mode): number {
  return mode === 'save' ? 0 : mode === 'normal' ? 1 : 2;
}

export class Surrogate {
  /** strict mode throws on out-of-range queries (tests); production clamps and counts */
  strict = false;
  outOfRange = 0;
  readonly t: SurrogateTable;

  constructor(table: SurrogateTable) {
    this.t = table;
  }

  static build(
    geo: TrackGeometry,
    car: CarConfig,
    muPeak: number,
    power_kW: number,
    overrides: SegmentOverride[] = [],
    track: TrackConfig = geo.cfg,
    wAxisValues: number[] = W_AXIS,
  ): Surrogate {
    const solver = new QssSolver(geo.grid, qssCar(car));
    const nS = Math.round((SEFF_AXIS.max - SEFF_AXIS.min) / SEFF_AXIS.step) + 1;
    const sAxis = Float64Array.from({ length: nS }, (_, i) => SEFF_AXIS.min + i * SEFF_AXIS.step);
    const mDry = car.mass_dry_kg.value;
    const cap = car.fuel.capacity_kg;
    const mAxis = Float64Array.from({ length: 7 }, (_, i) => mDry + (cap * i) / 6);
    const wAxis = Float64Array.from(wAxisValues);
    const nM = mAxis.length;
    const nW = wAxis.length;
    const lap = new Float64Array(3 * nW * nM * nS);
    const sec = new Float64Array(3 * nW * nM * nS * 3);
    const rhoRef = airDensity(REF_AIR_TEMP);
    const segs = track.segments.map((s) => ({
      len: s.end_m - s.start_m,
      dry: s.dryGrip.value,
      wet: s.wetGrip.value,
      ov: overrideFor(overrides, s.id),
    }));
    const total = segs.reduce((a, s) => a + s.len, 0);
    const dryMean = segs.reduce((a, s) => a + s.len * s.dry, 0) / total;
    const proto = new Surrogate({ nS, nM, nW, sAxis, mAxis, wAxis, lap, sec, rhoRef, muPeak, power: power_kW, segs, dryMean });
    for (let mi = 0; mi < 3; mi++) {
      const power = power_kW * 1000 * car.modes[MODES[mi]].powerFactor;
      for (let wi = 0; wi < nW; wi++) {
        const nodes = nodeFactors(track, geo.grid, wAxis[wi], overrides);
        const e = proto.wetFactor(wAxis[wi]);
        for (let ki = 0; ki < nM; ki++) {
          for (let si = 0; si < nS; si++) {
            const r = solver.solve(nodes, (muPeak * sAxis[si]) / e, mAxis[ki], power, rhoRef);
            const idx = ((mi * nW + wi) * nM + ki) * nS + si;
            lap[idx] = r.lapTime;
            sec[idx * 3] = r.sectorTimes[0] / r.lapTime;
            sec[idx * 3 + 1] = r.sectorTimes[1] / r.lapTime;
            sec[idx * 3 + 2] = r.sectorTimes[2] / r.lapTime;
          }
        }
      }
    }
    return proto;
  }

  /** e(w): length-weighted mean node factor at wetness w relative to the dry mean (no overrides in the dry mean). */
  wetFactor(w: number): number {
    const t = this.t;
    let acc = 0;
    let total = 0;
    for (const s of t.segs) {
      acc += s.len * segmentNode(s.dry, s.wet, w, s.ov).node;
      total += s.len;
    }
    return acc / total / t.dryMean;
  }

  private checkS(S: number): number {
    if (S < S_AXIS.min - 1e-9 || S > S_AXIS.max + 1e-9) {
      if (this.strict) throw new SurrogateRangeError(`S=${S} outside [${S_AXIS.min}, ${S_AXIS.max}]`);
      this.outOfRange++;
      return S < S_AXIS.min ? S_AXIS.min : S_AXIS.max;
    }
    return S;
  }

  private locate(axis: Float64Array, xIn: number, name: string): [number, number] {
    const n = axis.length;
    let x = xIn;
    if (x < axis[0] - 1e-9 || x > axis[n - 1] + 1e-9) {
      if (this.strict) throw new SurrogateRangeError(`${name}=${x} outside [${axis[0]}, ${axis[n - 1]}]`);
      this.outOfRange++;
      x = x < axis[0] ? axis[0] : axis[n - 1];
    }
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (axis[mid] <= x) lo = mid;
      else hi = mid;
    }
    const f = (x - axis[lo]) / (axis[hi] - axis[lo]);
    return [lo, f < 0 ? 0 : f > 1 ? 1 : f];
  }

  private corners(S: number, m: number, w: number) {
    const Sc = this.checkS(S);
    const wc = w < 0 ? 0 : w > 1 ? 1 : w;
    const seff = Sc * this.wetFactor(wc);
    const [si, sf] = this.locate(this.t.sAxis, seff, 'S_eff');
    const [ki, kf] = this.locate(this.t.mAxis, m, 'm');
    const [wi, wf] = this.locate(this.t.wAxis, wc, 'w');
    return { si, sf, ki, kf, wi, wf };
  }

  /** Lap time at reference air density for uniform scale S, mass m, wetness w and mode. */
  lapTime(S: number, m: number, w: number, mode: Mode): number {
    const t = this.t;
    const mi = modeIndex(mode);
    const { si, sf, ki, kf, wi, wf } = this.corners(S, m, w);
    const { nS, nM, nW } = t;
    const L = t.lap;
    const s1 = si + 1 < nS ? si + 1 : si;
    const k1 = ki + 1 < nM ? ki + 1 : ki;
    const w1 = wi + 1 < nW ? wi + 1 : wi;
    const base = mi * nW;
    const at = (wj: number, kj: number, sj: number) => L[((base + wj) * nM + kj) * nS + sj];
    const c00 = at(wi, ki, si) * (1 - sf) + at(wi, ki, s1) * sf;
    const c01 = at(wi, k1, si) * (1 - sf) + at(wi, k1, s1) * sf;
    const c10 = at(w1, ki, si) * (1 - sf) + at(w1, ki, s1) * sf;
    const c11 = at(w1, k1, si) * (1 - sf) + at(w1, k1, s1) * sf;
    const c0 = c00 * (1 - kf) + c01 * kf;
    const c1 = c10 * (1 - kf) + c11 * kf;
    return c0 * (1 - wf) + c1 * wf;
  }

  /** Sector fractions (nearest grid cell; used for display). */
  sectorFrac(S: number, m: number, w: number, mode: Mode): [number, number, number] {
    const t = this.t;
    const strict = this.strict;
    this.strict = false;
    const { si, sf, ki, kf, wi, wf } = this.corners(S, m, w);
    this.strict = strict;
    const idx =
      ((modeIndex(mode) * t.nW + Math.min(wi + Math.round(wf), t.nW - 1)) * t.nM + Math.min(ki + Math.round(kf), t.nM - 1)) * t.nS +
      Math.min(si + Math.round(sf), t.nS - 1);
    return [t.sec[idx * 3], t.sec[idx * 3 + 1], t.sec[idx * 3 + 2]];
  }
}
