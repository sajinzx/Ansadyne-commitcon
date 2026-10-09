// Creates and drives runs: one race worker per run, at most `maxRuns` active, commands applied at the next
// uncomputed step in all worlds, every message appended to the run's EventStore.
import { randomUUID } from 'node:crypto';
import type { Worker } from 'node:worker_threads';
import type { Decision, InjectionKind, RunConfig, RunInfo, RunSummary } from '@pitwall/shared';
import { hashString, seedLabel, stableStringify } from '@pitwall/shared';
import { CODE_VERSION } from '@pitwall/engine';
import { EventStore } from '../store/EventStore';
import { spawnWorker } from '../workers';
import { ProblemError, conflict, notFound } from '../problem';
import type { FromWorker, PlannerPatch, ToWorker } from './protocol';

interface RunEntry {
  info: RunInfo;
  worker: Worker | null;
  store: EventStore;
  displays: Map<string, number>;
  summary: RunSummary | null;
  decisions: Map<string, Decision>;
  settingsLog: { step: number; patch: unknown }[];
}

export interface RunManagerOptions {
  maxRuns?: number;
  dataDir?: string;
  /** how long a deleted run's store is kept (ms) */
  keepDeletedMs?: number;
}

const ACTIVE: RunInfo['state'][] = ['created', 'running', 'paused'];

export class RunManager {
  private readonly runs = new Map<string, RunEntry>();
  readonly maxRuns: number;

  constructor(private readonly opts: RunManagerOptions = {}) {
    this.maxRuns = opts.maxRuns ?? 3;
  }

  private entry(runId: string): RunEntry {
    const e = this.runs.get(runId);
    if (!e) throw notFound(`run ${runId}`);
    return e;
  }

  get(runId: string): RunInfo {
    return this.entry(runId).info;
  }

  store(runId: string): EventStore {
    return this.entry(runId).store;
  }

  activeCount(): number {
    return [...this.runs.values()].filter((e) => e.worker && ACTIVE.includes(e.info.state)).length;
  }

  async create(config: RunConfig): Promise<RunInfo> {
    if (config.oracleBelief) throw new ProblemError(422, 'Invalid request', 'oracleBelief is a bench-only flag', [{ path: 'oracleBelief', message: 'allowed only on /bench' }]);
    if (this.activeCount() >= this.maxRuns) throw conflict(`at most ${this.maxRuns} active runs`);
    const runId = randomUUID().slice(0, 8);
    const store = new EventStore(runId, this.opts.dataDir);
    const info: RunInfo = {
      runId,
      state: 'created',
      step: 0,
      raceTime_s: 0,
      config,
      seedLabel: seedLabel(config.masterSeed),
      speed: 1,
      nonDeterministic: false,
      repro: { codeVersion: CODE_VERSION, configHash: hashString(stableStringify(config)), masterSeed: config.masterSeed, injections: [] },
    };
    const entry: RunEntry = { info, worker: null, store, displays: new Map(), summary: null, decisions: new Map(), settingsLog: [] };
    this.runs.set(runId, entry);
    const worker = spawnWorker(new URL('./raceWorker.ts', import.meta.url));
    entry.worker = worker;
    const ready = new Promise<void>((resolve, reject) => {
      worker.on('message', (m: FromWorker) => {
        this.onMessage(entry, m);
        if (m.type === 'ready') resolve();
        if (m.type === 'error' && !entry.info.init) reject(new ProblemError(500, m.problem.title, m.problem.detail));
      });
      worker.on('error', (err) => {
        entry.info.state = 'error';
        entry.info.error = { type: 'about:blank', title: 'Race worker crashed', status: 500, detail: String(err) };
        reject(err);
      });
    });
    this.post(entry, { type: 'init', runId, config });
    try {
      await ready;
    } catch (err) {
      await worker.terminate();
      entry.worker = null;
      this.runs.delete(runId);
      throw err instanceof ProblemError ? err : new ProblemError(500, 'Run initialisation failed', String(err));
    }
    store.append('run_meta', info);
    return info;
  }

  private post(e: RunEntry, m: ToWorker) {
    e.worker?.postMessage(m);
  }

