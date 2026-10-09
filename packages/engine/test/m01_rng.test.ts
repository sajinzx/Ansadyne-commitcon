import { describe, expect, it } from 'vitest';
import { Rng, stream, hash32 } from '../src/rng/rng';
import { predraw, predrawSizes, hashPredraw, PredrawOverflowError } from '../src/rng/predraw';
import { DEFAULT_MULTIPLIERS, ouStep, gbmStep, stationarySd, stepMultipliers, ClipCounter, correlate } from '../src/stochastic/ou';

function corr(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
}

describe('M01 RNG and streams', () => {
  it('same seed gives the same 10,000 numbers', () => {
    const a = new Rng(42), b = new Rng(42);
    for (let i = 0; i < 10_000; i++) expect(a.nextU32()).toBe(b.nextU32());
  });

  it('streams with different ids or indices are uncorrelated', () => {
    const draw = (r: Rng) => Array.from({ length: 10_000 }, () => r.uniform());
    expect(Math.abs(corr(draw(stream(914, 2, 0)), draw(stream(914, 3, 0))))).toBeLessThan(0.02);
    expect(Math.abs(corr(draw(stream(914, 2, 0)), draw(stream(914, 2, 1))))).toBeLessThan(0.02);
    expect(hash32(914, 2, 0)).not.toBe(hash32(914, 2, 1));
  });

  it('uniform is in [0,1) and normal has mean 0, sd 1', () => {
    const r = new Rng(7);
    let s = 0, s2 = 0;
    for (let i = 0; i < 50_000; i++) {
      const u = r.uniform();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      const z = r.normal();
      s += z;
      s2 += z * z;
    }
    expect(Math.abs(s / 50_000)).toBeLessThan(0.02);
    expect(Math.abs(Math.sqrt(s2 / 50_000) - 1)).toBeLessThan(0.02);
  });
});

describe('M01 pre-draw manifest', () => {
  it('is byte-identical for the same seed and differs across seeds', () => {
    const sizes = predrawSizes(10800, 107, 10);
    expect(hashPredraw(predraw(914, sizes))).toBe(hashPredraw(predraw(914, sizes)));
    expect(hashPredraw(predraw(914, sizes))).not.toBe(hashPredraw(predraw(915, sizes)));
  });

  it('sizes follow the spec for 1, 3 and 6 hour races and reading past the end throws', () => {
    for (const h of [1, 3, 6]) {
      const s = predrawSizes(h * 3600, 107, 10);
      expect(s.K).toBe(Math.ceil((h * 3600) / (0.9 * 107)) + 20);
      expect(s.J).toBe(Math.ceil((h * 3600) / 107) + 40);
      expect(s.S).toBe(Math.ceil(s.K / 5) + 5);
    }
    const pd = predraw(1, predrawSizes(3600, 107, 10));
    expect(() => pd.n1.get(0, pd.sizes.K)).toThrow(PredrawOverflowError);
    expect(() => pd.weatherU.get(pd.sizes.J)).toThrow(PredrawOverflowError);
  });

  it('tyre-temperature noise and lap residual are separate arrays (Finding 8)', () => {
    const pd = predraw(3, predrawSizes(3600, 107, 10));
    expect(pd.tyreTempN.data).not.toBe(pd.epsN.data);
    expect(Math.abs(corr(Array.from(pd.tyreTempN.data), Array.from(pd.epsN.data)))).toBeLessThan(0.05);
  });

  it('per-car arrays do not depend on field size (pairing invariant)', () => {
    const a = predraw(914, predrawSizes(10800, 107, 10));
    const b = predraw(914, predrawSizes(10800, 107, 10));
    for (let c = 0; c < 10; c++) for (let k = 0; k < 5; k++) expect(a.epsN.get(c, k)).toBe(b.epsN.get(c, k));
  });
});

describe('M01 multiplier processes', () => {
  it('exp-OU: mean ≈ 0, sd ≈ σ/√(2κ), zero clips at defaults over 20,000 laps', () => {
    const r = new Rng(11);
    const clips = new ClipCounter();
    let x = 0, y = 0, z = 0;
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < 20_000; i++) {
      [x, y, z] = stepMultipliers(x, y, z, r.normal(), r.normal(), r.normal(), DEFAULT_MULTIPLIERS, clips);
      xs.push(x);
      ys.push(y);
    }
    const sd = (a: number[]) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    expect(Math.abs(xs.reduce((s, v) => s + v, 0) / xs.length)).toBeLessThan(0.01);
    expect(Math.abs(sd(xs) / stationarySd(DEFAULT_MULTIPLIERS.X) - 1)).toBeLessThan(0.05);
    expect(Math.abs(sd(ys) / stationarySd(DEFAULT_MULTIPLIERS.Y) - 1)).toBeLessThan(0.08);
    expect(clips.count).toBe(0);
  });

  it('GBM keeps a flat median over 100 laps', () => {
    const r = new Rng(5);
    const finals: number[] = [];
    for (let p = 0; p < 10_000; p++) {
      let x = 0;
      for (let k = 0; k < 100; k++) x = gbmStep(x, DEFAULT_MULTIPLIERS.X, r.normal());
      finals.push(Math.exp(x));
    }
    finals.sort((a, b) => a - b);
    expect(Math.abs(finals[5000] - 1)).toBeLessThan(0.02);
    expect(ouStep(0, DEFAULT_MULTIPLIERS.X, 0)).toBe(0);
  });

  it('correlated shocks have correlation ρ_XY', () => {
    const r = new Rng(9);
    const a: number[] = [], b: number[] = [];
    for (let i = 0; i < 50_000; i++) {
      const [zx, zy] = correlate(r.normal(), r.normal(), r.normal(), -0.4);
      a.push(zx);
      b.push(zy);
    }
    expect(Math.abs(corr(a, b) + 0.4)).toBeLessThan(0.02);
  });
});
