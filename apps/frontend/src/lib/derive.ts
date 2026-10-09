// Pure derivations from the stream (tested against a recorded fixture).
import type { CarLapRecord, Decision, LapEvent, Plan, RaceEvent, StrategyId } from '@pitwall/shared';

export interface PosPoint {
  lap: number;
  pos: number;
  pit: boolean;
  forced: boolean;
  dnf: boolean;
}

export function egoRecord(le: LapEvent, ego: number): CarLapRecord | undefined {
  return le.cars.find((c) => c.no === ego);
}

export function positionSeries(laps: LapEvent[], ego: number): PosPoint[] {
  const out: PosPoint[] = [];
  for (const le of laps) {
    const r = egoRecord(le, ego);
    if (!r || r.lap <= 0) continue;
    out.push({ lap: r.lap, pos: r.position, pit: r.pit?.phase === 'in', forced: !!r.pit?.forced?.length, dnf: !r.running && !r.classified });
  }
  return out;
}

export interface Band {
  from: number;
  to: number;
}

/** Caution periods in our car's laps (a lap counts when its flag is caution or mixed). */
export function cautionBands(laps: LapEvent[], ego: number): Band[] {
  const bands: Band[] = [];
  for (const le of laps) {
    const r = egoRecord(le, ego);
    if (!r || r.lap <= 0) continue;
    const c = r.flag !== 'green';
    const last = bands[bands.length - 1];
    if (c) {
      if (last && last.to === r.lap - 1) last.to = r.lap;
      else bands.push({ from: r.lap, to: r.lap });
    }
  }
  return bands;
}

export interface StintBar {
  from: number; // first lap of the stint
  to: number; // last lap (in-lap or current lap)
  compound: 'dry' | 'wet';
  done: boolean;
  planned: boolean;
}

export function stints(laps: LapEvent[], ego: number, plan: Plan | null | undefined, expectedLaps: number): StintBar[] {
  const out: StintBar[] = [];
  let start = 1;
  let compound: 'dry' | 'wet' = 'dry';
  let lastLap = 0;
  let running = true;
  for (const le of laps) {
    const r = egoRecord(le, ego);
    if (!r || r.lap <= 0) continue;
    if (r.lap === start) compound = r.compound;
    lastLap = r.lap;
    running = r.running && !r.classified;
    if (r.pit?.phase === 'in') {
      out.push({ from: start, to: r.lap, compound, done: true, planned: false });
      start = r.lap + 1;
    }
  }
  if (lastLap >= start) out.push({ from: start, to: lastLap, compound, done: !running, planned: false });
  if (running && plan) {
    let from = Math.max(start, lastLap + 1);
    const stops = plan.stops.filter((s) => s.lap >= from).sort((a, b) => a.lap - b.lap);
    let first = true;
    for (const s of stops) {
      if (first) {
        out.push({ from: lastLap + 1, to: s.lap, compound, done: false, planned: true });
        first = false;
      } else out.push({ from, to: s.lap, compound: s.tyres === 'wet' ? 'wet' : 'dry', done: false, planned: true });
      from = s.lap + 1;
    }
    if (from <= expectedLaps) out.push({ from, to: expectedLaps, compound, done: false, planned: true });
  }
  return out;
}

export interface AuditEntry {
  key: string;
  lap: number;
  step: number;
  text: string;
  delta?: number;
  decisionId?: string;
  kind: 'decision' | 'event' | 'start';
}

const CANDIDATE_TEXT: Record<string, string> = {
  stay: 'keep plan',
  pit_fuel: 'pit now, fuel only',
  pit_fuel_tyres: 'pit now, fuel + 4 tyres',
  pit_swap_compound: 'pit now, swap compound',
  pit_in_2: 'pit in 2 laps',
  pit_in_4: 'pit in 4 laps',
  save_then_pit: 'save 5 laps, then pit',
  push_to_stop: 'push to the stop',
  b1_action: 'follow the B1 rules',
};

export const candidateText = (id: string) => CANDIDATE_TEXT[id] ?? id;

export function auditEntries(decisions: Decision[], events: { step: number; ev: RaceEvent }[], world: StrategyId, ego: number, seedText: string): AuditEntry[] {
  const out: AuditEntry[] = [{ key: 'start', lap: 0, step: -1, text: `run start · seed ${seedText}`, kind: 'start' }];
  for (const d of decisions) {
    const row = d.candidates.find((c) => c.id === d.chosen);
    const text = d.committed
      ? `${d.trigger} → OPT chose ${candidateText(d.chosen)}`
      : `${d.trigger} → kept plan${d.keptReason ? ` (${d.keptReason.replace(/^kept plan — /, '')})` : ''}`;
    out.push({ key: d.id, lap: d.lap, step: d.step, text, delta: row?.deltaVsB1, decisionId: d.id, kind: 'decision' });
  }
  for (const { step, ev } of events) {
    if ('world' in ev && ev.world !== world) continue;
    if (ev.type === 'pit' && ev.car === ego && ev.refused) out.push({ key: `r${step}`, lap: step, step, text: `pit refused: ${ev.refused}`, kind: 'event' });
    if (ev.type === 'pit' && ev.car === ego && ev.forced) out.push({ key: `f${step}`, lap: step + 1, step, text: 'forced stop (engine)', kind: 'event' });
    if (ev.type === 'caution_start') out.push({ key: `c${step}`, lap: step + 1, step, text: `caution (${ev.cause})`, kind: 'event' });
    if (ev.type === 'injected') out.push({ key: `i${step}${ev.injection.kind}`, lap: step + 1, step, text: `injected ${ev.injection.kind} (all worlds)`, kind: 'event' });
    if ((ev.type === 'incident' || ev.type === 'failure' || ev.type === 'puncture') && ev.car === ego) out.push({ key: `x${step}${ev.type}`, lap: step + 1, step, text: `${ev.type}: ${ev.outcome}`, kind: 'event' });
  }
  return out.sort((a, b) => b.step - a.step || (a.kind === 'decision' ? -1 : 1));
}
