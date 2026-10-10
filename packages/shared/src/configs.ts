// Default configuration files (packages/shared/config). Always hand out deep copies.
import track from '../config/track.daytona.json';
import sebring from '../config/track.sebring.json';
import roadAtlanta from '../config/track.road-atlanta.json';
import watkinsGlen from '../config/track.watkins-glen.json';
import spa from '../config/track.spa.json';
import car from '../config/car.gt3.json';
import race from '../config/race.default.json';
import field from '../config/field.json';
import planner from '../config/planner.default.json';
import type { Configs, Param, RunConfig, TrackConfig } from './types';
import { DEFAULT_SEED } from './schemas';

const DEFAULTS = { track, car, race, field, planner } as unknown as Configs;

export function defaultConfigs(): Configs {
  return structuredClone(DEFAULTS);
}

/** Circuits a race can be run on. Daytona is the reference the car model is calibrated on. */
export const TRACK_IDS = ['daytona', 'sebring', 'road-atlanta', 'watkins-glen', 'spa'] as const;
export type TrackId = (typeof TRACK_IDS)[number];

interface TrackFile extends TrackConfig {
  car?: { lapRef_s: Param };
}

const TRACK_FILES: Record<TrackId, TrackFile> = {
  daytona: track as unknown as TrackFile,
  sebring: sebring as unknown as TrackFile,
  'road-atlanta': roadAtlanta as unknown as TrackFile,
  'watkins-glen': watkinsGlen as unknown as TrackFile,
  spa: spa as unknown as TrackFile,
};

export interface TrackInfo {
  id: TrackId;
  name: string;
  country: string;
  lapLength_m: number;
  lapRef_s: number;
  corners: number;
}

/** The track list for pickers: name, length and the FITTED reference lap. */
export function trackList(): TrackInfo[] {
  return TRACK_IDS.map((id) => {
    const t = TRACK_FILES[id];
    return {
      id,
      name: t.name.replace(/ \(schematic\)$/, ''),
      country: t.country ?? '',
      lapLength_m: t.lapLength_m.value,
      lapRef_s: t.car?.lapRef_s.value ?? (car as { lapRef_s: Param }).lapRef_s.value,
      corners: t.segments.filter((s) => s.type !== 'straight').length,
    };
  });
}

/**
 * Put a run on another circuit: swap the track, take its FITTED reference lap, and scale the per-lap quantities that
 * grow with distance (fuel burn, tyre wear, background caution rate, traffic encounters) by the lap-length ratio to
 * Daytona's 5,730 m. Daytona (or no id) leaves the configs as they are.
 */
export function applyTrack(cfg: Configs, id: string | undefined): Configs {
  if (!id || id === 'daytona') return cfg;
  const t = TRACK_FILES[id as TrackId];
  if (!t) throw new Error(`unknown track ${id}`);
  const { car: carOverride, ...trackCfg } = structuredClone(t);
  const ratio = trackCfg.lapLength_m.value / cfg.track.lapLength_m.value;
  cfg.track = trackCfg as TrackConfig;
  if (carOverride?.lapRef_s) cfg.car.lapRef_s = carOverride.lapRef_s;
  cfg.car.fuel.qBase_kg_per_lap *= ratio;
  cfg.car.tyres.dry.kBase_per_lap *= ratio;
  cfg.car.tyres.wet.kBase_per_lap *= ratio;
  cfg.race.caution.background_per_lap *= ratio;
  cfg.race.traffic.pPerLap = Math.min(0.95, cfg.race.traffic.pPerLap * ratio);
  return cfg;
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
