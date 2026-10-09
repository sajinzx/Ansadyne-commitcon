// M13 experiment 4 (honesty test) — bench-only oracle belief: the engine injects the truth after every
// update. The live API rejects `oracleBelief`; the reported OPT result is always the non-oracle one.
import type { Belief, Observation } from '@pitwall/shared';
import { Estimator } from './ekf';

export interface OracleTruth {
  fuel: number;
  lnX: number;
  lnY: number;
  bY: number;
  wear: number;
  lnZ: number;
  bZ: number;
}

export class OracleEstimator extends Estimator {
  private truth: OracleTruth | null = null;

  inject(t: OracleTruth): void {
    this.truth = t;
  }

  override update(obs: Observation): Belief {
    super.update(obs);
    return this.belief();
  }

  override belief(): Belief {
    const b = super.belief();
    const t = this.truth;
    if (!t) return b;
    const tiny = 1e-10;
    const diag = (n: number) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? tiny : 0)));
    return {
      ...b,
      fuel: { mean: t.fuel, sd: 0 },
      X: { mean: Math.exp(t.lnX), sd: 0 },
      Yeff: { mean: Math.exp(t.bY + t.lnY), sd: 0 },
      Zeff: { mean: Math.exp(t.bZ + t.lnZ), sd: 0 },
      W: { mean: t.wear, sd: 0 },
      gripMean: [t.lnX, t.lnY, t.bY, t.wear],
      gripCov: diag(4),
      fuelMean: [t.fuel, t.lnZ, t.bZ],
      fuelCov: diag(3),
    };
  }
}
