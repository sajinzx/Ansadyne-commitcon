import { describe, expect, it } from 'vitest';
import { SPLIT_RANGES, DEFAULT_SEED, splitOfSeed, defaultRunConfig } from '@pitwall/shared';
import { CFG } from './helpers';
import { buildModel } from '../src/vehicle/model';
import { benchContext, runBench, runSeed, checkFrozen, settingsHash, FrozenSettingsError } from '../src/bench/runner';
import { mcnemar } from '../src/bench/stats';
import { Race } from '../src/sim/race';
import { B1Strategy, defaultB1Options } from '../src/strategy/b1';
import { OracleEstimator } from '../src/estimator/oracle';
import { sensitiveParams } from '../src/bench/sensitivity';
import { EXPERIMENTS } from '../src/bench/experiments';

const model1h = buildModel(CFG, { ...defaultRunConfig(), durationHours: 1 });

describe('M13 benchmark', () => {
  it('20-seed F5 smoke run gives the full table with CIs and is byte-identical on rerun', () => {
    // documented: 1-hour races keep the fast suite within budget
    const req = { families: ['F5'], seedsPerFamily: 20, split: 'dev' as const, rounds: [50, 100] };
    const a = runBench(CFG, req, { model: model1h, run: { durationHours: 1 } });
    const b = runBench(CFG, req, { model: model1h, run: { durationHours: 1 } });
    // decision latency is a measurement (R8) and is excluded from the identity check
    const strip = (r: typeof a) => JSON.stringify(r.families.map((f) => ({ ...f, decisionMsP95: 0 })));
    expect(strip(b)).toBe(strip(a));
    const f = a.families[0];
    expect(f.n).toBe(20);
    for (const k of ['OPT-B1', 'OPT-B0', 'B1-B0'] as const) {
      const d = f.diffs[k];
      expect(d.ciBoot95[0]).toBeLessThanOrEqual(d.mean + 1e-12);
      expect(d.ciBoot95[1]).toBeGreaterThanOrEqual(d.mean - 1e-12);
      expect(d.ciT95[0]).toBeLessThanOrEqual(d.ciT95[1]);
    }
    expect(f.winTieLoss['OPT-B1'].reduce((x, y) => x + y, 0)).toBe(20);
    expect(a.rounds).toEqual([50, 100]);
  }, 180_000);

  it('split ranges never overlap, seed 914 is dev, test runs need frozen settings', () => {
    const r = Object.values(SPLIT_RANGES).sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < r.length; i++) expect(r[i][0]).toBeGreaterThan(r[i - 1][1]);
    expect(splitOfSeed(DEFAULT_SEED)).toBe('dev');
    const h = settingsHash(CFG, [50, 100, 200]);
    expect(() => checkFrozen('test', h)).toThrow(FrozenSettingsError);
    expect(() => checkFrozen('test', h, 'other')).toThrow(FrozenSettingsError);
    expect(() => checkFrozen('test', h, h)).not.toThrow();
    expect(() => checkFrozen('dev', h)).not.toThrow();
  });

  it('F2–F4 and F10 forced cautions occur at the same step in all three worlds', () => {
    const b1 = () => new B1Strategy(defaultB1Options(model1h));
    for (const family of ['F2', 'F3', 'F4', 'F10']) {
      const race = new Race({ configs: model1h.cfg, model: model1h, family, run: { ...defaultRunConfig(), durationHours: 1, masterSeed: 33 }, strategies: { B0: b1(), B1: b1(), OPT: b1() } });
      const outs = race.runToEnd();
      const injected = outs.flatMap((o) => o.events.filter((e) => e.type === 'caution_start' && e.cause === 'injected').map((e) => ({ step: o.step, world: (e as { world: string }).world })));
      expect(injected.length).toBeGreaterThan(0);
      const step = injected[0].step;
      const worldsAt = new Set(injected.filter((x) => x.step === step).map((x) => x.world));
      // a world already under caution at that step cannot start another one
      const busy = outs[step].laps.filter((l) => l.caution.active).map((l) => l.world);
      for (const w of ['B0', 'B1', 'OPT']) expect(worldsAt.has(w) || busy.includes(w as 'B0')).toBe(true);
    }
  }, 120_000);

  it('oracle belief equals the truth (bench-only honesty experiment)', () => {
    const ctx = benchContext(CFG, { durationHours: 1 }, { model: model1h, rounds: [50], oracle: true });
    const rec = runSeed(ctx, 'F5', 40, { durationHours: 1 });
    expect(rec.worlds.OPT.laps).toBeGreaterThan(20);
    const b1 = () => new B1Strategy(defaultB1Options(model1h));
    const race = new Race({ configs: model1h.cfg, model: model1h, oracleBelief: true, estimatorFactory: (m) => new OracleEstimator(m), run: { ...defaultRunConfig(), durationHours: 1, masterSeed: 41 }, strategies: { B0: b1(), B1: b1(), OPT: b1() } });
    for (let k = 0; k < 5; k++) race.step();
    const ego = race.world('B1').cars.find((c) => c.no === 12)!;
    expect(race.estimators[1]!.belief().fuel.mean).toBeCloseTo(ego.fuel_kg, 9);
  }, 60_000);

  it('statistics helpers: McNemar, sensitivity parameter list, experiment catalogue', () => {
    expect(mcnemar(0, 0)).toBe(1);
    expect(mcnemar(10, 0)).toBeCloseTo(2 / 1024, 9);
    const ps = sensitiveParams(CFG);
    expect(ps.length).toBeGreaterThan(5);
    for (const p of ps) expect(p.low).toBeLessThanOrEqual(p.high);
    expect(EXPERIMENTS.map((e) => e.id)).toEqual(['gbm', 'sigmaX', 'rhoXY', 'oracle', 'seedSets', 'hazards']);
  });
});
