// M12 — OPT: follow the committed Plan between decisions; on a trigger, run the planner and apply the commit rule.
import type { Action, Belief, ObsHistory, Observation, Plan } from '@pitwall/shared';
import type { ModelBundle } from '../vehicle/model';
import { availableTyres, compoundFor, pitAction, stayAction, type Strategy, type StrategyContext, type StrategyOutput } from './strategy';
import { b0Plan } from './b0';
import { evaluateTriggers, newTriggerState, URGENT_TRIGGERS, type TriggerState } from '../planner/triggers';
import { B1_SOURCES, plan as runPlanner, projectLaterStops, type PlanJob, type PlanOptions } from '../planner/plan';
import { b1Decide, defaultB1Options, projectNextStop } from './b1';
import type { RivalCautionStats } from '../planner/rollout';
import { nominalBurn } from '../vehicle/fuel';
import { refuelRequest } from '../sim/pit';
import { driverStatus } from './drivers';

interface OptState {
  plan: Plan | null;
  triggers: TriggerState;
  decisionIdx: number;
  lastChangeLap: number;
  cautionStats: RivalCautionStats;
  /** per-rival "pitted during the current open-lane caution" while a caution runs */
  cautionSeen: Record<number, boolean> | null;
}

export interface OptOptions {
  /** precomputed initial plan (B0 DP); computed lazily otherwise */
  initialPlan?: Plan;
  planner?: PlanOptions;
}

export class OptStrategy implements Strategy {
  readonly id = 'OPT' as const;
  private s: OptState;

  constructor(private readonly opts: OptOptions = {}) {
    this.s = {
      plan: opts.initialPlan ? structuredClone(opts.initialPlan) : null,
      triggers: newTriggerState(),
      decisionIdx: 0,
      lastChangeLap: -100,
      cautionStats: {},
      cautionSeen: null,
    };
  }

  private updateCautionStats(obs: Observation): void {
    const s = this.s;
    if (obs.flag === 'caution' && obs.pitOpen) {
      s.cautionSeen ??= {};
      for (const r of obs.rivals) if (r.pittedThisCaution) s.cautionSeen[r.no] = true;
      for (const r of obs.rivals) s.cautionSeen[r.no] ??= false;
    } else if (obs.flag === 'green' && s.cautionSeen) {
      for (const [no, pitted] of Object.entries(s.cautionSeen)) {
        const st = (s.cautionStats[Number(no)] ??= { pitted: 0, stayed: 0 });
        if (pitted) st.pitted++;
        else st.stayed++;
      }
      s.cautionSeen = null;
    }
  }

  decide(obs: Observation, history: ObsHistory, belief: Belief | null, ctx: StrategyContext): StrategyOutput {
    const s = this.s;
    const model = ctx.model;
    s.plan ??= b0Plan(model);
    const lapNext = obs.lap + 1;
    // drop stops in the past (taken, or refused by the lane)
    s.plan.stops = s.plan.stops.filter((st) => st.lap >= lapNext);
    if (s.plan.mode && s.plan.mode.untilLap < lapNext) s.plan.mode = null;
    // a candidate's plan has one firm stop; once we have pitted, later stops follow the B1 rules (§12.2)
    if (obs.ego.lastLapFlags.inLap && s.plan.source !== 'b0_dp' && !B1_SOURCES.has(s.plan.source)) {
      s.plan = { stops: [], mode: s.plan.mode, source: 'b1_base', committedLap: obs.lap };
    }
    if (B1_SOURCES.has(s.plan.source)) this.refreshProjection(obs, model);
    this.updateCautionStats(obs);

    let decision: StrategyOutput['decision'];
    let trigger: string | undefined;
    // the in-lap observation still shows the pre-service fuel and tyres (the service lands with the out-lap), and a
    // stop on the out-lap is illegal anyway: planning on it sees a car about to run dry and buys a wasted stop
    if (obs.ego.running && !obs.ego.lastLapFlags.inLap) {
      const tr = evaluateTriggers(s.triggers, obs, belief, s.plan, model);
      if (tr.primary && belief) {
        trigger = tr.primary;
        const job: PlanJob = {
          obs,
          history: { last: history.last.slice(-10) },
          belief,
          plan: s.plan,
          model,
          config: model.cfg.planner,
          seed: { master: ctx.masterSeed, lap: obs.lap, decisionIdx: s.decisionIdx },
          trigger: tr.primary,
          cautionStats: s.cautionStats,
          lapsSinceChange: obs.lap - s.lastChangeLap,
          urgent: URGENT_TRIGGERS.has(tr.primary) || (tr.primary === 'weather' && tr.compoundCritical),
        };
        const out = runPlanner(job, this.opts.planner);
        s.decisionIdx++;
        decision = out.decision;
        if (out.decision.committed) {
          s.plan = out.plan;
          s.lastChangeLap = obs.lap;
        }
        if (B1_SOURCES.has(s.plan.source)) this.refreshProjection(obs, model);
      }
    }
    const action = B1_SOURCES.has(s.plan.source) ? this.b1Action(obs, history, model) : this.action(obs, belief, model);
    return { action, plan: s.plan, decision, trigger };
  }