  private onMessage(e: RunEntry, m: FromWorker) {
    switch (m.type) {
      case 'ready':
        e.info.init = m.init;
        break;
      case 'messages':
        for (const msg of m.msgs) {
          e.store.append(msg.type, msg.payload);
          if (msg.type === 'decision') {
            const d = msg.payload as Decision;
            e.decisions.set(d.id, d);
          }
        }
        e.info.step = m.step;
        e.info.raceTime_s = m.raceTime_s;
        e.info.repro.injections = m.injections;
        break;
      case 'state':
        if (e.info.state !== 'error') e.info.state = m.state;
        e.info.step = m.step;
        e.info.raceTime_s = m.raceTime_s;
        e.store.append('state', { state: e.info.state, step: m.step });
        break;
      case 'summary':
        e.summary = m.summary;
        e.store.append('run_end', m.summary);
        break;
      case 'error':
        e.info.state = 'error';
        e.info.error = m.problem;
        e.store.append('state', { state: 'error', step: e.info.step });
        break;
    }
  }

  control(runId: string, action: 'start' | 'pause' | 'step', opts: { headless?: boolean; speed?: number } = {}): RunInfo {
    const e = this.entry(runId);
    if (!e.worker || e.info.state === 'finished' || e.info.state === 'error') throw conflict(`run ${runId} is ${e.info.state}`);
    if (opts.speed !== undefined) e.info.speed = opts.speed;
    if (action === 'start') e.info.state = 'running';
    if (action === 'pause') e.info.state = 'paused';
    if (action === 'step' && e.info.state === 'created') e.info.state = 'paused';
    this.post(e, { type: 'control', action, headless: opts.headless });
    return e.info;
  }

  setSpeed(runId: string, speed: number): RunInfo {
    const e = this.entry(runId);
    e.info.speed = speed;
    return e.info;
  }

  /** Pacing: the worker stays ≤ 3 laps ahead of the furthest client display time. */
  setDisplay(runId: string, clientId: string, raceTime_s: number | null): void {
    const e = this.runs.get(runId);
    if (!e) return;
    if (raceTime_s === null) e.displays.delete(clientId);
    else e.displays.set(clientId, raceTime_s);
    const vals = [...e.displays.values()];
    this.post(e, { type: 'display', raceTime_s: vals.length ? Math.max(...vals) : null });
  }

  inject(runId: string, kind: InjectionKind, params?: { segmentId?: string }): { appliesAtStep: number } {
    const e = this.entry(runId);
    if (!e.worker || !ACTIVE.includes(e.info.state)) throw conflict(`run ${runId} is ${e.info.state}`);
    this.post(e, { type: 'inject', kind, params });
    return { appliesAtStep: e.info.step };
  }

  updatePlanner(runId: string, patch: PlannerPatch): RunInfo {
    const e = this.entry(runId);
    if (!e.worker) throw conflict(`run ${runId} has no worker`);
    if (patch.pauseForPlanner === false) e.info.nonDeterministic = true;
    e.settingsLog.push({ step: e.info.step, patch });
    this.post(e, { type: 'planner', patch });
    return e.info;
  }

  decision(runId: string, id: string): Decision {
    const d = this.entry(runId).decisions.get(id);
    if (!d) throw notFound(`decision ${id}`);
    return d;
  }

  summary(runId: string): RunSummary {
    const e = this.entry(runId);
    if (!e.summary) throw conflict('the run has not finished');
    return e.summary;
  }

  exportRecord(runId: string) {
    const e = this.entry(runId);
    return {
      config: e.info.config,
      repro: e.info.repro,
      settingsLog: e.settingsLog,
      injections: e.info.repro.injections,
      decisions: [...e.decisions.values()],
      finalClassification: e.summary,
    };
  }

  async remove(runId: string): Promise<void> {
    const e = this.entry(runId);
    if (e.worker) await e.worker.terminate();
    e.worker = null;
    if (ACTIVE.includes(e.info.state)) e.info.state = 'finished';
    setTimeout(() => this.runs.delete(runId), this.opts.keepDeletedMs ?? 10 * 60_000).unref();
  }

  async close(): Promise<void> {
    await Promise.all([...this.runs.values()].map((e) => e.worker?.terminate()));
  }
}
