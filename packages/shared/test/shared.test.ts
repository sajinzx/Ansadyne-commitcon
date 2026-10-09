import { describe, expect, it } from 'vitest';
import {
  defaultConfigs, defaultRunConfig, findBadProvenance, RunConfigSchema, SPLIT_RANGES, DEFAULT_SEED,
  splitOfSeed, BenchRequestSchema, WeatherMatrixSchema,
} from '../src';

describe('shared configs and schemas (gate 1)', () => {
  it('every default config uses only the six provenance tags', () => {
    const cfg = defaultConfigs();
    for (const [name, obj] of Object.entries(cfg)) {
      expect(findBadProvenance(obj), name).toEqual([]);
    }
  });

  it('rejects an unknown provenance tag', () => {
    const cfg = defaultConfigs();
    (cfg.track.segments[0].dryGrip as { provenance: string }).provenance = 'MEASURED';
    expect(findBadProvenance(cfg.track)).toEqual(['$.segments[0].dryGrip.provenance']);
  });

  it('split ranges never overlap and the default seed is in dev', () => {
    const ranges = Object.values(SPLIT_RANGES).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBeGreaterThan(ranges[i - 1][1]);
    expect(splitOfSeed(DEFAULT_SEED)).toBe('dev');
  });

  it('validates run configs, including seed/split agreement and ranges', () => {
    expect(RunConfigSchema.safeParse(defaultRunConfig()).success).toBe(true);
    expect(RunConfigSchema.safeParse(defaultRunConfig({ split: 'test' })).success).toBe(false);
    expect(RunConfigSchema.safeParse(defaultRunConfig({ durationHours: 24 as 3 })).success).toBe(false);
    const badRho = defaultRunConfig({ overrides: { processes: { rhoXY: 0.995 } } });
    expect(RunConfigSchema.safeParse(badRho).success).toBe(false);
    const badKappa = defaultRunConfig({ overrides: { processes: { kappaX: 0 } } });
    expect(RunConfigSchema.safeParse(badKappa).success).toBe(false);
  });

  it('weather matrix rows must sum to one', () => {
    expect(WeatherMatrixSchema.safeParse([[0.996, 0.004, 0], [0.03, 0.94, 0.03], [0, 0.04, 0.96]]).success).toBe(true);
    expect(WeatherMatrixSchema.safeParse([[0.9, 0.004, 0], [0.03, 0.94, 0.03], [0, 0.04, 0.96]]).success).toBe(false);
  });

  it('caps benchmark seeds by split size', () => {
    expect(BenchRequestSchema.safeParse({ families: ['F5'], seedsPerFamily: 5000, split: 'dev' }).success).toBe(false);
    expect(BenchRequestSchema.safeParse({ families: ['F5'], seedsPerFamily: 20, split: 'dev' }).success).toBe(true);
  });

  it('track segments are contiguous and sum to 5,730 m', () => {
    const { track } = defaultConfigs();
    let s = 0;
    for (const seg of track.segments) {
      expect(seg.start_m).toBe(s);
      s = seg.end_m;
    }
    expect(s).toBe(5730);
  });
});
