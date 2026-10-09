// M03 §3.2 — quasi-steady-state lap solver with a banked-frame friction circle.
// Conventions: θ tilts the road toward the corner centre; downforce acts perpendicular to the road
// surface and adds to normal load; lateral quantities are measured along the road surface; 1/r = 0 on straights.
import type { CarConfig } from '@pitwall/shared';
import type { NodeGrid } from '../track/geometry';

export const G = 9.81;
export const V_TOP = 120; // numeric ceiling (m/s)
export const V_MIN = 3; // numeric floor (m/s): the car never stops, even on near-zero grip

export function airDensity(airTemp_C: number): number {
  return 101325 / (287.05 * (airTemp_C + 273.15));
}

export interface QssCar {
  CdA: number;
  ClA: number;
  Crr: number;
  driveGripShare: number;
}

export function qssCar(car: CarConfig): QssCar {
  return { CdA: car.CdA_m2.value, ClA: car.ClA_m2.value, Crr: car.Crr.value, driveGripShare: car.driveGripShare.value };
}

export interface QssResult {
  lapTime: number;
  sectorTimes: [number, number, number];
  v: Float64Array; // speed at each node (m/s)
  dt: Float64Array; // time from node i to i+1
}

export class QssSolver {
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly vcap: Float64Array;
  private readonly mu: Float64Array;
  private readonly v2: Float64Array;
  private readonly vLap: Float64Array;
  private readonly dt: Float64Array;

  constructor(
    readonly grid: NodeGrid,
    readonly car: QssCar,
  ) {
    const n = grid.n;
    this.cos = new Float64Array(n);
    this.sin = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.cos[i] = Math.cos(grid.theta[i]);
      this.sin[i] = Math.sin(grid.theta[i]);
    }
    this.vcap = new Float64Array(n);
    this.mu = new Float64Array(n);
    this.v2 = new Float64Array(2 * n);
    this.vLap = new Float64Array(n);
    this.dt = new Float64Array(n);
  }

  /** Available longitudinal acceleration at speed v on node i (banked-frame friction circle). */
  aLong(v: number, i: number, mass: number, rho: number): number {
    const invR = this.grid.invR[i];
    const c = this.cos[i];
    const s = this.sin[i];
    const v2 = v * v;
    const nOverM = G * c + v2 * invR * s + (0.5 * rho * this.car.ClA * v2) / mass;
    // Lateral demand along the surface. Below the neutral speed of a banked corner this would be negative
    // (the car would need friction to stop sliding down the bank); we assume the driver takes a lower line
    // there, so only the outward demand counts. At v_cap the demand is positive, so Step 1 and Step 2 agree.
    const aLatRaw = v2 * invR * c - G * s;
    const aLat = aLatRaw > 0 ? aLatRaw : 0;
    const aTot = this.mu[i] * nOverM;
    const d = aTot * aTot - aLat * aLat;
    return d > 0 ? Math.sqrt(d) : 0;
  }

  /** Cornering speed cap for node i (exposed for tests). */
  vCap(i: number): number {
    return this.vcap[i];
  }

  /**
   * Solve one closed lap. Friction at node i is `scale · nodeFactor[i]`.
   * @param power  W (already including the mode power factor)
   */
  solve(nodeFactor: Float64Array, scale: number, mass: number, power: number, rho: number, keepProfile = false): QssResult {
    const { grid, car } = this;
    const n = grid.n;
    const ds = grid.ds;
    const halfRhoClA = 0.5 * rho * car.ClA;
    const halfRhoCdA = 0.5 * rho * car.CdA;
    const mg = mass * G;
    for (let i = 0; i < n; i++) {
      const mu = scale * nodeFactor[i];
      this.mu[i] = mu;
      const invR = grid.invR[i];
      if (invR === 0) {
        this.vcap[i] = V_TOP;
        continue;
      }
      const c = this.cos[i];
      const s = this.sin[i];
      const den = mass * (c - mu * s) * invR - mu * halfRhoClA;
      if (den <= 0) {
        this.vcap[i] = V_TOP;
      } else {
        const vc = Math.sqrt((mg * (s + mu * c)) / den);
        this.vcap[i] = vc < V_TOP ? vc : V_TOP;
      }
    }
    const v = this.v2;
    const N2 = 2 * n;
    v[0] = this.vcap[0];
    // forward pass (acceleration) over two laps
    for (let k = 0; k < N2 - 1; k++) {
      const i = k % n;
      const vv = v[k];
      const drag = halfRhoCdA * vv * vv;
      const roll = car.Crr * (mg + halfRhoClA * vv * vv);
      const aPow = power / (mass * (vv > 5 ? vv : 5));
      const aGrip = car.driveGripShare * this.aLong(vv, i, mass, rho);
      const a = (aPow < aGrip ? aPow : aGrip) - (drag + roll) / mass;
      const next = vv * vv + 2 * a * ds;
      const vn = next > 0 ? Math.sqrt(next) : 0;
      const cap = this.vcap[(k + 1) % n];
      const vc = vn < cap ? vn : cap;
      v[k + 1] = vc > V_MIN ? vc : V_MIN;
    }
    // backward pass (braking)
    for (let k = N2 - 2; k >= 0; k--) {
      const i1 = (k + 1) % n;
      const vn = v[k + 1];
      const drag = halfRhoCdA * vn * vn;
      const roll = car.Crr * (mg + halfRhoClA * vn * vn);
      const ab = this.aLong(vn, i1, mass, rho) + (drag + roll) / mass;
      const lim = Math.sqrt(vn * vn + 2 * ab * ds);
      if (lim < v[k]) v[k] = lim > V_MIN ? lim : V_MIN;
    }
    const vLap = this.vLap;
    for (let i = 0; i < n; i++) vLap[i] = v[n + i];
    let T = 0;
    const sec: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const vNext = vLap[(i + 1) % n];
      const d = (2 * ds) / (vLap[i] + vNext);
      this.dt[i] = d;
      T += d;
      sec[grid.sector[i]] += d;
    }
    return {
      lapTime: T,
      sectorTimes: sec,
      v: keepProfile ? Float64Array.from(vLap) : vLap,
      dt: keepProfile ? Float64Array.from(this.dt) : this.dt,
    };
  }
}
