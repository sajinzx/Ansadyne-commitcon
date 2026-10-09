// Zod schemas for configs and API payloads (docs/spec/shared/SHARED_TYPES.md §S.2).
import { z } from 'zod';
import { PROVENANCE_TAGS, type Split } from './types';

export const ProvenanceSchema = z.enum(PROVENANCE_TAGS);

/** Seed ranges per split (00_PROJECT_RULES.md R9). */
export const SPLIT_RANGES: Record<Split, [number, number]> = {
  dev: [1, 4999],
  val: [5000, 9999],
  test: [1_000_000, 1_999_999],
};
export const DEFAULT_SEED = 914;

export function splitOfSeed(seed: number): Split | null {
  for (const [split, [lo, hi]] of Object.entries(SPLIT_RANGES) as [Split, [number, number]][]) {
    if (seed >= lo && seed <= hi) return split;
  }
  return null;
}

export function seedLabel(seed: number): string {
  const split = splitOfSeed(seed);
  return split ? `${split}-${seed}` : `custom-${seed}`;
}

/** Recursively check that every `provenance` field uses an allowed tag. Returns offending paths. */
export function findBadProvenance(obj: unknown, path = '$'): string[] {
  const bad: string[] = [];
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => bad.push(...findBadProvenance(v, `${path}[${i}]`)));
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === 'provenance') {
        if (!ProvenanceSchema.safeParse(v).success) bad.push(`${path}.${k}`);
      } else {
        bad.push(...findBadProvenance(v, `${path}.${k}`));
      }
    }
  }
  return bad;
}

const matrixRow = z.array(z.number().min(0).max(1)).length(3);
export const WeatherMatrixSchema = z
  .array(matrixRow)
  .length(3)
  .refine((m) => m.every((row) => Math.abs(row.reduce((a, b) => a + b, 0) - 1) < 1e-9), {
    message: 'each transition-matrix row must sum to 1',
  });

export const PlannerOverridesSchema = z
  .object({
    paths: z.union([z.literal(100), z.literal(200), z.literal(400), z.literal(800)]).optional(),
    horizonLaps: z.number().int().min(10).max(80).optional(),
    lambdaRisk: z.number().min(0).max(2).optional(),
    cvarAlpha: z.number().min(0.8).max(0.99).optional(),
    pFailLimit: z.number().min(0.001).max(0.05).optional(),
    pauseForPlanner: z.boolean().optional(),
    gripZ: z.number().min(1).max(5).optional(),
    gripCooldown: z.number().int().min(0).max(30).optional(),
  })
  .strict();

export const RunConfigSchema = z
  .object({
    masterSeed: z.number().int().min(1).max(1_999_999),
    split: z.enum(['dev', 'val', 'test']),
    family: z.string().optional(),
    durationHours: z.union([z.literal(1), z.literal(3), z.literal(6)]),
    startClock: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    egoGridSlot: z.number().int().min(1).max(10),
    multiplierModel: z.enum(['expOU', 'gbm']),
    overrides: z
      .object({
        car: z
          .object({
            capacity_kg: z.number().min(40).max(120).optional(),
            qBase_kg_per_lap: z.number().min(1).max(5).optional(),
            kBaseDry_per_lap: z.number().min(0.002).max(0.05).optional(),
            laneLength_m: z.number().min(200).max(1200).optional(),
            serviceMode: z.enum(['sequential', 'parallel']).optional(),
          })
          .strict()
          .optional(),
        race: z.object({ background_per_lap: z.number().min(0).max(0.05).optional() }).strict().optional(),
        planner: PlannerOverridesSchema.optional(),
        weatherMatrix: WeatherMatrixSchema.optional(),
        processes: z
          .object({
            sigmaX: z.number().min(0).max(0.1).optional(),
            kappaX: z.number().gt(0).max(2).optional(),
            rhoXY: z.number().gt(-0.99).lt(0.99).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    oracleBelief: z.boolean().optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const split = splitOfSeed(cfg.masterSeed);
    if (split !== cfg.split) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['masterSeed'],
        message: `seed ${cfg.masterSeed} is not in the ${cfg.split} split range ${SPLIT_RANGES[cfg.split].join('–')}`,
      });
    }
    const cap = cfg.overrides.car?.capacity_kg;
    const q = cfg.overrides.car?.qBase_kg_per_lap;
    if (cap !== undefined && q !== undefined && cap <= q * 1.0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['overrides', 'car'], message: 'capacity must exceed reserveLaps × base burn' });
    }
  });

