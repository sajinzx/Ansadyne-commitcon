// M12 §12.5–12.9, §12.11 — candidates, deterministic successive halving, feasibility and fallback, metrics,
// rank stability and reasons. The work done is a pure function of the PlanJob (A04): the wall clock is only read
// through timing.ts to report latency.
import type { Belief, CandidateRow, Compound, Decision, Mode, ObsHistory, Observation, Plan, PlanStop, PlannerConfig } from '@pitwall/shared';
import type { ModelBundle } from '../vehicle/model';
import { stream, STREAM } from '../rng/rng';
import { b1Decide, defaultB1Options, projectNextStop } from '../strategy/b1';
import { compoundFor } from '../strategy/strategy';
import { nominalBurn } from '../vehicle/fuel';
import { expectedService, netPitLoss } from '../sim/pit';
import { rollout, sampleWorld, type RivalCautionStats, type RolloutPlan, type RolloutResult, type RolloutWorld } from './rollout';
import { cvar, mean, pairedCI, quantile, wilson } from '../stats';
import { nowMs } from './timing';

export interface PlanJob {
  obs: Observation;
  history: ObsHistory;
  belief: Belief;
  plan: Plan;
  model: ModelBundle;
  config: PlannerConfig;
  seed: { master: number; lap: number; decisionIdx: number };
  trigger: string;
  cautionStats: RivalCautionStats;
  /** the laps since OPT last changed its plan and whether the trigger skips the dwell (commit rule) */
  lapsSinceChange: number;
  urgent: boolean;
}

export interface PlanOptions {
  /** emulated planner pool size: candidates are partitioned across workers; results never depend on it */
  workers?: number;
  /** test hook: artificial slowdown factor (repeats each rollout, discarding the copies) */
  slowdown?: number;
}

interface Candidate {
  id: string;
  label: string;
  rollout: RolloutPlan;
  plan: Plan;
  legal: boolean;
}

const LABELS: Record<string, string> = {
  stay: 'Keep plan',
  pit_fuel: 'Pit now: fuel',
  pit_fuel_tyres: 'Pit now: fuel + tyres',
  pit_swap_compound: 'Pit now: swap compound',
  pit_in_2: 'Pit in 2 laps',
  pit_in_4: 'Pit in 4 laps',
  save_then_pit: 'Save 5 laps, then pit',
  push_to_stop: 'Push to the stop',
  b1_action: 'Rule-based (B1)',
};

/** Laps a full tank covers before the car must pit (in-lap to in-lap), from the nominal burn. */
function stintLaps(model: ModelBundle, q: number): number {
  const car = model.cfg.car;
  return Math.max(5, Math.floor((car.fuel.capacity_kg - q * (car.fuel.reserveLaps + model.lane.entryS / model.lapLength)) / q));
}

/** Projected later stops after a first commitment at `firstLap` (display and execution; re-planned by triggers). */
export function projectLaterStops(model: ModelBundle, obs: Observation, firstLap: number, firstTyres: 'none' | Compound): PlanStop[] {
  const q = nominalBurn(model.cfg.car, 'normal');
  const n = stintLaps(model, q);
  const tLap = obs.ego.lastLap_s > 60 && obs.ego.lastLap_s < 400 ? obs.ego.lastLap_s : model.lapRef;
  const flagLap = obs.lap + Math.ceil(Math.max(0, obs.remaining_s) / tLap) + 1;
  const kBase = model.cfg.car.tyres.dry.kBase_per_lap;
  const wearLapsLimit = model.cfg.planner.b1.wearLimit / kBase;
  const out: PlanStop[] = [];
  let lap = firstLap;
  let setAge = firstTyres === 'none' ? obs.ego.tyreAgeLaps + (firstLap - obs.lap) : 0;
  while (lap + n < flagLap - 1 && out.length < 12) {
    lap += n;
    setAge += n;
    const tyres = setAge + n > wearLapsLimit || setAge >= 0.5 * wearLapsLimit ? 'dry' : 'none';
    out.push({ lap, refuel: 'helper', tyres });
    if (tyres !== 'none') setAge = 0;
  }
  return out;
}

