// M01 §1.5 — positive multipliers X (grip), Y (wear rate), Z (burn) as exp-OU (default) or GBM (experiment).

export interface ProcessParams {
  kappa: number;
  sigma: number;
}

export interface MultiplierParams {
  X: ProcessParams;
  Y: ProcessParams;
  Z: ProcessParams;
  rhoXY: number;
  model: 'expOU' | 'gbm';
}

export const DEFAULT_MULTIPLIERS: MultiplierParams = {
  X: { kappa: 0.08, sigma: 0.012 },
  Y: { kappa: 0.05, sigma: 0.03 },
  Z: { kappa: 0.1, sigma: 0.015 },
  rhoXY: -0.4,
  model: 'expOU',
};

export function stationarySd(p: ProcessParams): number {
  return p.sigma / Math.sqrt(2 * p.kappa);
}

/** Clip bound on ln(multiplier): ±5 stationary sd. */
export function clipBound(p: ProcessParams): number {
  return 5 * stationarySd(p);
}

/** Exact one-lap exp-OU step for x = ln(multiplier), θ = 0. */
export function ouStep(x: number, p: ProcessParams, z: number): number {
  const a = Math.exp(-p.kappa);
  const s = p.sigma * Math.sqrt((1 - Math.exp(-2 * p.kappa)) / (2 * p.kappa));
  return x * a + s * z;
}

/** GBM step with flat median (μ = σ²/2 ⇒ drift of ln is 0). */
export function gbmStep(x: number, p: ProcessParams, z: number): number {
  return x + p.sigma * z;
}

/** Correlated shocks from independent normals (order X, Y, Z). */
export function correlate(n1: number, n2: number, n3: number, rho: number): [number, number, number] {
  return [n1, rho * n1 + Math.sqrt(1 - rho * rho) * n2, n3];
}

export class ClipCounter {
  count = 0;
  laps = 0;
}

/** Advance the three log-multipliers one lap. Returns the new values (clipped). */
export function stepMultipliers(
  lnX: number,
  lnY: number,
  lnZ: number,
  n1: number,
  n2: number,
  n3: number,
  params: MultiplierParams,
  clips?: ClipCounter,
): [number, number, number] {
  const [zX, zY, zZ] = correlate(n1, n2, n3, params.rhoXY);
  const step = params.model === 'gbm' ? gbmStep : ouStep;
  let x = step(lnX, params.X, zX);
  let y = step(lnY, params.Y, zY);
  let z = step(lnZ, params.Z, zZ);
  const bx = clipBound(params.X);
  const by = clipBound(params.Y);
  const bz = clipBound(params.Z);
  let clipped = false;
  if (x > bx || x < -bx) {
    x = Math.max(-bx, Math.min(bx, x));
    clipped = true;
  }
  if (y > by || y < -by) {
    y = Math.max(-by, Math.min(by, y));
    clipped = true;
  }
  if (z > bz || z < -bz) {
    z = Math.max(-bz, Math.min(bz, z));
    clipped = true;
  }
  if (clips) {
    clips.laps++;
    if (clipped) clips.count++;
  }
  return [x, y, z];
}