  /** B1-following plan: the action is B1's, with the plan's mode applied. */
  private b1Action(obs: Observation, history: ObsHistory, model: ModelBundle): Action {
    const p = this.s.plan!;
    const lapNext = obs.lap + 1;
    const mode = p.mode && lapNext <= p.mode.untilLap ? p.mode.mode : 'normal';
    const a = b1Decide(obs, history, model, defaultB1Options(model)).action;
    return { ...a, mode };
  }

  /** Display stops for a B1-following plan: B1's projection now and the projected later stops. */
  private refreshProjection(obs: Observation, model: ModelBundle): void {
    const p = this.s.plan!;
    const want = compoundFor(obs.wetness_est);
    const next = obs.lap + 1 + projectNextStop(obs, model, defaultB1Options(model));
    p.stops = [{ lap: next, refuel: 'helper', tyres: want }, ...projectLaterStops(model, obs, next, want)];
  }

  /** The action implied by the committed plan for the next lap (§12.2). */
  private action(obs: Observation, belief: Belief | null, model: ModelBundle): Action {
    const p = this.s.plan!;
    const lapNext = obs.lap + 1;
    const mode = p.mode && lapNext <= p.mode.untilLap ? p.mode.mode : 'normal';
    // physically required compound swap (the same rule the rollouts assume between explicit stops)
    if (obs.ego.running && !obs.ego.lastLapFlags.inLap && !(obs.flag === 'caution' && !obs.pitOpen)) {
      // the same compound thresholds as B1 (wet-in at wetIn; slicks back once the track is below wetOut): the
      // planner is there to time stops better, not to gamble on slicks in the wet
      const th = model.cfg.planner.b1;
      const swapTo = obs.ego.compound === 'dry' && obs.wetness_est >= th.wetIn ? 'wet' : obs.ego.compound === 'wet' && obs.wetness_est <= th.wetOut * 0.67 ? 'dry' : null;
      if (swapTo && obs.ego.setsLeft[swapTo] > 0) {
        if (p.stops[0] && p.stops[0].lap <= lapNext + 1) p.stops.shift();
        p.mode = null;
        return pitAction(model, obs, belief?.fuel.mean ?? obs.ego.fuelGauge_kg, swapTo, 'normal');
      }
    }
    // the last safe lap for the driver change (same rule as B1): a missed minimum drive time costs the result
    if (obs.ego.running && !obs.ego.lastLapFlags.inLap && !(obs.flag === 'caution' && !obs.pitOpen) && driverStatus(obs, model).due) {
      if (p.stops[0] && p.stops[0].lap <= lapNext + 2) p.stops.shift();
      p.mode = null;
      return pitAction(model, obs, belief?.fuel.mean ?? obs.ego.fuelGauge_kg, availableTyres(obs, compoundFor(obs.wetness_est)) === obs.ego.compound && obs.ego.tyreAgeLaps < 10 ? 'none' : availableTyres(obs, compoundFor(obs.wetness_est)), 'normal');
    }
    const stop = p.stops[0];
    if (!stop || stop.lap !== lapNext || !obs.ego.running) return stayAction(mode);
    // one stop instead of two: under a caution, when the driver change is still to come and the current driver is
    // a lap or two short of their minimum, hold the stop until the change can be made in the same visit
    const drv = driverStatus(obs, model);
    const tLapNow = obs.ego.lastLap_s > 60 && obs.ego.lastLap_s < 400 ? obs.ego.lastLap_s : model.lapRef;
    if (obs.flag === 'caution' && drv.need_s > 0 && drv.ownNeed_s > 0 && drv.ownNeed_s <= 3 * tLapNow && !obs.ego.forcedPending && !drv.due) {
      const q = nominalBurn(model.cfg.car, 'normal') * (belief?.Zeff.mean ?? 1);
      if ((belief?.fuel.mean ?? obs.ego.fuelGauge_kg) > q * (model.cfg.car.fuel.reserveLaps + 2)) {
        stop.lap = lapNext + 1;
        return stayAction(mode);
      }
    }
    if (belief && this.pointless(obs, belief, model, stop.tyres)) {
      p.stops.shift();
      return stayAction(mode);
    }
    if (obs.ego.lastLapFlags.inLap || (obs.flag === 'caution' && !obs.pitOpen)) {
      // cannot pit on an out-lap or into a closed lane: postpone the stop by one lap
      stop.lap = lapNext + 1;
      return stayAction(mode);
    }
    // the compound the plan chose (a deliberate swap, e.g. wets -> slicks as the track dries, must not be overridden)
    const tyres = stop.tyres === 'none' ? 'none' : availableTyres(obs, stop.tyres);
    const fuelEst = belief?.fuel.mean ?? obs.ego.fuelGauge_kg;
    if (stop.refuel === 'helper') {
      const a = pitAction(model, obs, fuelEst, tyres, mode);
      if (belief) {
        const q = nominalBurn(model.cfg.car, 'normal') * belief.Zeff.mean;
        const tLap = obs.ego.lastLap_s > 60 && obs.ego.lastLap_s < 400 ? obs.ego.lastLap_s : model.lapRef;
        a.refuel_kg = refuelRequest(model, fuelEst, q, obs.raceTime_s + tLap, model.lapRef);
      }
      return a;
    }
    return { pit: true, refuel_kg: stop.refuel, tyres, driverChange: false, mode };
  }

