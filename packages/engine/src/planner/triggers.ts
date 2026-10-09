// M12 §12.3 — triggers from the observation and the belief only. Several firings on one lap make one decision.
import type { Belief, Observation, Plan, PlannerConfig } from '@pitwall/shared';
import type { ModelBundle } from '../vehicle/model';
import { nominalBurn } from '../vehicle/fuel';

export const TRIGGER_PRIORITY = ['caution', 'forced', 'incident', 'fuel', 'weather', 'wear', 'grip', 'rivalPit', 'scheduled'] as const;
export type TriggerId = (typeof TRIGGER_PRIORITY)[number];

/** Triggers after which the commit rule's dwell does not apply. */
export const URGENT_TRIGGERS: ReadonlySet<string> = new Set(['caution', 'forced', 'incident', 'fuel']);

export interface TriggerState {
  lastFire: Partial<Record<TriggerId, number>>;
  gripStreak: number;
  prev: Observation | null;
}

export function newTriggerState(): TriggerState {
  return { lastFire: {}, gripStreak: 0, prev: null };
}

export interface TriggerResult {
  fired: TriggerId[];
  primary: TriggerId | null;
  /** a weather firing that crosses a compound-critical wetness threshold */
  compoundCritical: boolean;
}

const crossed = (a: number, b: number, th: number) => (a < th) !== (b < th);

/** Evaluate the triggers for the decision before lap obs.lap + 1. Mutates `st`. */
export function evaluateTriggers(st: TriggerState, obs: Observation, belief: Belief | null, plan: Plan | null, model: ModelBundle): TriggerResult {
  const cfg: PlannerConfig = model.cfg.planner;
  const tc = cfg.triggers;
  const prev = st.prev;
  const lap = obs.lap;
  const fired: TriggerId[] = [];
  let compoundCritical = false;
  const cool = (id: TriggerId, laps: number) => {
    const last = st.lastFire[id];
    return last === undefined || lap - last >= laps;
  };
  const fire = (id: TriggerId) => {
    fired.push(id);
    st.lastFire[id] = lap;
  };

  // caution: starts, and again when the lane opens
  if (obs.flag === 'caution' && (!prev || prev.flag !== 'caution')) fire('caution');
  else if (obs.flag === 'caution' && obs.pitOpen && prev && !prev.pitOpen) fire('caution');

  if (obs.ego.forcedPending) fire('forced');
  if (obs.ego.lastLapFlags.incident) fire('incident');

  // fuel: projected fuel at the planned stop's pit entry below the reserve
  if (belief && cool('fuel', tc.fuelCooldown)) {
    const q = nominalBurn(model.cfg.car, 'normal') * belief.Zeff.mean;
    const entryFrac = model.lane.entryS / model.lapLength;
    const tLapF = obs.ego.lastLap_s > 60 && obs.ego.lastLap_s < 400 ? obs.ego.lastLap_s : model.lapRef;
    const flagLap = lap + Math.ceil(Math.max(0, obs.remaining_s) / tLapF) + 1;
    // a projected stop after the flag is no stop at all: judge the fuel against the finish instead
    const planned0 = plan?.stops[0]?.lap;
    const planned = planned0 !== undefined && planned0 < flagLap ? planned0 : undefined;
    if (planned !== undefined) {
      const lapsBefore = Math.max(0, planned - lap - 1);
      const atEntry = belief.fuel.mean - q * (lapsBefore + entryFrac);
      if (atEntry < tc.fuelReserveLaps * q) fire('fuel');
    } else {
      const tLap = obs.ego.lastLap_s > 60 && obs.ego.lastLap_s < 400 ? obs.ego.lastLap_s : model.lapRef;
      const lapsToGo = Math.ceil(Math.max(0, obs.remaining_s) / tLap) + 1;
      if (belief.fuel.mean < q * lapsToGo && belief.fuel.mean - q * (1 + entryFrac) < tc.fuelReserveLaps * q * 2) fire('fuel');
    }
  }

  // weather (B04): rain probability crossing either way, or wetness crossing 0.15 / 0.30
  // wetness crossings are compound-critical and are not held back by the cooldown
  if (prev) {
    const rainX = crossed(prev.rainProb.in20, obs.rainProb.in20, tc.rainProbThreshold) && cool('weather', tc.weatherCooldown);
    const w15 = crossed(prev.wetness_est, obs.wetness_est, 0.15);
    const w30 = crossed(prev.wetness_est, obs.wetness_est, 0.3);
    if (rainX || w15 || w30) {
      fire('weather');
      compoundCritical = w30 || w15;
    }
  }

  // wear: posterior wear high and the wear rate clearly above nominal
  if (belief && cool('wear', tc.wearCooldown) && belief.W.mean > 0.45 && belief.Yeff.mean > 1 + 2 * belief.Yeff.sd) fire('wear');

  // grip: |z| > gripZ on consecutive updated laps
  if (belief?.updated) {
    st.gripStreak = Math.abs(belief.lastInnovationZ) > tc.gripZ ? st.gripStreak + 1 : 0;
  }
  if (st.gripStreak >= tc.gripConsecutive && cool('grip', tc.gripCooldown)) {
    fire('grip');
    st.gripStreak = 0;
  }

  // rival pit: an in-class rival within ±window pitted on the last lap
  if (prev && cool('rivalPit', tc.rivalCooldown)) {
    const hit = obs.rivals.some((r) => {
      const p = prev.rivals.find((x) => x.no === r.no);
      return r.running && p && r.stops > p.stops && Math.abs(r.gap_s) <= tc.rivalWindow_s;
    });
    if (hit) fire('rivalPit');
  }

  // scheduled: every N laps and a few laps before the planned stop
  const planned = plan?.stops[0]?.lap;
  if ((lap > 0 && lap % tc.scheduledEvery === 0) || (planned !== undefined && planned - lap === tc.preStopLaps)) fire('scheduled');

  st.prev = obs;
  const primary = TRIGGER_PRIORITY.find((t) => fired.includes(t)) ?? null;
  return { fired, primary, compoundCritical };
}