/** Sources whose stops are B1 projections (display only); OPT then follows the B1 rules. */
export const B1_SOURCES: ReadonlySet<string> = new Set(['b1_action', 'b1_base']);

/** Stops OPT will execute as written: all of B0's, a candidate's first commitment, none for B1-following plans. */
export function firmStops(p: Plan): PlanStop[] {
  if (p.source === 'b0_dp') return p.stops;
  if (B1_SOURCES.has(p.source)) return [];
  return p.stops.slice(0, 1);
}

function firstPlannedLap(job: PlanJob): number {
  const s = job.plan.stops[0];
  if (s) return s.lap;
  return job.obs.lap + 1 + projectNextStop(job.obs, job.model, defaultB1Options(job.model));
}

export function buildCandidates(job: PlanJob): Candidate[] {
  const { obs, model } = job;
  const lapNext = obs.lap + 1;
  const want = compoundFor(obs.wetness_est);
  const other: Compound = obs.ego.compound === 'dry' ? 'wet' : 'dry';
  const laneClosedNow = obs.flag === 'caution' && !obs.pitOpen;
  const outLapNext = obs.ego.lastLapFlags.inLap;
  const pitNowLegal = !laneClosedNow && !outLapNext && obs.ego.running;
  const planned = Math.max(lapNext, firstPlannedLap(job));
  const mk = (id: string, stops: PlanStop[], mode: Plan['mode'], legal: boolean): Candidate => {
    const first = stops[0];
    const plan: Plan = {
      stops: first ? [first, ...projectLaterStops(model, obs, first.lap, first.tyres)] : [],
      mode,
      source: id,
      committedLap: obs.lap,
    };
    // rollouts follow the first commitment, then the B1 base policy on the path's state (§12.6)
    const rp: RolloutPlan = { stops: stops.map((s) => ({ lap: s.lap, refuel: s.refuel, tyres: s.tyres })), mode };
    return { id, label: LABELS[id] ?? id, rollout: rp, plan, legal };
  };
  const cands: Candidate[] = [];
  // stay: the committed plan's firm stops, rolled out unchanged
  {
    const plan: Plan = { ...structuredClone(job.plan), source: job.plan.source };
    cands.push({
      id: 'stay',
      label: LABELS.stay,
      rollout: { stops: firmStops(job.plan).map((x) => ({ ...x })), mode: job.plan.mode },
      plan,
      legal: !obs.ego.forcedPending,
    });
  }
  cands.push(mk('pit_fuel', [{ lap: lapNext, refuel: 'helper', tyres: 'none' }], null, pitNowLegal));
  cands.push(mk('pit_fuel_tyres', [{ lap: lapNext, refuel: 'helper', tyres: want }], null, pitNowLegal && obs.ego.setsLeft[want] > 0));
  if (obs.wetness_est >= 0.1 || obs.rainProb.in20 >= 0.3) {
    cands.push(mk('pit_swap_compound', [{ lap: lapNext, refuel: 'helper', tyres: other }], null, pitNowLegal && obs.ego.setsLeft[other] > 0));
  }
  cands.push(mk('pit_in_2', [{ lap: obs.lap + 2, refuel: 'helper', tyres: want }], null, obs.ego.setsLeft[want] > 0));
  cands.push(mk('pit_in_4', [{ lap: obs.lap + 4, refuel: 'helper', tyres: want }], null, obs.ego.setsLeft[want] > 0));
  const saveStop = Math.max(obs.lap + 5, planned + 1);
  cands.push(mk('save_then_pit', [{ lap: saveStop, refuel: 'helper', tyres: want }], { mode: 'save' as Mode, untilLap: obs.lap + 5 }, true));
  cands.push(mk('push_to_stop', [{ lap: planned, refuel: 'helper', tyres: want }], { mode: 'push' as Mode, untilLap: planned }, true));
  // b1_action: what B1 would do now; afterwards the base policy is B1 itself
  {
    const b1 = b1Decide(obs, job.history, model, defaultB1Options(model));
    const stops: PlanStop[] = b1.action.pit ? [{ lap: lapNext, refuel: 'helper', tyres: b1.action.tyres }] : [];
    const c = mk('b1_action', stops, null, true);
    if (!b1.action.pit) {
      const next = lapNext + projectNextStop(obs, model, defaultB1Options(model));
      c.plan.stops = [{ lap: next, refuel: 'helper', tyres: want }, ...projectLaterStops(model, obs, next, want)];
    }
    cands.push(c);
  }
  return cands;
}