  /**
   * A planned stop that buys nothing: the fuel on board already reaches the flag with the reserve, and the tyres on
   * the car stay short of the cliff (and on the right compound) until the flag. Late in a race a candidate's firm stop
   * can outlive the reason it was chosen for; this drops it instead of paying a full stop for no gain.
   */
  private pointless(obs: Observation, belief: Belief, model: ModelBundle, tyres: 'none' | 'dry' | 'wet'): boolean {
    // green-flag laps: a caution lap is slow, and counting laps left at caution pace would undercount them
    const lapsLeft = Math.ceil(Math.max(0, obs.remaining_s) / model.lapRef) + 1;
    const q = nominalBurn(model.cfg.car, 'normal') * belief.Zeff.mean;
    const fuelOk = belief.fuel.mean - 2 * belief.fuel.sd >= q * (lapsLeft + model.cfg.car.fuel.reserveLaps);
    if (!fuelOk) return false;
    if (driverStatus(obs, model).need_s > 0) return false;
    if (tyres === 'none') return true;
    if (tyres !== obs.ego.compound) return false;
    const tc = model.cfg.car.tyres[obs.ego.compound];
    const wearAtFlag = belief.W.mean + belief.W.sd + tc.kBase_per_lap * belief.Yeff.mean * lapsLeft;
    return wearAtFlag < (tc.Wcliff ?? 0.55);
  }

  getState(): unknown {
    return structuredClone(this.s);
  }
  setState(st: unknown): void {
    this.s = structuredClone(st as OptState);
  }
  currentPlan(): Plan | null {
    return this.s.plan;
  }
}
