// Model bundle: effective configs + geometry + calibration + surrogate + derived pit-lane constants.
// Shared by the engine, the baselines and the planner, so all use one physics model.
import type { Configs, RunConfig, SegmentOverride } from '@pitwall/shared';
import { applyTrack } from '@pitwall/shared';
import { TrackGeometry } from '../track/geometry';
import { airDensity } from './qss';
import { calibrate, tauAt, type Calibration } from './calibrate';
import { Surrogate } from './surrogate';
import { DEFAULT_MULTIPLIERS, type MultiplierParams } from '../stochastic/ou';

export interface LaneConstants {
  length: number;
  uLine: number;
  uBox: number;
  vPit: number;
  entryLoss: number;
  exitLoss: number;
  entryS: number;
  exitS: number;
  toLine: number;
  lineToBox: number;
  boxToExit: number;
  transit: number;
}

export interface ModelBundle {
  cfg: Configs;
  geo: TrackGeometry;
  cal: Calibration;
  surrogate: Surrogate;
  overrides: SegmentOverride[];
  lane: LaneConstants;
  tauEntry: number;
  tauExit: number;
  lapLength: number;
  lapRef: number;
  multipliers: MultiplierParams;
  weatherMatrix: number[][];
  tyreSets: { dry: number; wet: number };
  durationHours: number;
  /** multiplier on the persistent-coefficient spreads (family F9 uses 3) */
  coeffSpread: number;
}

export const DEFAULT_WEATHER_MATRIX = [
  [0.996, 0.004, 0.0],
  [0.03, 0.94, 0.03],
  [0.0, 0.04, 0.96],
];

/** Apply a RunConfig's overrides to the default configs (never mutates the input). */
export function effectiveConfigs(base: Configs, run: RunConfig): Configs {
  // the circuit first (it rescales per-lap quantities), then the run's own overrides on top
  const cfg = applyTrack(structuredClone(base), run.trackId);
  cfg.race.duration_s = run.durationHours * 3600;
  cfg.race.startClock = run.startClock;
  const car = run.overrides.car;
  if (car?.capacity_kg !== undefined) {
    cfg.car.fuel.capacity_kg = car.capacity_kg;
    cfg.race.startingFuel_kg = Math.min(cfg.race.startingFuel_kg, car.capacity_kg);
  }
  if (car?.qBase_kg_per_lap !== undefined) cfg.car.fuel.qBase_kg_per_lap = car.qBase_kg_per_lap;
  if (car?.kBaseDry_per_lap !== undefined) cfg.car.tyres.dry.kBase_per_lap = car.kBaseDry_per_lap;
  if (car?.laneLength_m !== undefined) cfg.track.pitLane.laneLength_m.value = car.laneLength_m;
  if (car?.serviceMode !== undefined) cfg.race.rules.serviceMode.value = car.serviceMode;
  if (run.overrides.race?.background_per_lap !== undefined) cfg.race.caution.background_per_lap = run.overrides.race.background_per_lap;
  const p = run.overrides.planner;
  if (p) {
    if (p.paths !== undefined) {
      cfg.planner.paths = p.paths;
      cfg.planner.rounds = roundsFor(p.paths);
    }
    if (p.horizonLaps !== undefined) cfg.planner.horizonLaps = p.horizonLaps;
    if (p.lambdaRisk !== undefined) cfg.planner.lambdaRisk = p.lambdaRisk;
    if (p.cvarAlpha !== undefined) cfg.planner.cvarAlpha = p.cvarAlpha;
    if (p.pFailLimit !== undefined) cfg.planner.pFailLimit = p.pFailLimit;
    if (p.pauseForPlanner !== undefined) cfg.planner.pauseForPlanner = p.pauseForPlanner;
    if (p.gripZ !== undefined) cfg.planner.triggers.gripZ = p.gripZ;
    if (p.gripCooldown !== undefined) cfg.planner.triggers.gripCooldown = p.gripCooldown;
  }
  return cfg;
}

