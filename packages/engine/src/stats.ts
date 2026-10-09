// Small, dependency-free statistics used by the planner (M12) and the benchmark (M13).
import { Rng } from './rng/rng';

export function mean(a: ArrayLike<number>, n = a.length): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i];
  return n > 0 ? s / n : NaN;
}

export function sd(a: ArrayLike<number>, n = a.length): number {
  if (n < 2) return 0;
  const m = mean(a, n);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] - m) ** 2;
  return Math.sqrt(s / (n - 1));
}

/** Standard normal quantile (Acklam's rational approximation, |error| < 1.2e-9). */
export function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Student-t quantile via the Cornish–Fisher expansion (accurate to ~1e-3 for ν ≥ 5). */
export function tQuantile(p: number, nu: number): number {
  const z = normalQuantile(p);
  if (!Number.isFinite(nu) || nu > 1e6) return z;
  const z3 = z ** 3;
  const z5 = z ** 5;
  const z7 = z ** 7;
  return z + (z3 + z) / (4 * nu) + (5 * z5 + 16 * z3 + 3 * z) / (96 * nu ** 2) + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * nu ** 3);
}

/** Paired mean difference with a two-sided t-interval at `level`. */
export function pairedCI(a: ArrayLike<number>, b: ArrayLike<number>, n: number, level: number): { mean: number; se: number; lo: number; hi: number } {
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) d[i] = a[i] - b[i];
  const m = mean(d, n);
  const se = sd(d, n) / Math.sqrt(n);
  const t = tQuantile(1 - (1 - level) / 2, Math.max(1, n - 1));
  return { mean: m, se, lo: m - t * se, hi: m + t * se };
}

/** Wilson score interval for a binomial proportion. */
export function wilson(k: number, n: number, level = 0.95): [number, number] {
  if (n === 0) return [0, 1];
  const z = normalQuantile(1 - (1 - level) / 2);
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Quantile by linear interpolation on a sorted copy. */
export function quantile(a: ArrayLike<number>, q: number, n = a.length): number {
  const s = Array.from({ length: n }, (_, i) => a[i]).sort((x, y) => x - y);
  if (n === 0) return NaN;
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}

/** CVaR_α of a loss (higher = worse): mean of the worst (1 − α) share. */
export function cvar(a: ArrayLike<number>, alpha: number, n = a.length): number {
  const s = Array.from({ length: n }, (_, i) => a[i]).sort((x, y) => y - x);
  const k = Math.max(1, Math.ceil((1 - alpha) * n));
  let t = 0;
  for (let i = 0; i < k; i++) t += s[i];
  return t / k;
}

/** Percentile bootstrap CI for the mean, deterministic given the seed. */
export function bootstrapMeanCI(a: ArrayLike<number>, seed: number, reps = 2000, level = 0.95): [number, number] {
  const n = a.length;
  if (n === 0) return [NaN, NaN];
  const rng = new Rng(seed >>> 0);
  const ms = new Float64Array(reps);
  for (let r = 0; r < reps; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += a[Math.min(n - 1, Math.floor(rng.uniform() * n))];
    ms[r] = s / n;
  }
  return [quantile(ms, (1 - level) / 2), quantile(ms, 1 - (1 - level) / 2)];
}

/** Holm step-down adjustment; returns adjusted p-values in the input order. */
export function holm(p: number[]): number[] {
  const idx = p.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
  const out = new Array<number>(p.length);
  let running = 0;
  idx.forEach(([v, i], r) => {
    running = Math.max(running, Math.min(1, (p.length - r) * v));
    out[i] = running;
  });
  return out;
}

/** Two-sided p-value of a paired t statistic (normal tail for large n, t-approx otherwise). */
export function pairedPValue(d: ArrayLike<number>): number {
  const n = d.length;
  if (n < 2) return 1;
  const s = sd(d);
  if (s === 0) return mean(d) === 0 ? 1 : 0;
  const t = Math.abs(mean(d) / (s / Math.sqrt(n)));
  // Hill's approximation of the t tail via a normal transform
  const nu = n - 1;
  const z = (t * (1 - 1 / (4 * nu))) / Math.sqrt(1 + (t * t) / (2 * nu));
  return Math.min(1, 2 * (1 - normalCdf(z)));
}

export function normalCdf(x: number): number {
  // Abramowitz–Stegun 7.1.26 on erf
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
