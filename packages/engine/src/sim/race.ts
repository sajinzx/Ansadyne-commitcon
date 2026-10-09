// M08 §8.1 — three paired worlds (B0, B1, OPT) in lockstep on shared pre-draws and environment.
import type {
  Belief,
  CarLapRecord,
  Configs,
  Decision,
  Injection,
  InjectionKind,
  LapEvent,
  ObsHistory,
  Observation,
  Plan,
  RaceEvent,
  RunConfig,
  SegmentOverride,
  StrategyId,
} from '@pitwall/shared';
import { STRATEGIES } from '@pitwall/shared';
import { assembleModel, buildModel, type ModelBundle } from '../vehicle/model';
import { Surrogate } from '../vehicle/surrogate';
import { predraw, predrawSizes, type Predraw } from '../rng/predraw';
import { EnvTimeline } from '../world/weather';
import { ClipCounter } from '../stochastic/ou';
import { initWorld, type WorldTruth } from './world';
import { stepWorld, cautionAt, laneOpenAt } from './step';
import { observe } from './observer';
import { makeRivalPolicy, type RivalPolicy } from '../strategy/rivals';
import type { Strategy, StrategyOutput } from '../strategy/strategy';
import { applyFamily, type FamilyEffects } from '../bench/families';
import type { OracleTruth } from '../estimator/oracle';

export interface EstimatorLike {
  belief(): Belief;
  update(obs: Observation): Belief;
  getState(): unknown;
  setState(s: unknown): void;
}

export interface RaceOptions {
  run: RunConfig;
  configs: Configs;
  strategies: Record<StrategyId, Strategy>;
  /** optional prebuilt model (shares calibration and surrogate across races) */
  model?: ModelBundle;
  estimatorFactory?: (model: ModelBundle) => EstimatorLike;
  keepSnapshots?: boolean;
  /** benchmark family id (F1…F10, F10-adv) */
  family?: string;
  /** called when the model must be rebuilt for new segment overrides (cache hook) */
  surrogateFor?: (overrides: SegmentOverride[]) => Surrogate;
  /** bench-only (M13 experiment 4): inject the truth into estimators that support it */
  oracleBelief?: boolean;
  /** test hook applied to the pre-draws (e.g. zeroNoise) */
  predrawTransform?: (pd: Predraw) => Predraw;
}

export interface StepOutput {
  step: number;
  laps: LapEvent[];
  decisions: Decision[];
  triggers: { world: StrategyId; trigger: string }[];
  events: RaceEvent[];
}

interface Snapshot {
  k: number;
  worlds: string;
  strategies: unknown[];
  estimators: unknown[];
  histories: string;
  forced: [number, number][];
  overrides: SegmentOverride[];
}

export class Race {
  model: ModelBundle;
  readonly pd: Predraw;
  readonly env: EnvTimeline;
  readonly worlds: WorldTruth[];
  readonly strategies: Strategy[];
  readonly estimators: (EstimatorLike | null)[];
  readonly histories: ObsHistory[];
  readonly rivals: Map<number, RivalPolicy>[];
  readonly rivalHistories: Map<number, ObsHistory>[];
  readonly egoNo: number;
  readonly clips = new ClipCounter();
  readonly injections: Injection[] = [];
  readonly family: FamilyEffects | null;
  readonly snapshots: Snapshot[] = [];
  k = 0;
  decisionCount = 0;
  private pendingInjections: Injection[] = [];
  private forcedCautionStep: number | null = null;
  private forcedCautionPerWorld: (number | null)[] = [null, null, null];
  private lastObs: (Observation | null)[] = [null, null, null];
  private plans: (Plan | null)[] = [null, null, null];

  constructor(readonly opts: RaceOptions) {
    const { run, configs } = opts;
    this.model = opts.model ?? buildModel(configs, run);
    this.family = opts.family ? applyFamily(opts.family, this.model) : null;
    if (this.family?.model) this.model = this.family.model;
    const field = this.model.cfg.field.cars;
    this.egoNo = this.model.cfg.field.ego;
    const sizes = predrawSizes(this.model.cfg.race.duration_s, this.model.lapRef, field.length);
    this.pd = predraw(run.masterSeed, sizes);
    if (opts.predrawTransform) this.pd = opts.predrawTransform(this.pd);
    this.env = new EnvTimeline(this.pd, this.model.weatherMatrix, this.model.lapRef, this.model.cfg.race.startClock, {
      fixedDry: this.family?.fixedDry ?? false,
      trackTempOffset: this.family?.trackTempOffset ?? 0,
    });
    if (this.family?.rainOnset) {
      const J = this.pd.sizes.J;
      const j0 = Math.round((0.3 + 0.4 * this.pd.familyU.get(0)) * J * 0.9);
      this.env.forcing.forced.set(j0, 1);
      this.env.forcing.forced.set(j0 + 1, 1);
      this.env.force(j0 + 2, 2, 20);
    }
    this.worlds = STRATEGIES.map((id) => initWorld(id, this.model, this.pd, field, this.egoNo, run.egoGridSlot));
    this.strategies = STRATEGIES.map((id) => opts.strategies[id]);
    this.estimators = STRATEGIES.map(() => (opts.estimatorFactory ? opts.estimatorFactory(this.model) : null));
    this.histories = STRATEGIES.map(() => ({ last: [] }));
    this.rivals = STRATEGIES.map(() => {
      const m = new Map<number, RivalPolicy>();
      field.forEach((fc, idx) => {
        if (fc.no === this.egoNo) return;
        const u = Array.from({ length: 8 }, (_, i) => this.pd.rivalPolicyU.get(idx, i));
        m.set(fc.no, makeRivalPolicy(fc.archetype, this.model, u));
      });
      return m;
    });
    this.rivalHistories = STRATEGIES.map(() => new Map(field.filter((c) => c.no !== this.egoNo).map((c) => [c.no, { last: [] }])));
  }