export const ControlSchema = z.object({ action: z.enum(['start', 'pause', 'step']), speed: z.number().optional() }).strict();
export const SpeedSchema = z.object({ speed: z.union([z.literal(1), z.literal(5), z.literal(20), z.literal(60)]) }).strict();
export const InjectSchema = z
  .object({
    kind: z.enum(['caution', 'rain', 'fuelSpike', 'debris', 'weather', 'weatherMatrix', 'surface']),
    params: z
      .object({
        segmentId: z.string().optional(),
        regime: z.enum(['dry', 'damp', 'wet']).optional(),
        ticks: z.number().int().min(1).max(200).optional(),
        matrix: WeatherMatrixSchema.optional(),
        overrides: z.array(z.lazy(() => SegmentOverrideSchema)).max(20).optional(),
        trackTempOffset_C: z.number().min(-20).max(20).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.kind === 'weather' && !b.params?.regime) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['params', 'regime'], message: 'regime is required' });
    if (b.kind === 'weatherMatrix' && !b.params?.matrix) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['params', 'matrix'], message: 'matrix is required' });
    if (b.kind === 'surface' && !b.params?.overrides) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['params', 'overrides'], message: 'overrides is required ([] to reset)' });
  });
export const RiskSchema = z
  .object({
    lambdaRisk: z.number().min(0).max(2).optional(),
    cvarAlpha: z.number().min(0.8).max(0.99).optional(),
    pFailLimit: z.number().min(0.001).max(0.05).optional(),
  })
  .strict();
export const PlannerUpdateSchema = PlannerOverridesSchema;

export const PlanSchema = z.object({
  stops: z.array(
    z.object({
      lap: z.number().int().min(0),
      refuel: z.union([z.literal('helper'), z.number().min(0)]),
      tyres: z.enum(['none', 'dry', 'wet']),
    }),
  ),
  mode: z.object({ mode: z.enum(['save', 'normal', 'push']), untilLap: z.number().int() }).nullable(),
  source: z.string(),
  committedLap: z.number().int(),
});

export const ForkSchema = z
  .object({ world: z.enum(['B0', 'B1', 'OPT']), fromStep: z.number().int().min(0), forcedPlan: PlanSchema })
  .strict();

export const SegmentOverrideSchema = z
  .object({
    segmentId: z.string(),
    wetnessOffset: z.number().min(-1).max(1).optional(),
    debris: z.boolean().optional(),
    untilTick: z.number().int().optional(),
  })
  .strict();

export const TrackPreviewSchema = z
  .object({
    wetness: z.number().min(0).max(1),
    trackTemp_C: z.number().min(10).max(60),
    rubber: z.number().min(0).max(0.06),
    overrides: z.array(SegmentOverrideSchema).default([]),
  })
  .strict();

export const FAMILIES = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F10-adv'] as const;

export const BenchRequestSchema = z
  .object({
    families: z.array(z.enum(FAMILIES)).min(1),
    seedsPerFamily: z.number().int().min(1).max(10_000),
    split: z.enum(['dev', 'val', 'test']),
    rounds: z.array(z.number().int().min(10)).optional(),
    experiment: z.string().optional(),
    oracleBelief: z.boolean().optional(),
  })
  .strict()
  .superRefine((req, ctx) => {
    const [lo, hi] = SPLIT_RANGES[req.split];
    if (req.seedsPerFamily > hi - lo + 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['seedsPerFamily'], message: `at most ${hi - lo + 1} seeds in ${req.split}` });
    }
  });

export const SensitivitySchema = z.object({ param: z.string(), seeds: z.number().int().min(5).max(500).optional() }).strict();
