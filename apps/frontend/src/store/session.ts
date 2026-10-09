// Run session: creates runs, connects the stream, drives the display clock and sends commands.
import type { ForkRequest, InjectionKind, InjectionParams, RunConfig, StreamMessage } from '@pitwall/shared';
import { defaultRunConfig } from '@pitwall/shared';
import { api, ApiError } from '../api/client';
import { openStream, type StreamHandle } from '../api/stream';
import { useRace } from './raceStore';
import { useUi } from './uiStore';
import { create } from 'zustand';

interface SessionState {
  config: RunConfig;
  creating: boolean;
  error: string | null;
  fieldErrors: Record<string, string>;
  connection: 'open' | 'closed' | 'stale' | 'none';
  setConfig(patch: Partial<RunConfig>): void;
  setOverrides(patch: Partial<RunConfig['overrides']>): void;
}

export const useSession = create<SessionState>((set, get) => ({
  config: defaultRunConfig(),
  creating: false,
  error: null,
  fieldErrors: {},
  connection: 'none',
  setConfig: (patch) => set({ config: { ...get().config, ...patch } }),
  setOverrides: (patch) => set({ config: { ...get().config, overrides: { ...get().config.overrides, ...patch } } }),
}));

let stream: StreamHandle | null = null;
let raf = 0;
let buffer: StreamMessage[] = [];
let flushScheduled = false;

function flush() {
  flushScheduled = false;
  const ms = buffer;
  buffer = [];
  if (ms.length) useRace.getState().ingestMany(ms);
}

function onMessage(m: StreamMessage) {
  buffer.push(m);
  if (!flushScheduled) {
    flushScheduled = true;
    setTimeout(flush, 50);
  }
}

function problemToFields(err: unknown): Record<string, string> {
  if (err instanceof ApiError && err.problem.errors) return Object.fromEntries(err.problem.errors.map((e) => [e.path, e.message]));
  return {};
}

export async function createRun(): Promise<void> {
  const s = useSession.getState();
  useSession.setState({ creating: true, error: null, fieldErrors: {} });
  try {
    const old = useRace.getState().runId;
    stream?.close();
    if (old) void api.deleteRun(old).catch(() => undefined);
    const info = await api.createRun(s.config);
    useRace.getState().reset(info);
    useUi.getState().setDisplayTime(0);
    useUi.getState().setPlaying(false);
    stream = openStream(info.runId, onMessage, (c) => useSession.setState({ connection: c }));
  } catch (err) {
    useSession.setState({ error: err instanceof Error ? err.message : String(err), fieldErrors: problemToFields(err) });
  } finally {
    useSession.setState({ creating: false });
  }
}

export async function run(): Promise<void> {
  const id = useRace.getState().runId;
  if (!id) {
    await createRun();
    return run();
  }
  if (useRace.getState().state === 'created' || useRace.getState().state === 'paused') useRace.getState().setInfo(await api.control(id, 'start'));
  useUi.getState().setPlaying(true);
}

export async function pause(): Promise<void> {
  useUi.getState().setPlaying(false);
}

export async function stepLap(): Promise<void> {
  const id = useRace.getState().runId;
  if (!id) return;
  useUi.getState().setPlaying(false);
  const st = useRace.getState();
  // advance the display by one reference lap; ask the worker for a step if that is not computed yet
  const lapRef = st.init?.diagnostics.lapRef_s ?? 107;
  const target = useUi.getState().displayTime + lapRef;
  if (target > st.available_s - 1) await api.control(id, 'step');
  useUi.getState().setDisplayTime(Math.min(target, Math.max(useRace.getState().available_s, useUi.getState().displayTime)));
}

export async function inject(kind: InjectionKind, params?: InjectionParams, label?: string): Promise<void> {
  const id = useRace.getState().runId;
  if (!id) return;
  try {
    const r = await api.inject(id, kind, params);
    useUi.getState().notify(`${label ?? kind} applies at lap ${r.appliesAtStep + 1} in all worlds`);
  } catch (err) {
    useUi.getState().notify(err instanceof Error ? err.message : String(err));
  }
}

export async function updateLive(kind: 'risk' | 'planner', body: Record<string, unknown>): Promise<string | null> {
  const id = useRace.getState().runId;
  if (!id) return null;
  try {
    useRace.getState().setInfo(kind === 'risk' ? await api.risk(id, body) : await api.planner(id, body));
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function fork(req: ForkRequest, label: string): Promise<void> {
  const id = useRace.getState().runId;
  if (!id) return;
  const { jobId } = await api.fork(id, req);
  useUi.getState().notify('fork running…');
  for (;;) {
    const s = await api.job<import('@pitwall/shared').ForkResult>(jobId);
    if (s.state === 'done' && s.result) {
      useRace.getState().addFork({ ...s.result, world: req.world, fromStep: req.fromStep, label });
      useUi.getState().notify(`Fork: ${label} → P${s.result.finalPos} (parent P${s.result.parentFinalPos})`);
      return;
    }
    if (s.state === 'error' || s.state === 'cancelled') {
      useUi.getState().notify(`fork failed: ${s.error ?? s.state}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

/** Display clock: advances by dt × speed while playing, never past the known frontier; reports pacing. */
export function startClock(): () => void {
  let last = performance.now();
  const tick = (now: number) => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    const ui = useUi.getState();
    const race = useRace.getState();
    if (ui.playing && race.runId) {
      const next = Math.min(ui.displayTime + dt * ui.speed, race.available_s);
      if (next !== ui.displayTime) ui.setDisplayTime(next);
      if (race.state === 'finished' && next >= race.available_s) ui.setPlaying(false);
    }
    stream?.setDisplayTime(useUi.getState().displayTime);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