interface Evaluated {
  cand: Candidate;
  res: RolloutResult;
  n: number; // paths evaluated (prefix 0..n-1)
  eliminatedAt: number | null;
}

function evalPrefix(world: RolloutWorld, e: Evaluated, n: number, slowdown: number): void {
  if (n <= e.n) return;
  rollout(world, e.cand.rollout, e.n, n, e.res);
  for (let r = 1; r < slowdown; r++) {
    const scratch: RolloutResult = { pos: new Float64Array(world.N), fail: new Uint8Array(world.N) };
    rollout(world, e.cand.rollout, e.n, n, scratch);
  }
  e.n = n;
}

function hist(res: RolloutResult, n: number): number[] {
  const h = new Array(11).fill(0);
  for (let i = 0; i < n; i++) {
    const b = res.fail[i] ? 10 : Math.min(9, Math.max(0, Math.round(res.pos[i]) - 1));
    h[b]++;
  }
  return h;
}

export interface PlanOutcome {
  decision: Decision;
  /** the plan to follow after the commit rule */
  plan: Plan;
}

/** Run the planner for one job (§12.13). */
export function plan(job: PlanJob, opts: PlanOptions = {}): PlanOutcome {
  const t0 = nowMs();
  const cfg = job.config;
  const rounds = [...cfg.rounds].sort((a, b) => a - b);
  const N = rounds[rounds.length - 1];
  const lapsToFlag = Math.ceil(Math.max(0, job.obs.remaining_s) / job.model.lapRef) + 2;
  const H = Math.max(1, Math.min(cfg.horizonLaps, lapsToFlag));
  const rng = stream(job.seed.master, STREAM.planner, job.seed.lap, job.seed.decisionIdx, 0);
  const world = sampleWorld(job.obs, job.history, job.belief, job.model, rng, N, H, job.cautionStats);
  const cands = buildCandidates(job);
  const evals: Evaluated[] = cands
    .filter((c) => c.legal || c.id === 'stay' || c.id === 'b1_action')
    .map((cand) => ({ cand, res: { pos: new Float64Array(N), fail: new Uint8Array(N) }, n: 0, eliminatedAt: null }));
  const workers = Math.max(1, opts.workers ?? 1);
  const slowdown = Math.max(1, opts.slowdown ?? 1);
  const protectedIds = new Set(['stay', 'b1_action']);

  for (const n of rounds) {
    const alive = evals.filter((e) => e.eliminatedAt === null);
    // partition by candidate across (emulated) workers; each part is independent, reduce in id order
    for (let w = 0; w < workers; w++) alive.filter((_, i) => i % workers === w).forEach((e) => evalPrefix(world, e, n, slowdown));
    if (n === N) break;
    const leader = alive.reduce((a, b) => (mean(b.res.pos, n) < mean(a.res.pos, n) ? b : a));
    const leaderCvar = cvar(leader.res.pos, cfg.cvarAlpha, n);
    for (const e of alive) {
      if (e === leader || protectedIds.has(e.cand.id)) continue;
      const d = pairedCI(e.res.pos, leader.res.pos, n, 0.9);
      const margin = Math.max(cfg.elimination.seMultiplier * d.se, cfg.elimination.minGap);
      if (d.mean > margin && (cfg.lambdaRisk === 0 || cvar(e.res.pos, cfg.cvarAlpha, n) >= leaderCvar)) e.eliminatedAt = n;
    }
  }

  // ---- final metrics
  const b1 = evals.find((e) => e.cand.id === 'b1_action')!;
  const stay = evals.find((e) => e.cand.id === 'stay')!;
  const pFailOf = (e: Evaluated) => {
    let k = 0;
    for (let i = 0; i < e.n; i++) k += e.res.fail[i];
    return { k, p: k / e.n };
  };
  const stayLegal = stay.cand.legal;
  const stayFail = pFailOf(stay).p;
  const rows: (CandidateRow & { _e: Evaluated })[] = evals.map((e) => {
    const n = e.n;
    const pos = e.res.pos;
    const meanPos = mean(pos, n);
    const cv = cvar(pos, cfg.cvarAlpha, n);
    let win = 0;
    let top3 = 0;
    for (let i = 0; i < n; i++) {
      if (!e.res.fail[i] && pos[i] <= 1) win++;
      if (!e.res.fail[i] && pos[i] <= 3) top3++;
    }
    const pf = pFailOf(e);
    const d = pairedCI(pos, b1.res.pos, n, 0.9);
    const final = e.eliminatedAt === null;
    const limit = stayLegal ? Math.max(cfg.pFailLimit, stayFail) : cfg.pFailLimit;
    return {
      id: e.cand.id,
      label: e.cand.label + (final ? '' : ` (dropped at ${e.eliminatedAt})`),
      meanPos,
      medianPos: quantile(pos, 0.5, n),
      p10: quantile(pos, 0.1, n),
      p90: quantile(pos, 0.9, n),
      pWin: win / n,
      pTop3: top3 / n,
      cvar: cv,
      pFail: pf.p,
      pFailCI95: wilson(pf.k, n, 0.95),
      score: meanPos + cfg.lambdaRisk * cv,
      deltaVsB1: d.mean,
      deltaCI90: [d.lo, d.hi],
      paths: n,
      feasible: final && (e.cand.legal || e.cand.id === 'b1_action') && pf.p <= limit + 1e-12,
      _e: e,
    };
  });

  // ---- choose (feasibility §12.7)
  const finals = rows.filter((r) => r._e.eliminatedAt === null);
  let keptReason: string | undefined;
  const feasible = finals.filter((r) => r.feasible);
  let best: (typeof rows)[number];
  if (feasible.length) best = feasible.reduce((a, b) => (b.score < a.score - 1e-12 ? b : a));
  else {
    best = finals.reduce((a, b) => (b.pFail < a.pFail - 1e-12 || (b.pFail === a.pFail && b.score < a.score) ? b : a));
    keptReason = 'all candidates above the failure limit';
  }

  // ---- commit rule (§12.10)
  const stayRow = rows.find((r) => r.id === 'stay')!;
  let committed = false;
  let chosenPlan = stay.cand.plan;
  if (best.id !== 'stay') {
    const d = pairedCI(best._e.res.pos, stay.res.pos, N, cfg.commit.ciLevel);
    const gainOk = best.score <= stayRow.score - cfg.commit.minGainPositions;
    const ciOk = d.hi < 0;
    const dwellOk = job.lapsSinceChange >= cfg.commit.dwellLaps || job.urgent;
    const mustChange = !stayLegal || !stayRow.feasible;
    if (mustChange || (gainOk && ciOk && dwellOk)) {
      committed = true;
      chosenPlan = best._e.cand.plan;
    } else if (!keptReason) {
      keptReason = !gainOk ? 'kept plan — gain not significant' : !ciOk ? 'kept plan — CI includes zero' : 'kept plan — dwell (changed < 3 laps ago)';
    }
  }
  const chosenId = committed ? best.id : 'stay';
  const chosenRow = rows.find((r) => r.id === chosenId)!;

  // ---- rank stability (§12.9): top two by score, 5 extra seed sets
  const ranked = [...finals].sort((a, b) => a.score - b.score);
  let stability = 1;
  if (ranked.length >= 2) {
    const [a, b] = ranked;
    let same = 0;
    const sets = cfg.rankStability.seedSets;
    for (let s = 1; s <= sets; s++) {
      const r2 = stream(job.seed.master, STREAM.planner, job.seed.lap, job.seed.decisionIdx, s);
      const n2 = cfg.rankStability.paths;
      const w2 = sampleWorld(job.obs, job.history, job.belief, job.model, r2, n2, H, job.cautionStats);
      const ra: RolloutResult = { pos: new Float64Array(n2), fail: new Uint8Array(n2) };
      const rb: RolloutResult = { pos: new Float64Array(n2), fail: new Uint8Array(n2) };
      rollout(w2, a._e.cand.rollout, 0, n2, ra);
      rollout(w2, b._e.cand.rollout, 0, n2, rb);
      const sa = mean(ra.pos) + cfg.lambdaRisk * cvar(ra.pos, cfg.cvarAlpha);
      const sb = mean(rb.pos) + cfg.lambdaRisk * cvar(rb.pos, cfg.cvarAlpha);
      if (sa <= sb) same++;
    }
    stability = same / sets;
  }

  const elapsedMs = nowMs() - t0;
  const decision: Decision = {
    id: `OPT-${job.obs.step}-${job.seed.decisionIdx}`,
    world: 'OPT',
    step: job.obs.step,
    lap: job.obs.lap,
    trigger: job.trigger,
    candidates: rows.map(({ _e, ...r }) => r),
    chosen: chosenId,
    committed,
    keptReason: committed ? undefined : keptReason,
    plan: structuredClone(chosenPlan),
    nPaths: N,
    rounds,
    elapsedMs,
    overBudget: elapsedMs > cfg.budgetMs,
    rankStability: stability,
    reasons: reasons(job, chosenRow),
    histChosen: hist(chosenRow._e.res, chosenRow._e.n),
    histB1: hist(b1.res, b1.n),
  };
  if (keptReason === 'all candidates above the failure limit') decision.keptReason = keptReason;
  return { decision, plan: structuredClone(chosenPlan) };
}

