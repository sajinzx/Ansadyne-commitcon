// M11 — belief state for our car from observations only (runs in every world).
// Fuel filter  x_f = [F, ζ, b_Z]        (ζ = mean-reverting log burn, b_Z = persistent burn offset)
// Grip filter  x_g = [ξ, η, b_Y, W]     (ξ = ln X grip, η = mean-reverting log wear rate, b_Y = persistent offset, W = wear)
import type { Belief, Observation } from '@pitwall/shared';
import type { ModelBundle } from '../vehicle/model';
import { surrogateLap } from '../vehicle/model';
import { stationarySd } from '../stochastic/ou';
import { sCar, massRef } from '../vehicle/tyre';
import { sTrack } from '../track/surface';

type Mat = number[][];

const zeros = (n: number, m = n): Mat => Array.from({ length: n }, () => new Array(m).fill(0));
const ident = (n: number): Mat => zeros(n).map((r, i) => r.map((_, j) => (i === j ? 1 : 0)));
const mul = (a: Mat, b: Mat): Mat => a.map((r) => b[0].map((_, j) => r.reduce((s, v, k) => s + v * b[k][j], 0)));
const tr = (a: Mat): Mat => a[0].map((_, j) => a.map((r) => r[j]));
const add = (a: Mat, b: Mat): Mat => a.map((r, i) => r.map((v, j) => v + b[i][j]));

export interface EstimatorState {
  fm: number[];
  fP: Mat;
  gm: number[];
  gP: Mat;
  gated: boolean;
  lastZ: number;
  updated: boolean;
  lap: number;
  lastObs: Observation | null;
  gatedLaps: number;
  treadUpdates?: number;
}

export const TRAFFIC_MEAN = 0.21;
export const TRAFFIC_VAR = 0.208;

export class Estimator {
  private s: EstimatorState;

  constructor(private readonly model: ModelBundle) {
    const mp = model.multipliers;
    const sX = stationarySd(mp.X);
    const sY = stationarySd(mp.Y);
    const sZ = stationarySd(mp.Z);
    const spread = model.coeffSpread; // priors are not told about F9's wider truth; keep 1 here
    void spread;
    this.s = {
      fm: [model.cfg.race.startingFuel_kg, 0, 0],
      fP: [
        [0.2 ** 2, 0, 0],
        [0, sZ ** 2, 0],
        [0, 0, 0.03 ** 2],
      ],
      gm: [0, 0, 0, 0],
      gP: [
        [sX ** 2, 0, 0, 0],
        [0, sY ** 2, 0, 0],
        [0, 0, 0.1 ** 2, 0],
        [0, 0, 0, 1e-8],
      ],
      gated: false,
      lastZ: 0,
      updated: false,
      lap: 0,
      lastObs: null,
      gatedLaps: 0,
    };
  }

  getState(): EstimatorState {
    return structuredClone(this.s);
  }
  setState(s: unknown): void {
    this.s = structuredClone(s as EstimatorState);
  }

  /** Lap-time measurement model h(x) for a lap that started in observation `prev` conditions. */
  private h(x: number[], prev: Observation, obs: Observation, mMid: number): number {
    const m = this.model;
    const car = m.cfg.car;
    const field = m.cfg.field.cars.find((c) => c.no === obs.ego.no)!;
    const w = prev.wetness_est;
    const S =
      sCar(car, {
        compound: prev.ego.compound,
        w,
        tyreTemp: prev.ego.tyreTemp_C,
        wear: Math.max(0, x[3]),
        X: Math.exp(x[0]),
        gripSkill: field.gripSkill,
        wetSkill: field.wetSkill,
      }) * sTrack(prev.trackTemp_C, prev.rubber_est, w, m.cfg.track.meanDryGrip);
    const lap = surrogateLap(m, Math.max(0.35, Math.min(1.25, S)), mMid, w, prev.ego.mode, prev.airTemp_C) * field.paceFactor;
    const da = m.cfg.race.dirtyAir;
    const dirty = prev.ego.gapAhead_s < da.gapThreshold_s ? da.maxLoss_s * (1 - prev.ego.gapAhead_s / da.gapThreshold_s) : 0;
    return lap + TRAFFIC_MEAN + dirty;
  }

