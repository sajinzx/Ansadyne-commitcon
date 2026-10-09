// Per-world lap records, events, decisions and projections from the stream.
import { create } from 'zustand';
import type { RadioMessage, CarLapRecord, Decision, ForkResult, LapEvent, Projection, RaceEvent, RunInfo, RunInit, RunState, RunSummary, StrategyId, StreamMessage } from '@pitwall/shared';

export const WORLDS: StrategyId[] = ['OPT', 'B1', 'B0'];
const emptyWorlds = <T>(f: () => T): Record<StrategyId, T> => ({ B0: f(), B1: f(), OPT: f() });

export interface ForkLine extends ForkResult {
  world: StrategyId;
  fromStep: number;
  label: string;
}

export interface RaceData {
  runId: string | null;
  info: RunInfo | null;
  init: RunInit | null;
  state: RunState | 'none';
  laps: Record<StrategyId, LapEvent[]>;
  recs: Record<StrategyId, Record<number, CarLapRecord[]>>;
  decisions: Decision[];
  radio: RadioMessage[];
  projections: Record<StrategyId, Projection | null>;
  events: { step: number; ev: RaceEvent }[];
  warnings: { code: string; detail: string }[];
  summary: RunSummary | null;
  lastSeq: number;
  forks: ForkLine[];
  /** time up to which every world's laps are known (display clock never passes it) */
  available_s: number;
}

interface RaceActions {
  reset(info: RunInfo | null): void;
  ingest(m: StreamMessage): void;
  ingestMany(ms: StreamMessage[]): void;
  addFork(f: ForkLine): void;
  setInfo(info: RunInfo): void;
}

export const initialRace = (): RaceData => ({
  runId: null,
  info: null,
  init: null,
  state: 'none',
  laps: emptyWorlds(() => []),
  recs: emptyWorlds(() => ({})),
  decisions: [],
  radio: [],
  projections: emptyWorlds(() => null),
  events: [],
  warnings: [],
  summary: null,
  lastSeq: -1,
  forks: [],
  available_s: 0,
});

/** Earliest lap end among the latest records of every world (the frontier of known positions). */
function availableTime(laps: Record<StrategyId, LapEvent[]>): number {
  let t = Infinity;
  for (const w of WORLDS) {
    const last = laps[w][laps[w].length - 1];
    if (!last) return 0;
    for (const c of last.cars) if (c.running || c.classified) t = Math.min(t, c.lapStart_s + c.lapTime_s);
  }
  return Number.isFinite(t) ? t : 0;
}

/** Apply one message to a mutable draft (shared by single and batch ingest). */
function apply(d: RaceData, m: StreamMessage): void {
  if (m.seq <= d.lastSeq) return;
  d.lastSeq = m.seq;
  switch (m.type) {
    case 'run_meta': {
      const info = m.payload as RunInfo;
      d.info = info;
      d.init = info.init ?? d.init;
      d.state = info.state;
      break;
    }
    case 'lap': {
      const le = m.payload as LapEvent;
      d.laps[le.world].push(le);
      const byCar = d.recs[le.world];
      for (const c of le.cars) (byCar[c.no] ??= []).push(c);
      break;
    }
    case 'decision':
      d.decisions.push(m.payload as Decision);
      break;
    case 'radio':
      d.radio.push(m.payload as RadioMessage);
      break;
    case 'projection': {
      const p = m.payload as Projection;
      d.projections[p.world] = p;
      break;
    }
    case 'event': {
      const ev = m.payload as RaceEvent;
      d.events.push({ step: 'step' in ev && typeof ev.step === 'number' ? ev.step : 'injection' in ev ? ev.injection.step : 0, ev });
      break;
    }
    case 'warning':
      d.warnings.push(m.payload as { code: string; detail: string });
      break;
    case 'state':
      d.state = (m.payload as { state: RunState }).state;
      break;
    case 'run_end':
      d.summary = m.payload as RunSummary;
      d.state = 'finished';
      break;
  }
}

export const useRace = create<RaceData & RaceActions>((set, get) => ({
  ...initialRace(),
  reset: (info) => set({ ...initialRace(), runId: info?.runId ?? null, info, init: info?.init ?? null, state: info?.state ?? 'none' }),
  setInfo: (info) => set({ info, state: info.state }),
  ingest: (m) => get().ingestMany([m]),
  ingestMany: (ms) => {
    const s = get();
    const d: RaceData = {
      ...s,
      laps: { B0: [...s.laps.B0], B1: [...s.laps.B1], OPT: [...s.laps.OPT] },
      recs: { B0: { ...s.recs.B0 }, B1: { ...s.recs.B1 }, OPT: { ...s.recs.OPT } },
      decisions: [...s.decisions],
      radio: [...s.radio],
      projections: { ...s.projections },
      events: [...s.events],
      warnings: [...s.warnings],
    };
    for (const w of WORLDS) for (const k of Object.keys(d.recs[w])) d.recs[w][Number(k)] = [...d.recs[w][Number(k)]];
    for (const m of ms) apply(d, m);
    d.available_s = d.state === 'finished' ? Infinity : availableTime(d.laps);
    if (d.state === 'finished') d.available_s = Math.max(...WORLDS.flatMap((w) => d.laps[w].slice(-1).flatMap((le) => le.cars.map((c) => c.lapStart_s + c.lapTime_s))), 0);
    set(d);
  },
  addFork: (f) => set({ forks: [...get().forks, f] }),
}));