  get finished(): boolean {
    return this.worlds.every((w) => w.finished);
  }

  world(id: StrategyId): WorldTruth {
    return this.worlds[STRATEGIES.indexOf(id)];
  }

  /** Queue an injection; applied at the next uncomputed step, identically in all worlds. */
  inject(kind: InjectionKind, params?: { segmentId?: string }): Injection {
    const inj: Injection = { kind, step: this.k, params };
    this.pendingInjections.push(inj);
    return inj;
  }

  maxComputedTime(): number {
    let t = 0;
    for (const w of this.worlds) for (const c of w.cars) t = Math.max(t, c.lapStart_s);
    return t;
  }

  private applyInjections(): { caution: boolean; events: RaceEvent[] } {
    const events: RaceEvent[] = [];
    let caution = false;
    for (const inj of this.pendingInjections) {
      inj.step = this.k;
      this.injections.push(inj);
      events.push({ type: 'injected', injection: inj });
      const tick = this.env.tickAt(this.maxComputedTime()) + 1;
      switch (inj.kind) {
        case 'caution':
          caution = true;
          break;
        case 'rain':
          this.env.force(tick, 2, 15);
          break;
        case 'fuelSpike':
          for (const w of this.worlds) {
            const ego = w.cars.find((c) => c.no === this.egoNo)!;
            ego.fuelSpikeLaps = 5;
          }
          break;
        case 'debris': {
          const seg = inj.params?.segmentId ?? 'S08';
          const ovs = this.model.overrides.filter((o) => o.segmentId !== seg);
          ovs.push({ segmentId: seg, debris: true, untilTick: tick + 10 });
          this.setOverrides(ovs);
          break;
        }
      }
    }
    this.pendingInjections = [];
    return { caution, events };
  }

  /** Replace segment overrides (rebuilds the surrogate's node part). */
  setOverrides(overrides: SegmentOverride[]): void {
    const m = this.model;
    const surrogate = this.opts.surrogateFor
      ? this.opts.surrogateFor(overrides)
      : Surrogate.build(m.geo, m.cfg.car, m.cal.muPeak, m.cal.power_kW, overrides, m.cfg.track);
    const next = assembleModel(m.cfg, this.opts.run, m.geo, m.cal, surrogate, overrides);
    next.coeffSpread = m.coeffSpread;
    next.multipliers = m.multipliers;
    next.weatherMatrix = m.weatherMatrix;
    this.model = next;
  }

  private expireOverrides(): void {
    const tick = this.env.tickAt(this.maxComputedTime());
    const live = this.model.overrides.filter((o) => o.untilTick === undefined || o.untilTick > tick);
    if (live.length !== this.model.overrides.length) this.setOverrides(live);
  }

  private observation(wi: number): Observation {
    const w = this.worlds[wi];
    const ego = w.cars.find((c) => c.no === this.egoNo)!;
    return observe(w, ego, this.k, this.model, this.pd, this.env);
  }