/** Plain-language reasons (at most three) from computed numbers (§12.11). */
function reasons(job: PlanJob, chosen: CandidateRow): string[] {
  const { obs, belief, model } = job;
  const out: string[] = [];
  const svc = expectedService(model, 60, 'dry');
  if (obs.flag === 'caution') {
    const g = netPitLoss(model, svc, model.lapRef, false);
    const c = netPitLoss(model, svc, model.cfg.race.caution.paceLapFactor * model.lapRef, true);
    out.push(`Caution: net pit loss ≈ ${(g - c).toFixed(0)} s cheaper than under green`);
  }
  const q = nominalBurn(model.cfg.car, 'normal') * belief.Zeff.mean;
  const fuelLaps = belief.fuel.mean / q;
  if (fuelLaps < 12) out.push(`Fuel for ${fuelLaps.toFixed(1)} laps; next window closes lap ${obs.lap + Math.floor(fuelLaps - model.cfg.car.fuel.reserveLaps)}`);
  if (belief.W.mean > 0.3) {
    const cliff = model.cfg.car.tyres[obs.ego.compound].Wcliff ?? 0.55;
    const k = model.cfg.car.tyres[obs.ego.compound].kBase_per_lap * belief.Yeff.mean;
    const lapsTo = Math.max(0, (cliff - belief.W.mean) / Math.max(1e-6, k));
    out.push(`Tyre wear ${belief.W.mean.toFixed(2)} ± ${belief.W.sd.toFixed(2)}; cliff (${cliff.toFixed(2)}) in ≈ ${lapsTo.toFixed(0)} laps`);
  }
  if (obs.rainProb.in20 >= 0.2 || obs.wetness_est >= 0.1) {
    out.push(`Rain probability ${(obs.rainProb.in20 * 100).toFixed(0)}% within 20 laps (track ${obs.regime})`);
  }
  if (out.length < 3) out.push(`Expected position ${chosen.meanPos.toFixed(2)} (Δ vs B1 ${chosen.deltaVsB1 >= 0 ? '+' : ''}${chosen.deltaVsB1.toFixed(2)})`);
  return out.slice(0, 3);
}