  update(obs: Observation): Belief {
    const s = this.s;
    const m = this.model;
    const car = m.cfg.car;
    const mp = m.multipliers;
    const L = m.lapLength;
    const flags = obs.ego.lastLapFlags;
    // the first reading follows the opening lap: predict it from the start state (prior), no lap-time update
    const firstLap = !s.lastObs;
    const prev: Observation = s.lastObs ?? {
      ...obs,
      lap: obs.lap - 1,
      ego: { ...obs.ego, fuelGauge_kg: m.cfg.race.startingFuel_kg, tyreAgeLaps: 0, mode: 'normal' },
    };
    if (obs.lap === prev.lap) return this.belief(); // no new lap (car stopped)
    const portion = flags.inLap ? m.lane.entryS / L : flags.outLap ? 1 - m.lane.exitS / L : 1;
    const fc = flags.caution ? 1 : 0;
    const mode = prev.ego.mode;
    const mStart = car.mass_dry_kg.value + s.fm[0];

    // ---------------- fuel filter: predict over the lap, then update with the gauge
    {
      const [F, zeta, bZ] = s.fm;
      const qNom = car.fuel.qBase_kg_per_lap * car.modes[mode].burnFactor * Math.pow(mStart / massRef(car), car.fuel.massExponent) * (1 - fc + fc * car.fuel.cautionBurnFactor);
      const q = qNom * Math.exp(bZ + zeta) * portion;
      const aZ = Math.exp(-mp.Z.kappa);
      const refuel = flags.outLap ? (obs.ego.lastRefuelApplied_kg ?? 0) : 0;
      s.fm = [F - q + refuel, aZ * zeta, bZ];
      const Fj: Mat = [
        [1, -q, -q],
        [0, aZ, 0],
        [0, 0, 1],
      ];
      const qz = mp.Z.sigma ** 2 * ((1 - Math.exp(-2 * mp.Z.kappa)) / (2 * mp.Z.kappa));
      const Q: Mat = [
        [0.01, 0, 0],
        [0, qz, 0],
        [0, 0, 1e-8],
      ];
      s.fP = add(mul(mul(Fj, s.fP), tr(Fj)), Q);
      this.fuelUpdate(obs.ego.fuelGauge_kg);
    }

    // ---------------- grip/wear filter: update with the lap time, then predict to the next lap
    const mMid = car.mass_dry_kg.value + Math.max(0, s.fm[0]) + (prev.ego.fuelGauge_kg - obs.ego.fuelGauge_kg) / 2;
    const usable = !firstLap && !flags.inLap && !flags.outLap && !flags.caution && !flags.incident && obs.ego.lastLap_s > 0;
    s.updated = false;
    s.gated = false;
    if (usable) {
      const x = s.gm;
      const hx = this.h(x, prev, obs, mMid);
      const H: number[] = [0, 0, 0, 0];
      const eps = [1e-4, 1e-4, 1e-4, 1e-4];
      for (let i = 0; i < 4; i++) {
        if (i === 1 || i === 2) continue; // lap time does not depend on the wear-rate states directly
        const xp = [...x];
        const xm = [...x];
        xp[i] += eps[i];
        xm[i] -= eps[i];
        H[i] = (this.h(xp, prev, obs, mMid) - this.h(xm, prev, obs, mMid)) / (2 * eps[i]);
      }
      const R = m.cfg.race.residualSigma_s.value ** 2 + TRAFFIC_VAR;
      const PHt = s.gP.map((row) => row.reduce((acc, v, j) => acc + v * H[j], 0));
      const Sv = H.reduce((acc, v, i) => acc + v * PHt[i], 0) + R;
      const innov = obs.ego.lastLap_s - hx;
      const z = innov / Math.sqrt(Sv);
      s.lastZ = z;
      if (Math.abs(z) > 3) {
        s.gated = true;
        s.gatedLaps++;
      } else {
        const K = PHt.map((v) => v / Sv);
        s.gm = x.map((v, i) => v + K[i] * innov);
        s.gP = s.gP.map((row, i) => row.map((v, j) => v - K[i] * PHt[j]));
        s.updated = true;
      }
    }
    // tread-depth measurement of the set just removed: a direct observation of W (old set) before the reset.
    // Through the covariance it also corrects the wear-rate states η and b_Y, which lap times barely reveal.
    const tread = obs.ego.treadMeasured;
    if (tread) {
      const Rt = (car.tyres.treadGaugeSigma ?? 0.01) ** 2;
      const P0 = s.gP;
      const Sv = P0[3][3] + Rt;
      const K = P0.map((row) => row[3] / Sv);
      const innov = tread.wear - s.gm[3];
      s.gm = s.gm.map((v, i) => v + K[i] * innov);
      s.gP = P0.map((row, i) => row.map((v, j) => v - K[i] * P0[3][j]));
      s.treadUpdates = (s.treadUpdates ?? 0) + 1;
    }
    // predict to the start of the next lap
    {
      const [xi, eta, bY, W] = s.gm;
      const aX = Math.exp(-mp.X.kappa);
      const aY = Math.exp(-mp.Y.kappa);
      const comp = car.tyres[obs.ego.compound];
      const th = car.tyres.thermal;
      const T = prev.ego.tyreTemp_C;
      const wetPenalty = obs.ego.compound === 'wet' ? 1 + (comp.dryWearPenalty ?? 0) * (1 - obs.wetness_est) ** 2 : 1;
      const gW =
        (mMid / massRef(car)) * (1 + th.wearTempCoeff * Math.max(0, T - comp.Topt_C)) * car.modes[mode].wearFactor * (1 - fc + 0.25 * fc) * wetPenalty;
      const newTyres = flags.outLap && obs.ego.tyreAgeLaps === 1;
      const wearMult = m.cfg.field.cars.find((c) => c.no === obs.ego.no)!.wearMult;
      // E[exp(bY + η)] under the posterior (second-order term avoids a low-wear bias)
      const lnVar = s.gP[1][1] + s.gP[2][2] + 2 * s.gP[1][2];
      const kt = comp.kBase_per_lap * Math.exp(bY + eta + lnVar / 2) * wearMult * gW * portion;
      const Wn = newTyres ? kt : W + kt;
      s.gm = [aX * xi, aY * eta, bY, Math.min(1, Wn)];
      const Fj: Mat = [
        [aX, 0, 0, 0],
        [0, aY, 0, 0],
        [0, 0, 1, 0],
        [0, kt, kt, newTyres ? 0 : 1],
      ];
      const qx = mp.X.sigma ** 2 * ((1 - Math.exp(-2 * mp.X.kappa)) / (2 * mp.X.kappa));
      const qy = mp.Y.sigma ** 2 * ((1 - Math.exp(-2 * mp.Y.kappa)) / (2 * mp.Y.kappa));
      const Q: Mat = [
        [qx, 0, 0, 0],
        [0, qy, 0, 0],
        [0, 0, 1e-6, 0],
        [0, 0, 0, (0.15 * kt) ** 2 + 1e-8], // model error of the wear-rate structure (temperature, wetness)
      ];
      // on a new set the Jacobian's wear row drops the old W, so the wear uncertainty restarts from this lap's increment
      s.gP = add(mul(mul(Fj, s.gP), tr(Fj)), Q);
    }
    s.lastObs = obs;
    s.lap = obs.lap;
    return this.belief();
  }