  /** Advance every world one step. */
  step(): StepOutput {
    const k = this.k;
    const out: StepOutput = { step: k, laps: [], decisions: [], triggers: [], events: [] };
    if (this.finished) return out;
    if (this.opts.keepSnapshots) this.takeSnapshot();
    this.expireOverrides();
    const inj = this.applyInjections();
    out.events.push(...inj.events);

    // a paired family caution waits until no world is already under caution, so it starts in all of them
    const famPostponed = this.forcedCautionStep === k && this.worlds.some((w) => !w.finished && w.caution !== null && w.caution.t_end === null);
    if (famPostponed) this.forcedCautionStep = k + 1;
    for (let wi = 0; wi < 3; wi++) {
      const w = this.worlds[wi];
      if (w.finished) continue;
      const actions = new Map<number, import('@pitwall/shared').Action>();
      // our car
      const ego = w.cars.find((c) => c.no === this.egoNo)!;
      if (ego.running && !ego.classified) {
        const obs = this.lastObs[wi] ?? this.observation(wi);
        const belief = this.estimators[wi]?.belief() ?? null;
        const res: StrategyOutput = this.strategies[wi].decide(obs, this.histories[wi], belief, {
          model: this.model,
          masterSeed: this.opts.run.masterSeed,
          decisionIdx: 0,
        });
        actions.set(this.egoNo, res.action);
        this.plans[wi] = res.plan ?? this.strategies[wi].currentPlan();
        if (res.decision) {
          out.decisions.push(res.decision);
          this.decisionCount++;
        }
        if (res.trigger) {
          out.triggers.push({ world: w.id, trigger: res.trigger });
          out.events.push({ type: 'trigger', world: w.id, trigger: res.trigger, step: k });
        }
      }
      // rivals (each sees its own observation)
      for (const car of w.cars) {
        if (car.no === this.egoNo || !car.running || car.classified) continue;
        const robs = observe(w, car, k, this.model, this.pd, this.env);
        const hist = this.rivalHistories[wi].get(car.no)!;
        actions.set(car.no, this.rivals[wi].get(car.no)!.decide(robs, hist));
        hist.last.push(robs);
        if (hist.last.length > 10) hist.last.shift();
      }
      const forced = (this.forcedCautionStep === k && !famPostponed) || this.forcedCautionPerWorld[wi] === k;
      const res = stepWorld(w, {
        model: this.model,
        pd: this.pd,
        env: this.env,
        k,
        actions,
        egoNo: this.egoNo,
        injectedCaution: inj.caution,
        forcedCautionStep: forced,
        clips: this.clips,
      });
      out.events.push(...res.events);
      // observation, history and belief after the lap
      if (ego.running || ego.classified) {
        const obs = this.observation(wi);
        const prev = this.lastObs[wi];
        if (prev) {
          this.histories[wi].last.push(prev);
          if (this.histories[wi].last.length > 10) this.histories[wi].last.shift();
        }
        this.lastObs[wi] = obs;
        this.estimators[wi]?.update(obs);
        const est = this.estimators[wi] as (EstimatorLike & { inject?: (t: OracleTruth) => void }) | null;
        if (this.opts.oracleBelief && est?.inject) {
          est.inject({ fuel: ego.fuel_kg, lnX: ego.lnX, lnY: ego.lnY, bY: ego.coeff.bY, wear: ego.wear, lnZ: ego.lnZ, bZ: ego.coeff.bZ });
        }
      }
      out.laps.push(this.lapEvent(wi, res.records, res.events));
    }
    this.scheduleFamilyCautions(k);
    this.k++;
    return out;
  }

  private scheduleFamilyCautions(k: number): void {
    const f = this.family;
    if (!f) return;
    const b1 = this.world('B1');
    if (f.cautionAtFraction !== undefined && this.forcedCautionStep === null) {
      const running = b1.cars.filter((c) => c.running && !c.classified);
      const wlo = Math.max(...running.map((c) => c.lapStart_s));
      if (wlo >= f.cautionAtFraction * this.model.cfg.race.duration_s) this.forcedCautionStep = k + 1;
    }
    if (f.cautionAfterFirstStop === 'B1' && this.forcedCautionStep === null) {
      const ego = b1.cars.find((c) => c.no === this.egoNo)!;
      if (ego.stops >= 1) this.forcedCautionStep = k + 1;
    }
    if (f.cautionAfterFirstStop === 'own') {
      this.worlds.forEach((w, wi) => {
        const ego = w.cars.find((c) => c.no === this.egoNo)!;
        if (this.forcedCautionPerWorld[wi] === null && ego.stops >= 1) this.forcedCautionPerWorld[wi] = k + 1;
      });
    }
  }

