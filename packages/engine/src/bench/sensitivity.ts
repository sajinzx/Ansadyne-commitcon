// M13 §13.6 — one-at-a-time sensitivity of D = P(OPT) − P(B1) to an assumed parameter (tornado chart).
import type { Configs, Param, RunConfig } from '@pitwall/shared';
import { defaultRunConfig } from '@pitwall/shared';
import { buildModel, type ModelBundle } from '../vehicle/model';
import { benchContext, runSeed, seedsFor } from './runner';
import { mean } from '../stats';

export interface SensitiveParam {
  path: string; // e.g. "car.fuel.gaugeNoise_kg" or "race.residualSigma_s"
  value: number;
  low: number;
  high: number;
  provenance: string;
  ranged: boolean;
}

const SENSITIVE = new Set(['ASSUMED', 'ILLUSTRATIVE', 'UNCALIBRATED']);

/** Every numeric Param in the configs whose provenance is assumed, illustrative or uncalibrated. */
export function sensitiveParams(cfg: Configs): SensitiveParam[] {
  const out: SensitiveParam[] = [];
  const walk = (o: unknown, path: string) => {
    if (!o || typeof o !== 'object') return;
    const p = o as Partial<Param>;
    if (typeof p.value === 'number' && typeof p.provenance === 'string') {
      if (SENSITIVE.has(p.provenance)) {
        const ranged = p.low !== undefined && p.high !== undefined;
        out.push({ path, value: p.value, low: ranged ? p.low! : p.value * 0.8, high: ranged ? p.high! : p.value * 1.2, provenance: p.provenance, ranged });
      }
      return;
    }
    if (Array.isArray(o)) return; // segment lists are covered by the track's own parameters
    for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
  };
  for (const key of ['track', 'car', 'race'] as const) walk(cfg[key], key);
  return out;
}

function setParam(cfg: Configs, path: string, value: number): Configs {
  const c = structuredClone(cfg);
  const parts = path.split('.');
  let o: Record<string, unknown> = c as unknown as Record<string, unknown>;
  for (const k of parts.slice(0, -1)) o = o[k] as Record<string, unknown>;
  (o[parts[parts.length - 1]] as Param).value = value;
  return c;
}

export interface SensitivityResult {
  param: SensitiveParam;
  seeds: number;
  low: { value: number; meanD: number };
  high: { value: number; meanD: number };
}

export function runSensitivity(configs: Configs, path: string, opts: { seeds?: number; rounds?: number[]; durationHours?: 1 | 3 | 6; family?: string } = {}): SensitivityResult {
  const param = sensitiveParams(configs).find((p) => p.path === path);
  if (!param) throw new Error(`parameter ${path} is not an assumed/illustrative/uncalibrated numeric parameter`);
  const seeds = opts.seeds ?? 100;
  const run: Partial<RunConfig> = { durationHours: opts.durationHours ?? 3 };
  const at = (value: number) => {
    const cfg = setParam(configs, path, value);
    const model: ModelBundle = buildModel(cfg, { ...defaultRunConfig(), ...run });
    const ctx = benchContext(cfg, run, { rounds: opts.rounds, model });
    const d = seedsFor('dev', opts.family ?? 'F5', seeds).map((s) => {
      const r = runSeed(ctx, opts.family ?? 'F5', s, run);
      return r.worlds.OPT.finalPos - r.worlds.B1.finalPos;
    });
    return { value, meanD: mean(d) };
  };
  return { param, seeds, low: at(param.low), high: at(param.high) };
}