  private fuelUpdate(y: number): void {
    const s = this.s;
    const R = this.model.cfg.car.fuel.gaugeNoise_kg ** 2;
    const P = s.fP;
    const Sv = P[0][0] + R;
    const K = [P[0][0] / Sv, P[1][0] / Sv, P[2][0] / Sv];
    const innov = y - s.fm[0];
    s.fm = s.fm.map((v, i) => v + K[i] * innov);
    s.fP = P.map((row, i) => row.map((v, j) => v - K[i] * P[0][j]));
  }

  belief(): Belief {
    const s = this.s;
    const lnStat = (mu: number, varr: number) => {
      const mean = Math.exp(mu + varr / 2);
      return { mean, sd: mean * Math.sqrt(Math.max(0, Math.exp(varr) - 1)) };
    };
    const gP = s.gP;
    const fP = s.fP;
    return {
      lap: s.lap,
      fuel: { mean: s.fm[0], sd: Math.sqrt(Math.max(0, fP[0][0])) },
      X: lnStat(s.gm[0], gP[0][0]),
      Yeff: lnStat(s.gm[1] + s.gm[2], gP[1][1] + gP[2][2] + 2 * gP[1][2]),
      Zeff: lnStat(s.fm[1] + s.fm[2], fP[1][1] + fP[2][2] + 2 * fP[1][2]),
      W: { mean: Math.max(0, s.gm[3]), sd: Math.sqrt(Math.max(0, gP[3][3])) },
      gripMean: [...s.gm],
      gripCov: gP.map((r) => [...r]),
      fuelMean: [...s.fm],
      fuelCov: fP.map((r) => [...r]),
      gated: s.gated,
      lastInnovationZ: s.lastZ,
      updated: s.updated,
    };
  }
}

/** Cholesky factor (lower) of a small symmetric PSD matrix, with jitter for safety. */
export function cholesky(A: number[][]): number[][] {
  const n = A.length;
  const Lm = zeros(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= Lm[i][k] * Lm[j][k];
      if (i === j) Lm[i][j] = Math.sqrt(Math.max(sum, 1e-12));
      else Lm[i][j] = sum / Lm[j][j];
    }
  }
  return Lm;
}

export { ident };
