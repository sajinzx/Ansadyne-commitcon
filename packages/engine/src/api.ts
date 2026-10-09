// Read-only services used by the backend: run init payload, diagnostics, track preview and projections.
import type { Diagnostics, FieldCar, Plan, Projection, RunInit, SegmentOverride, StrategyId } from '@pitwall/shared';
import type { ModelBundle } from './vehicle/model';
import { tauAt } from './vehicle/calibrate';
import { QssSolver, qssCar, airDensity } from './vehicle/qss';
import { nodeFactors, segmentGrips, sTrack } from './track/surface';
import { pitDiagnostics } from './sim/pit';
import { sampleWorld, rollout, toRolloutPlan, type RolloutResult } from './planner/rollout';
import { firmStops } from './planner/plan';
import { stream, STREAM } from './rng/rng';
import { mean, quantile } from './stats';
import type { Race } from './sim/race';

export function diagnostics(model: ModelBundle): Diagnostics {
  const cal = model.cal;
  const p = cal.physics;
  const pit = pitDiagnostics(model);
  return {
    mu_peak: cal.muPeak,
    power_kW: cal.power_kW,
    lapRef_s: cal.reference.lapTime,
    sectorTimes_s: [...cal.reference.sectorTimes] as [number, number, number],
    c_f_s_per_kg: p.c_f_s_per_kg,
    topSpeed_kph: p.topSpeed_kph,
    topSpeedAt_m: p.topSpeedAt_m,
    topSpeedSegment: p.topSpeedSegment,
    minSpeedS04_kph: p.minSpeedS04_kph,
    minSpeedS08_kph: p.minSpeedS08_kph,
    dT_dS: p.dT_dS,
    tau5613: tauAt(cal.tau, 5613),
    tau884: tauAt(cal.tau, 884),
    tStretchRef_s: cal.tStretchRef,
    pit: { fullStop_s: pit.fullStop_s, netGreen_s: pit.netGreen_s, netCaution_s: pit.netCaution_s },
  };
}

export function runInit(model: ModelBundle, b0: Plan): RunInit {
  const s: number[] = [];
  const tau: number[] = [];
  for (let x = 0; x <= model.lapLength; x += 20) {
    s.push(x);
    tau.push(tauAt(model.cal.tau, x));
  }
  return {
    track: model.geo.payload(),
    tau: { s, tau },
    b0Plan: b0,
    diagnostics: diagnostics(model),
    mu_peak: model.cal.muPeak,
    field: model.cfg.field.cars as FieldCar[],
    ego: model.cfg.field.ego,
    setsAvailable: { ...model.tyreSets },
    expectedLaps: Math.round(model.cfg.race.duration_s / model.lapRef),
  };
}

export interface TrackPreviewRequest {
  wetness: number;
  trackTemp_C: number;
  rubber: number;
  overrides: SegmentOverride[];
}

/** M02 grip function per segment plus a direct QSS solve under the given conditions. */
export function trackPreview(model: ModelBundle, req: TrackPreviewRequest) {
  const cfg = model.cfg;
  const grid = model.geo.grid;
  const solver = new QssSolver(grid, qssCar(cfg.car));
  const S = sTrack(req.trackTemp_C, req.rubber, req.wetness, cfg.track.meanDryGrip);
  const nodes = nodeFactors(cfg.track, grid, req.wetness, req.overrides);
  const mass = cfg.car.mass_dry_kg.value + cfg.car.fuel.capacity_kg / 2;
  const res = solver.solve(nodes, model.cal.muPeak * S, mass, model.cal.power_kW * 1000, airDensity(22), true);
  const sArr: number[] = [];
  const vArr: number[] = [];
  for (let i = 0; i < grid.n; i += 5) {
    sArr.push(i * grid.ds);
    vArr.push(res.v[i] * 3.6);
  }
  return {
    segments: segmentGrips(cfg.track, req),
    speedProfile: { s: sArr, v: vArr },
    lapTime_s: res.lapTime,
    sectorTimes_s: res.sectorTimes,
    diagnostics: diagnostics(model),
  };
}

/** 100-path projection of the final position for one world from that world's own belief. */
export function projection(race: Race, id: StrategyId, paths = 100): Projection | null {
  const ctx = race.worldContext(id);
  if (!ctx || !ctx.belief || !ctx.obs.ego.running) return null;
  const model = race.model;
  const lapsToFlag = Math.ceil(Math.max(0, ctx.obs.remaining_s) / model.lapRef) + 2;
  const H = Math.max(1, Math.min(model.cfg.planner.horizonLaps, lapsToFlag));
  const rng = stream(race.opts.run.masterSeed, STREAM.planner, ctx.obs.lap, 9000 + ['B0', 'B1', 'OPT'].indexOf(id), 0);
  const world = sampleWorld(ctx.obs, ctx.history, ctx.belief, model, rng, paths, H);
  const plan = ctx.plan;
  const rp = id === 'B1' || !plan ? { stops: [], mode: null } : toRolloutPlan({ ...plan, stops: firmStops(plan) });
  const out: RolloutResult = { pos: new Float64Array(paths), fail: new Uint8Array(paths) };
  rollout(world, rp, 0, paths, out);
  const ego = race.world(id).cars.find((c) => c.no === race.egoNo)!;
  return {
    step: race.k,
    world: id,
    meanPos: mean(out.pos),
    p10: quantile(out.pos, 0.1),
    p90: quantile(out.pos, 0.9),
    nextStopLap: plan?.stops[0]?.lap ?? null,
    stopsDone: ego.stops,
    stopsPlanned: plan?.stops.length ?? 0,
  };
}