  private lapEvent(wi: number, records: CarLapRecord[], events: RaceEvent[]): LapEvent {
    const w = this.worlds[wi];
    const ego = w.cars.find((c) => c.no === this.egoNo)!;
    const t = Math.max(...w.cars.map((c) => (c.running || c.classified ? c.lapStart_s : 0)));
    const e = this.env.at(ego.lapStart_s);
    const rp = this.env.rainProb(e.regimeIdx);
    const cs = w.caution;
    const caution = cautionAt(cs, ego.lapStart_s);
    for (const rec of records) {
      if (rec.no !== this.egoNo) continue;
      const belief = this.estimators[wi]?.belief();
      rec.ego = {
        belief: belief ?? (null as unknown as Belief),
        truth: {
          fuel_kg: ego.fuel_kg,
          wear: ego.wear,
          X: Math.exp(ego.lnX),
          Yeff: Math.exp(ego.coeff.bY + ego.lnY),
          Zeff: Math.exp(ego.coeff.bZ + ego.lnZ),
          tyreTemp_C: ego.tyreTemp_C,
        },
        plan: this.plans[wi],
      };
    }
    return {
      world: w.id,
      step: this.k,
      clock: this.env.clock(ego.lapStart_s),
      raceTime_s: t,
      env: {
        tick: e.tick,
        regime: e.regime,
        wetness: e.w,
        trackTemp_C: e.trackTemp,
        airTemp_C: e.airTemp,
        rubber: e.rubber,
        rainProb: { in10: rp.in10, in20: rp.in20, in40: rp.in40 },
        night: e.night,
      },
      caution: {
        active: caution,
        lapsElapsed: cs && caution ? cs.leaderCrossings : 0,
        lapsLeft: cs && caution ? Math.max(0, cs.durationLaps - cs.leaderCrossings) : null,
        pitOpen: laneOpenAt(cs, ego.lapStart_s),
        startTime_s: cs ? cs.t_c : null,
      },
      cars: records,
      events,
    };
  }

  runToEnd(maxSteps = 10_000): StepOutput[] {
    const outs: StepOutput[] = [];
    while (!this.finished && this.k < maxSteps) outs.push(this.step());
    return outs;
  }

  /** Final classification of our car per world. */
  results(): Record<StrategyId, { finalPos: number; laps: number; stops: number; dnf?: string }> {
    const r = {} as Record<StrategyId, { finalPos: number; laps: number; stops: number; dnf?: string }>;
    for (const w of this.worlds) {
      const ego = w.cars.find((c) => c.no === this.egoNo)!;
      r[w.id] = { finalPos: ego.position, laps: ego.laps, stops: ego.stops, dnf: ego.dnf?.cause };
    }
    return r;
  }

  /** What a strategy in world `id` sees now: last observation, history, belief and plan (no truth). */
  worldContext(id: StrategyId): { obs: Observation; history: ObsHistory; belief: Belief | null; plan: Plan | null } | null {
    const wi = STRATEGIES.indexOf(id);
    const obs = this.lastObs[wi];
    if (!obs) return null;
    return { obs, history: this.histories[wi], belief: this.estimators[wi]?.belief() ?? null, plan: this.plans[wi] };
  }

  plan(id: StrategyId): Plan | null {
    return this.plans[STRATEGIES.indexOf(id)];
  }

  // ---------------------------------------------------------------- snapshots (forks)
  private takeSnapshot(): void {
    this.snapshots.push({
      k: this.k,
      worlds: JSON.stringify(this.worlds),
      strategies: this.strategies.map((s) => structuredClone(s.getState())),
      estimators: this.estimators.map((e) => (e ? structuredClone(e.getState()) : null)),
      histories: JSON.stringify({
        h: this.histories,
        o: this.lastObs,
        p: this.plans,
        r: this.rivalHistories.map((m) => [...m.entries()]),
        fc: [this.forcedCautionStep, this.forcedCautionPerWorld],
      }),
      forced: [...this.env.forcing.forced.entries()],
      overrides: structuredClone(this.model.overrides),
    });
    if (this.snapshots.length > 200) this.snapshots.shift();
  }

  /** Restore the race to the state before step `k` (requires keepSnapshots). */
  restore(k: number): void {
    const snap = this.snapshots.find((s) => s.k === k);
    if (!snap) throw new Error(`no snapshot for step ${k}`);
    const worlds = JSON.parse(snap.worlds) as WorldTruth[];
    worlds.forEach((w, i) => Object.assign(this.worlds[i], w));
    snap.strategies.forEach((s, i) => this.strategies[i].setState(structuredClone(s)));
    snap.estimators.forEach((s, i) => s && this.estimators[i]?.setState(structuredClone(s)));
    const h = JSON.parse(snap.histories) as {
      h: ObsHistory[];
      o: (Observation | null)[];
      p: (Plan | null)[];
      r: [number, ObsHistory][][];
      fc: [number | null, (number | null)[]];
    };
    h.h.forEach((x, i) => (this.histories[i].last = x.last));
    this.lastObs = h.o;
    this.plans = h.p;
    h.r.forEach((entries, i) => entries.forEach(([no, hist]) => (this.rivalHistories[i].get(no)!.last = hist.last)));
    this.forcedCautionStep = h.fc[0];
    this.forcedCautionPerWorld = h.fc[1];
    this.env.forcing.forced = new Map(snap.forced);
    this.env.recomputeFrom(0);
    if (JSON.stringify(snap.overrides) !== JSON.stringify(this.model.overrides)) this.setOverrides(snap.overrides);
    this.k = k;
    this.snapshots.splice(this.snapshots.findIndex((s) => s.k === k));
  }
}
