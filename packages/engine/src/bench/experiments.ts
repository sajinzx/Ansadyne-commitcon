// M13 §13.5 — experiments: each runs the benchmark under several variants and reports the strategy ranking.
import type { BenchResult, Configs, FamilyResult, RunConfig, StrategyId } from '@pitwall/shared';
import { STRATEGIES, defaultRunConfig } from '@pitwall/shared';
import { assembleModel, buildModel, type ModelBundle } from '../vehicle/model';
import { benchContext, runBench, runSeed, seedsFor, settingsHash, CODE_VERSION } from './runner';
import { summarize } from './stats';
import { nowMs } from '../planner/timing';

export interface Variant {
  label: string;
  run?: Partial<RunConfig>;
  oracle?: boolean;
  hazardScale?: number;
  seedOffset?: number;
}

export interface ExperimentDef {
  id: string;
  title: string;
  variants: Variant[];
}

const ou = (sigmaX?: number, rhoXY?: number): Partial<RunConfig> => ({
  overrides: { processes: { ...(sigmaX !== undefined ? { sigmaX } : {}), ...(rhoXY !== undefined ? { rhoXY } : {}) } },
});

export const EXPERIMENTS: ExperimentDef[] = [
  { id: 'gbm', title: 'GBM vs exp-OU multipliers', variants: [{ label: 'exp-OU', run: { multiplierModel: 'expOU' } }, { label: 'GBM', run: { multiplierModel: 'gbm' } }] },
  { id: 'sigmaX', title: 'Grip volatility σ_X', variants: [0.006, 0.012, 0.024].map((s) => ({ label: `σ_X = ${s}`, run: ou(s) })) },
  { id: 'rhoXY', title: 'Grip–wear correlation ρ_XY', variants: [0, -0.4, -0.8].map((r) => ({ label: `ρ_XY = ${r}`, run: ou(undefined, r) })) },
  { id: 'oracle', title: 'Honesty test: oracle belief vs normal OPT', variants: [{ label: 'normal' }, { label: 'oracle belief', oracle: true }] },
  { id: 'seedSets', title: 'Seed-set stability (5 disjoint dev sets)', variants: [0, 1, 2, 3, 4].map((i) => ({ label: `set ${i + 1}`, seedOffset: i * 1000 })) },
  { id: 'hazards', title: 'Hazard sensitivity (caution and incident rates)', variants: [0.5, 1, 2].map((h) => ({ label: `hazards × ${h}`, hazardScale: h })) },
];

export interface VariantResult {
  label: string;
  families: FamilyResult[];
  ranking: StrategyId[];
  rankFirst: StrategyId;
  clipFraction: number;
  invalid?: string;
}

function variantModel(base: ModelBundle, configs: Configs, v: Variant): ModelBundle {
  const run: RunConfig = { ...defaultRunConfig(), durationHours: base.durationHours as 1 | 3 | 6, ...(v.run ?? {}) };
  let m = assembleModel(base.cfg, run, base.geo, base.cal, base.surrogate, base.overrides);
  if (v.hazardScale !== undefined) {
    m = { ...m, cfg: structuredClone(m.cfg) };
    m.cfg.race.caution.background_per_lap *= v.hazardScale;
    m.cfg.race.incidents.base_per_car_lap *= v.hazardScale;
  }
  void configs;
  return m;
}

/** Run an experiment over `families` × `seedsPerFamily` dev seeds. */
export function runExperiment(
  configs: Configs,
  id: string,
  opts: { families?: string[]; seedsPerFamily?: number; rounds?: number[]; durationHours?: 1 | 3 | 6; model?: ModelBundle; onProgress?: (d: number, t: number) => void } = {},
): BenchResult {
  const t0 = nowMs();
  const def = EXPERIMENTS.find((e) => e.id === id);
  if (!def) throw new Error(`unknown experiment ${id}`);
  const families = opts.families ?? ['F5'];
  const n = opts.seedsPerFamily ?? 20;
  const base = opts.model ?? buildModel(configs, { ...defaultRunConfig(), durationHours: opts.durationHours ?? 3 });
  const total = def.variants.length * families.length * n;
  let done = 0;
  const variants: VariantResult[] = def.variants.map((v) => {
    const ctx = benchContext(configs, v.run ?? {}, { rounds: opts.rounds, oracle: v.oracle, model: variantModel(base, configs, v) });
    let clips = 0;
    const byFamily = families.map((family, index) => ({
      family,
      index,
      recs: seedsFor('dev', family, n, v.seedOffset ?? 0).map((seed) => {
        const r = runSeed(ctx, family, seed, v.run);
        clips += r.clipFraction;
        opts.onProgress?.(++done, total);
        return r;
      }),
    }));
    const fam = summarize(byFamily);
    const meanPos = (sid: StrategyId) => fam.reduce((a, f) => a + f.meanPos[sid], 0) / fam.length;
    const ranking = [...STRATEGIES].sort((a, b) => meanPos(a) - meanPos(b));
    const clipFraction = clips / (families.length * n);
    return {
      label: v.label,
      families: fam,
      ranking,
      rankFirst: ranking[0],
      clipFraction,
      invalid: id === 'gbm' && clipFraction > 0.01 ? `GBM clip fraction ${(clipFraction * 100).toFixed(2)}% > 1%` : undefined,
    };
  });
  const firsts = variants.map((v) => v.rankFirst);
  const stability = Object.fromEntries(STRATEGIES.map((s) => [s, firsts.filter((f) => f === s).length / firsts.length]));
  const rounds = opts.rounds ?? [50, 100, 200];
  return {
    families: variants[0].families,
    settingsHash: settingsHash(base.cfg, rounds),
    codeVersion: CODE_VERSION,
    runtimeMs: nowMs() - t0,
    rounds,
    split: 'dev',
    experiment: id,
    extra: { title: def.title, variants, rankFirstShare: stability },
  };
}

export { runBench };
