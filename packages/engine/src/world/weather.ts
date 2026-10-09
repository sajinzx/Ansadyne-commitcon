// M05 — clock-indexed environment: regime chain, wetness, temperatures, rubber, night, rain probability.
// Identical in all three worlds (it depends only on race time, pre-draws and injections).
import type { Regime } from '@pitwall/shared';
import { categoricalFromU } from '../rng/rng';
import type { Predraw } from '../rng/predraw';

export const REGIMES: Regime[] = ['dry', 'damp', 'wet'];
export const RAIN_INTENSITY = [0, 0.25, 1.0];

export interface EnvState {
  tick: number;
  regime: Regime;
  regimeIdx: number;
  w: number;
  trackTemp: number;
  airTemp: number;
  rubber: number;
  eta: number;
  hour: number;
  night: boolean;
}

export interface RainProb {
  in10: number;
  in20: number;
  in40: number;
}

function matMul(a: number[][], b: number[][]): number[][] {
  return a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
}

/** P(regime = wet at some tick ≤ N | current regime), wet made absorbing. */
export function rainProbTable(P: number[][]): RainProb[] {
  const A = P.map((r) => r.slice());
  A[2] = [0, 0, 1];
  const pow = (n: number) => {
    let R = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    for (let i = 0; i < n; i++) R = matMul(R, A);
    return R;
  };
  const A10 = pow(10);
  const A20 = pow(20);
  const A40 = pow(40);
  return [0, 1, 2].map((s) => ({ in10: A10[s][2], in20: A20[s][2], in40: A40[s][2] }));
}

/** Regime distribution after N ticks (not absorbing) — for the UI weather card. */
export function regimeDistribution(P: number[][], current: number, n: number): number[] {
  let v = [0, 0, 0];
  v[current] = 1;
  for (let i = 0; i < n; i++) v = [0, 1, 2].map((j) => v.reduce((s, p, k) => s + p * P[k][j], 0));
  return v;
}

export function parseClock(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h + m / 60;
}

export function clockString(startHour: number, t_s: number): string {
  const h = (startHour + t_s / 3600) % 24;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export interface WeatherForcing {
  /** forced regime per tick (injections and benchmark families) */
  forced: Map<number, number>;
  /** keep the chain dry everywhere (family F1) */
  fixedDry: boolean;
  /** extra track-temperature offset (family F7) */
  trackTempOffset: number;
}

export class EnvTimeline {
  readonly dt: number;
  readonly startHour: number;
  readonly ticks: EnvState[] = [];
  readonly rainTable: RainProb[];
  readonly forcing: WeatherForcing;

  constructor(
    readonly pd: Predraw,
    readonly P: number[][],
    lapRef: number,
    startClock: string,
    forcing: Partial<WeatherForcing> = {},
  ) {
    this.dt = lapRef;
    this.startHour = parseClock(startClock);
    this.rainTable = rainProbTable(P);
    this.forcing = { forced: forcing.forced ?? new Map(), fixedDry: forcing.fixedDry ?? false, trackTempOffset: forcing.trackTempOffset ?? 0 };
    this.recomputeFrom(0);
  }

  private initial(): EnvState {
    return this.derive(0, 0, 0, 0, 0);
  }

  private derive(tick: number, regimeIdx: number, w: number, rubber: number, eta: number): EnvState {
    const t = tick * this.dt;
    const hour = (this.startHour + t / 3600) % 24;
    const airTemp = 18 + 6 * Math.cos((2 * Math.PI * (hour - 15)) / 24);
    const sun = Math.max(0, Math.sin((Math.PI * (hour - 7)) / 12));
    const trackTemp = airTemp + 12 * sun * (1 - 0.7 * (regimeIdx !== 0 ? 1 : 0)) - 5 * w + eta + this.forcing.trackTempOffset;
    return { tick, regime: REGIMES[regimeIdx], regimeIdx, w, trackTemp, airTemp, rubber, eta, hour, night: sun === 0 };
  }

  /** Recompute ticks from `j0` onward (after an injection). */
  recomputeFrom(j0: number): void {
    const J = this.pd.sizes.J;
    if (j0 === 0) this.ticks[0] = this.forcedStart(this.initial());
    for (let j = Math.max(1, j0); j < J; j++) {
      const prev = this.ticks[j - 1];
      let regimeIdx: number;
      const f = this.forcing.forced.get(j);
      if (f !== undefined) regimeIdx = f;
      else if (this.forcing.fixedDry) regimeIdx = 0;
      else regimeIdx = categoricalFromU(this.P[prev.regimeIdx], this.pd.weatherU.get(j));
      const rain = RAIN_INTENSITY[prev.regimeIdx];
      const drying = prev.w * 0.06 * (prev.trackTemp / 30) * (rain === 0 ? 1 : 0.3);
      const w = Math.max(0, Math.min(1, prev.w + 0.12 * rain - drying));
      const rubber = prev.w < 0.1 ? Math.min(0.06, prev.rubber + 0.0004) : prev.rubber * (1 - 0.5 * prev.w);
      const eta = 0.9 * prev.eta + 0.5 * this.pd.trackTempN.get(j);
      this.ticks[j] = this.derive(j, regimeIdx, w, rubber, eta);
    }
  }

  private forcedStart(s: EnvState): EnvState {
    const f = this.forcing.forced.get(0);
    return f === undefined ? s : this.derive(0, f, s.w, s.rubber, s.eta);
  }

  tickAt(t: number): number {
    return Math.max(0, Math.min(this.ticks.length - 1, Math.floor(t / this.dt)));
  }

  at(t: number): EnvState {
    return this.ticks[this.tickAt(t)];
  }

  rainProb(regimeIdx: number): RainProb {
    return this.rainTable[regimeIdx];
  }

  /** Force `regime` for `n` ticks starting at `j0`, then let the chain resume. */
  force(j0: number, regimeIdx: number, n: number): void {
    for (let j = j0; j < Math.min(j0 + n, this.pd.sizes.J); j++) this.forcing.forced.set(j, regimeIdx);
    this.recomputeFrom(Math.max(0, j0));
  }

  clock(t: number): string {
    return clockString(this.startHour, t);
  }

  snapshot(): { forced: [number, number][] } {
    return { forced: [...this.forcing.forced.entries()] };
  }
}