/** Successive-halving rounds ending at `paths` (paths = 50·2^m). */
export function roundsFor(paths: number): number[] {
  const out: number[] = [];
  for (let n = 50; n <= paths; n *= 2) out.push(n);
  return out.length ? out : [paths];
}

export function multipliersFor(run: RunConfig): MultiplierParams {
  const m = structuredClone(DEFAULT_MULTIPLIERS);
  m.model = run.multiplierModel;
  const pr = run.overrides.processes;
  if (pr?.sigmaX !== undefined) m.X.sigma = pr.sigmaX;
  if (pr?.kappaX !== undefined) m.X.kappa = pr.kappaX;
  if (pr?.rhoXY !== undefined) m.rhoXY = pr.rhoXY;
  return m;
}

export function tyreSetsFor(cfg: Configs, hours: number): { dry: number; wet: number } {
  const t = cfg.race.rules.tyreSets;
  return { dry: t.dryBase + t.dryPerHour * hours, wet: t.wetBase + t.wetPerHour * hours };
}

export interface BuildOptions {
  overrides?: SegmentOverride[];
  /** reuse a calibration (and its geometry) to skip work, e.g. when only overrides change */
  calibration?: { cal: Calibration; geo: TrackGeometry };
  surrogate?: Surrogate;
}

/** Build the model for a run: applies the run's overrides to `base`, calibrates and builds the surrogate. */
export function buildModel(base: Configs, run: RunConfig, opts: BuildOptions = {}): ModelBundle {
  const cfg = effectiveConfigs(base, run);
  const geo = opts.calibration?.geo ?? new TrackGeometry(cfg.track);
  const cal = opts.calibration?.cal ?? calibrate(geo, cfg.car);
  const overrides = opts.overrides ?? [];
  const surrogate = opts.surrogate ?? Surrogate.build(geo, cfg.car, cal.muPeak, cal.power_kW, overrides, cfg.track);
  return assembleModel(cfg, run, geo, cal, surrogate, overrides);
}

export function assembleModel(
  cfg: Configs,
  run: RunConfig,
  geo: TrackGeometry,
  cal: Calibration,
  surrogate: Surrogate,
  overrides: SegmentOverride[],
): ModelBundle {
  const pl = cfg.track.pitLane;
  const vPit = pl.speedLimit_kph.value / 3.6;
  const length = pl.laneLength_m.value;
  const uLine = pl.timingLine_u_m.value;
  const uBox = pl.box_u_m.value;
  const lane: LaneConstants = {
    length,
    uLine,
    uBox,
    vPit,
    entryLoss: pl.entryLoss_s.value,
    exitLoss: pl.exitLoss_s.value,
    entryS: pl.entry_s_m,
    exitS: pl.exit_s_m,
    toLine: uLine / vPit,
    lineToBox: (uBox - uLine) / vPit,
    boxToExit: (length - uBox) / vPit,
    transit: length / vPit,
  };
  return {
    cfg,
    geo,
    cal,
    surrogate,
    overrides,
    lane,
    tauEntry: tauAt(cal.tau, pl.entry_s_m),
    tauExit: tauAt(cal.tau, pl.exit_s_m),
    lapLength: geo.lapLength,
    lapRef: cfg.car.lapRef_s.value,
    multipliers: multipliersFor(run),
    weatherMatrix: run.overrides.weatherMatrix ?? DEFAULT_WEATHER_MATRIX,
    tyreSets: tyreSetsFor(cfg, run.durationHours),
    durationHours: run.durationHours,
    coeffSpread: 1,
  };
}

/** Lap time from the surrogate with the air-density correction (no traffic, no residual). */
export function surrogateLap(model: ModelBundle, S: number, mMid: number, w: number, mode: 'save' | 'normal' | 'push', airTemp: number): number {
  return model.surrogate.lapTime(S, mMid, w, mode) * Math.pow(airDensity(airTemp) / model.cal.rhoRef, 0.15);
}

/** Fraction of a lap's time spent up to lap distance s: tau(s) under green, s/L under caution (uniform pace). */
export function lapFraction(model: ModelBundle, s: number, caution: boolean): number {
  return caution ? s / model.lapLength : tauAt(model.cal.tau, s);
}
