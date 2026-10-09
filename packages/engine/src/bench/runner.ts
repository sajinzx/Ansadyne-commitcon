// M13 §13.3 — headless benchmark: three worlds per seed, planner inline (B22), no LapEvent streaming.
import type { BenchRequest, BenchResult, Configs, RunConfig, Split, StrategyId } from '@pitwall/shared';
import { FAMILIES, SPLIT_RANGES, defaultRunConfig, hashString, stableStringify } from '@pitwall/shared';
import { assembleModel, buildModel, type ModelBundle } from '../vehicle/model';
import { Race } from '../sim/race';
import { Estimator } from '../estimator/ekf';
import { OracleEstimator } from '../estimator/oracle';
import { B0Strategy, b0Plan } from '../strategy/b0';
import { B1Strategy, defaultB1Options } from '../strategy/b1';
import { OptStrategy } from '../strategy/opt';
import { summarize, type SeedRecord, type WorldRecord } from './stats';
import { nowMs } from '../planner/timing';

export const BENCH_DEFAULT_ROUNDS = [50, 100, 200];
export const CODE_VERSION = '0.1.0';

/** Settings that must be frozen before a val/test run (B1 thresholds, triggers, planner rounds, candidates). */
export function settingsHash(cfg: Configs, rounds: number[]): string {
  return hashString(stableStringify({ planner: { ...cfg.planner, rounds }, car: cfg.car.fuel.reserveLaps }));
}

export interface BenchContext {
  base: ModelBundle;
  rounds: number[];
  oracle: boolean;
  /** per-family B0 plans are computed from the family's model inside the race; cache the base one */
  b0: ReturnType<typeof b0Plan>;
}

/** Prepare a context: one calibrated model (and surrogate) reused by every seed. */
export function benchContext(configs: Configs, run: Partial<RunConfig> = {}, opts: { rounds?: number[]; oracle?: boolean; model?: ModelBundle } = {}): BenchContext {
  const fullRun: RunConfig = {
    ...defaultRunConfig(),
    ...(opts.model ? { durationHours: opts.model.durationHours as 1 | 3 | 6 } : {}),
    ...run,
  };
  let model = opts.model ?? buildModel(configs, fullRun);
  const rounds = opts.rounds ?? BENCH_DEFAULT_ROUNDS;
  if (opts.model) model = assembleModel(model.cfg, fullRun, model.geo, model.cal, model.surrogate, model.overrides);
  model.cfg = structuredClone(model.cfg);
  model.cfg.planner.rounds = [...rounds];
  model.cfg.planner.paths = rounds[rounds.length - 1];
  return { base: model, rounds, oracle: opts.oracle ?? false, b0: b0Plan(model) };
}

/** Run one seed of one family through all three worlds. */
export function runSeed(ctx: BenchContext, family: string, seed: number, run: Partial<RunConfig> = {}): SeedRecord {
  const model = ctx.base;
  const race = new Race({
    configs: model.cfg,
    model,
    family,
    run: { ...defaultRunConfig(), durationHours: model.durationHours as 1 | 3 | 6, ...run, masterSeed: seed, family },
    estimatorFactory: (m) => (ctx.oracle ? new OracleEstimator(m) : new Estimator(m)),
    oracleBelief: ctx.oracle,
    strategies: {
      B0: new B0Strategy(ctx.b0),
      B1: new B1Strategy(defaultB1Options(model)),
      OPT: new OptStrategy({ initialPlan: ctx.b0 }),
    },
  });
  const decisionMs: number[] = [];
  let decisions = 0;
  while (!race.finished && race.k < 10_000) {
    const out = race.step();
    for (const d of out.decisions) {
      decisions++;
      decisionMs.push(d.elapsedMs);
    }
  }
  const res = race.results();
  const worlds = {} as Record<StrategyId, WorldRecord>;
  for (const id of ['B0', 'B1', 'OPT'] as StrategyId[]) {
    worlds[id] = {
      finalPos: res[id].finalPos,
      laps: res[id].laps,
      stops: res[id].stops,
      dnf: res[id].dnf ?? null,
      decisions: id === 'OPT' ? decisions : 0,
      decisionMs: id === 'OPT' ? decisionMs : [],
    };
  }
  return { family, seed, worlds, clipFraction: race.clips.laps ? race.clips.count / race.clips.laps : 0 };
}

/** Seeds for a family in a split (consecutive from the split start, offset per family so families differ). */
export function seedsFor(split: Split, family: string, count: number, offset = 0): number[] {
  const [lo, hi] = SPLIT_RANGES[split];
  const cap = split === 'test' ? 10_000 : hi - lo + 1;
  const n = Math.min(count, cap);
  return Array.from({ length: n }, (_, i) => lo + ((offset + i) % (hi - lo + 1)));
}

export class FrozenSettingsError extends Error {}

export interface RunBenchOptions {
  /** the settings hash frozen for val/test runs; required for split = test */
  frozenSettingsHash?: string;
  onProgress?: (done: number, total: number) => void;
  /** seed-set offset (experiment 5) */
  seedOffset?: number;
}

/** Run a whole benchmark request in-process (the backend splits seeds across worker threads instead). */
export function runBench(configs: Configs, req: BenchRequest, opts: RunBenchOptions & { run?: Partial<RunConfig>; model?: ModelBundle } = {}): BenchResult {
  const t0 = nowMs();
  const ctx = benchContext(configs, opts.run, { rounds: req.rounds, oracle: req.oracleBelief, model: opts.model });
  const hash = settingsHash(ctx.base.cfg, ctx.rounds);
  checkFrozen(req.split, hash, opts.frozenSettingsHash);
  const total = req.families.length * req.seedsPerFamily;
  let done = 0;
  const byFamily = req.families.map((family) => {
    const index = FAMILIES.indexOf(family as (typeof FAMILIES)[number]);
    const recs = seedsFor(req.split, family, req.seedsPerFamily, opts.seedOffset ?? 0).map((seed) => {
      const r = runSeed(ctx, family, seed, opts.run);
      opts.onProgress?.(++done, total);
      return r;
    });
    return { family, index: Math.max(0, index), recs };
  });
  return {
    families: summarize(byFamily),
    settingsHash: hash,
    codeVersion: CODE_VERSION,
    runtimeMs: nowMs() - t0,
    rounds: ctx.rounds,
    split: req.split,
    experiment: req.experiment,
  };
}

/** R9 / M13 test 2: a test-split run requires settings frozen beforehand (hash match). */
export function checkFrozen(split: Split, hash: string, frozen?: string): void {
  if (split === 'test' && frozen !== hash) {
    throw new FrozenSettingsError(`test-split runs require frozen settings (expected hash ${frozen ?? '<none>'}, current ${hash})`);
  }
}
