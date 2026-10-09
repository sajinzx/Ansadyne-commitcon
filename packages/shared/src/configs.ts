// Default configuration files (packages/shared/config). Always hand out deep copies.
import track from '../config/track.daytona.json';
import car from '../config/car.gt3.json';
import race from '../config/race.default.json';
import field from '../config/field.json';
import planner from '../config/planner.default.json';
import type { Configs, RunConfig } from './types';
import { DEFAULT_SEED } from './schemas';

const DEFAULTS = { track, car, race, field, planner } as unknown as Configs;

export function defaultConfigs(): Configs {
  return structuredClone(DEFAULTS);
}

export function defaultRunConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    masterSeed: DEFAULT_SEED,
    split: 'dev',
    durationHours: 3,
    startClock: '13:40',
    egoGridSlot: 6,
    multiplierModel: 'expOU',
    overrides: {},
    ...overrides,
  };
}

/** Stable JSON stringify (sorted keys) for hashing configs. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** FNV-1a 32-bit hash of a string, as 8 hex chars. Deterministic and dependency-free. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
