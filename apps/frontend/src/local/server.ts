// The in-browser backend for the static web build (GitHub Pages): the same REST surface and stream as the Fastify
// server, served from Web Workers. Races run in a race worker each, long jobs in job workers, model builds for the
// Track tab in a tools worker. Requests are validated with the same Zod schemas as the server.
import type { BenchRequest, BenchResult, Decision, ForkRequest, Injection, ProblemDetails, RunConfig, RunInfo, RunSummary, StreamMessage, StreamType } from '@pitwall/shared';
import {
  BenchRequestSchema,
  ControlSchema,
  EventsQuerySchema,
  ExperimentBodySchema,
  FAMILIES,
  ForkSchema,
  InjectSchema,
  PlannerPatchSchema,
  RiskSchema,
  RunConfigSchema,
  SensitivitySchema,
  SpeedSchema,
  TrackPreviewSchema,
  TrackQuerySchema,
  defaultConfigs,
  hashString,
  seedLabel,
  stableStringify,
  trackList,
} from '@pitwall/shared';
import { BENCH_DEFAULT_ROUNDS, CODE_VERSION, EXPERIMENTS, checkFrozen, seedsFor, sensitiveParams, settingsHash, summarize, type FromSession, type JobMessage, type JobTask, type SeedRecord, type ToSession } from '@pitwall/engine';
import { ApiError, problem } from '../api/errors';
import type { ToolsCall, ToolsRequest } from './toolsWorker';

type ZodLike<T> = { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } } };

function parse<T>(schema: ZodLike<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (r.success) return r.data;
  throw problem(
    422,
    'Invalid request',
    'the request failed validation',
    r.error.issues.map((i) => ({ path: i.path.length ? i.path.join('.') : '$', message: i.message })),
  );
}
const notFound = (what: string) => problem(404, 'Not found', `${what} not found`);
const conflict = (detail: string) => problem(409, 'Conflict', detail);
const shortId = () => (crypto.randomUUID ? crypto.randomUUID() : `${performance.now()}${Math.floor(performance.now() * 1e6) % 1e6}`).replace(/-/g, '').slice(0, 8);

// ------------------------------------------------------------------ event store
type Listener = (m: StreamMessage) => void;
class EventStore {
  private readonly log: StreamMessage[] = [];
  private readonly listeners = new Set<Listener>();
  constructor(readonly runId: string) {}
  get lastSeq() {
    return this.log.length - 1;
  }
  append(type: StreamType, payload: unknown) {
    const m: StreamMessage = { v: 1, runId: this.runId, seq: this.log.length, type, payload };
    this.log.push(m);
    for (const l of this.listeners) l(m);
  }
  query(fromSeq = 0, types?: StreamType[], limit = 10_000) {
    const events: StreamMessage[] = [];
    let i = Math.max(0, fromSeq);
    for (; i < this.log.length && events.length < limit; i++) if (!types || types.includes(this.log[i].type)) events.push(this.log[i]);
    return { events, nextSeq: i };
  }
  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
}

// ------------------------------------------------------------------ runs
interface RunEntry {
  info: RunInfo;
  worker: Worker | null;
  store: EventStore;
  displays: Map<string, number>;
  summary: RunSummary | null;
  decisions: Map<string, Decision>;
  settingsLog: { step: number; patch: unknown }[];
}
const ACTIVE: RunInfo['state'][] = ['created', 'running', 'paused'];

// ------------------------------------------------------------------ jobs
interface Job {
  id: string;
  kind: string;
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  progress: { done: number; total: number };
  startedAt: number;
  result?: unknown;
  error?: string;
  workers: Worker[];
}

export class LocalServer {
  private readonly runs = new Map<string, RunEntry>();
  private readonly jobs = new Map<string, Job>();
  private tools: Worker | null = null;
  private toolsSeq = 0;
  private readonly toolsPending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();
  /** headless jobs run 1-hour races in the browser to stay quick */
  readonly benchDurationHours: 1 | 3 | 6 = 1;
  readonly maxRuns = 2;

  // ---------------------------------------------------------------- routing
  async handle(method: string, url: string, body?: unknown): Promise<unknown> {
    const [path, qs] = url.split('?');
    const q = Object.fromEntries(new URLSearchParams(qs ?? ''));
    const seg = path.split('/').filter(Boolean);
    const m = method.toUpperCase();
    const is = (mm: string, n: number, ...fixed: (string | null)[]) => m === mm && seg.length === n && fixed.every((f, i) => f === null || seg[i] === f);

    if (is('GET', 1, 'health')) return { status: 'ok', codeVersion: CODE_VERSION, runtime: 'browser' };
    if (is('GET', 2, 'config', 'defaults')) return defaultConfigs();
    if (is('GET', 1, 'tracks')) return trackList();
    if (is('GET', 1, 'track')) return this.toolsCall({ op: 'track', trackId: parse(TrackQuerySchema, q).trackId ?? 'daytona' });
    if (is('POST', 2, 'track', 'preview')) return this.toolsCall({ op: 'preview', body: parse(TrackPreviewSchema, body) });
    if (is('GET', 2, 'sensitivity', 'params')) return sensitiveParams(defaultConfigs());
    if (is('GET', 1, 'experiments')) return EXPERIMENTS.map((e) => ({ id: e.id, title: e.title, variants: e.variants.map((v) => v.label) }));

    if (is('POST', 1, 'runs')) {
      if (body && typeof body === 'object' && (body as { oracleBelief?: boolean }).oracleBelief) throw problem(422, 'Invalid request', 'oracleBelief is a bench-only flag', [{ path: 'oracleBelief', message: 'allowed only on /bench' }]);
      return this.createRun(parse(RunConfigSchema, body) as RunConfig);
    }
    if (seg[0] === 'runs' && seg.length >= 2) {
      const id = seg[1];
      if (is('GET', 2, 'runs', null)) return this.entry(id).info;
      if (is('DELETE', 2, 'runs', null)) return this.removeRun(id);
      if (is('POST', 3, 'runs', null, 'control')) {
        const c = parse(ControlSchema, body);
        return this.control(id, c.action, { headless: q.headless === 'true', speed: c.speed });
      }
      if (is('PUT', 3, 'runs', null, 'speed')) {
        const e = this.entry(id);
        e.info.speed = parse(SpeedSchema, body).speed;
        return e.info;
      }
      if (is('POST', 3, 'runs', null, 'inject')) {
        const b = parse(InjectSchema, body);
        const e = this.entry(id);
        if (!e.worker || !ACTIVE.includes(e.info.state)) throw conflict(`run ${id} is ${e.info.state}`);
        this.post(e, { type: 'inject', kind: b.kind, params: b.params });
        return { appliesAtStep: e.info.step };
      }
      if (is('PUT', 3, 'runs', null, 'risk')) return this.updatePlanner(id, parse(RiskSchema, body));
      if (is('PUT', 3, 'runs', null, 'planner')) {
        const { gripZ, gripCooldown, triggers, ...rest } = parse(PlannerPatchSchema, body);
        const t = { ...(triggers ?? {}), ...(gripZ !== undefined ? { gripZ } : {}), ...(gripCooldown !== undefined ? { gripCooldown } : {}) };
        return this.updatePlanner(id, { ...rest, ...(Object.keys(t).length ? { triggers: t } : {}) });
      }
      if (is('POST', 3, 'runs', null, 'fork')) {
        const f = parse(ForkSchema, body) as ForkRequest;
        const info = this.entry(id).info;
        if (f.fromStep > info.step) throw problem(422, 'Invalid request', 'fromStep is beyond the computed race', [{ path: 'fromStep', message: `≤ ${info.step}` }]);
        if (info.step - f.fromStep > 200) throw problem(422, 'Invalid request', 'forks reach at most 200 steps back', [{ path: 'fromStep', message: `≥ ${info.step - 200}` }]);
        return this.fork(info.config, info.repro.injections, f);
      }
      if (is('GET', 3, 'runs', null, 'events')) {
        const ev = parse(EventsQuerySchema, q);
        return this.entry(id).store.query(ev.fromSeq ?? 0, ev.types ? (ev.types.split(',') as StreamType[]) : undefined, ev.limit);
      }
      if (is('GET', 4, 'runs', null, 'decisions', null)) {
        const d = this.entry(id).decisions.get(seg[3]);
        if (!d) throw notFound(`decision ${seg[3]}`);
        return d;
      }
      if (is('GET', 3, 'runs', null, 'summary')) {
        const e = this.entry(id);
        if (!e.summary) throw conflict('the run has not finished');
        return e.summary;
      }
      if (is('GET', 3, 'runs', null, 'export')) return this.exportRecord(id);
    }

    if (is('POST', 1, 'bench')) return this.bench(parse(BenchRequestSchema, body) as BenchRequest);
    if (is('POST', 2, 'experiments', null)) {
      if (!EXPERIMENTS.some((e) => e.id === seg[1])) throw problem(404, 'Not found', `experiment ${seg[1]} not found`);
      const b = parse(ExperimentBodySchema, body);
      return this.simpleJob('experiment', { kind: 'experiment', id: seg[1], families: b.families, seedsPerFamily: b.seedsPerFamily, durationHours: this.benchDurationHours });
    }
    if (is('POST', 1, 'sensitivity')) {
      const b = parse(SensitivitySchema, body);
      if (!sensitiveParams(defaultConfigs()).some((p) => p.path === b.param)) {
        throw problem(422, 'Invalid request', `unknown or calibrated parameter ${b.param}`, [{ path: 'param', message: 'not an assumed/illustrative/uncalibrated parameter' }]);
      }
      return this.simpleJob('sensitivity', { kind: 'sensitivity', param: b.param, seeds: b.seeds ?? 40, durationHours: this.benchDurationHours });
    }
    if (is('GET', 2, 'jobs', null)) return this.job(seg[1]);
    if (is('DELETE', 2, 'jobs', null)) {
      const j = this.jobs.get(seg[1]);
      if (!j) throw notFound(`job ${seg[1]}`);
      if (j.state === 'running' || j.state === 'queued') j.state = 'cancelled';
      j.workers.forEach((w) => w.terminate());
      return undefined;
    }
    throw problem(404, 'Not found', `no route ${m} ${path}`);
  }

  // ---------------------------------------------------------------- runs
  private entry(runId: string): RunEntry {
    const e = this.runs.get(runId);
    if (!e) throw notFound(`run ${runId}`);
    return e;
  }

  store(runId: string): EventStore {
    return this.entry(runId).store;
  }

  private post(e: RunEntry, m: ToSession) {
    e.worker?.postMessage(m);
  }

  private async createRun(config: RunConfig): Promise<RunInfo> {
    const active = [...this.runs.values()].filter((e) => e.worker && ACTIVE.includes(e.info.state)).length;
    if (active >= this.maxRuns) throw conflict(`at most ${this.maxRuns} active runs`);
    const runId = shortId();
    const store = new EventStore(runId);
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
    const worker = new Worker(new URL('./raceWorker.ts', import.meta.url), { type: 'module' });
    entry.worker = worker;
    const ready = new Promise<void>((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent<FromSession>) => {
        const m = ev.data;
        this.onMessage(entry, m);
        if (m.type === 'ready') resolve();
        if (m.type === 'error' && !entry.info.init) reject(new ApiError(m.problem));
      };
      worker.onerror = (ev) => {
        entry.info.state = 'error';
        entry.info.error = { type: 'about:blank', title: 'Race worker crashed', status: 500, detail: ev.message };
        reject(problem(500, 'Race worker crashed', ev.message));
      };
    });
    this.post(entry, { type: 'init', runId, config });
    try {
      await ready;
    } catch (err) {
      worker.terminate();
      this.runs.delete(runId);
      throw err instanceof ApiError ? err : problem(500, 'Run initialisation failed', String(err));
    }
    store.append('run_meta', info);
    return info;
  }

  private onMessage(e: RunEntry, m: FromSession) {
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
        e.info.repro.injections = m.injections as Injection[];
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
        e.info.error = m.problem as ProblemDetails;
        e.store.append('state', { state: 'error', step: e.info.step });
        break;
    }
  }

  private control(runId: string, action: 'start' | 'pause' | 'step', opts: { headless?: boolean; speed?: number }): RunInfo {
    const e = this.entry(runId);
    if (!e.worker || e.info.state === 'finished' || e.info.state === 'error') throw conflict(`run ${runId} is ${e.info.state}`);
    if (opts.speed !== undefined) e.info.speed = opts.speed;
    if (action === 'start') e.info.state = 'running';
    if (action === 'pause') e.info.state = 'paused';
    if (action === 'step' && e.info.state === 'created') e.info.state = 'paused';
    this.post(e, { type: 'control', action, headless: opts.headless });
    return e.info;
  }

  /** Pacing: the race stays ≤ 3 laps ahead of the furthest display clock. */
  setDisplay(runId: string, clientId: string, raceTime_s: number | null): void {
    const e = this.runs.get(runId);
    if (!e) return;
    if (raceTime_s === null) e.displays.delete(clientId);
    else e.displays.set(clientId, raceTime_s);
    const vals = [...e.displays.values()];
    this.post(e, { type: 'display', raceTime_s: vals.length ? Math.max(...vals) : null });
  }

  private updatePlanner(runId: string, patch: Record<string, unknown>): RunInfo {
    const e = this.entry(runId);
    if (!e.worker) throw conflict(`run ${runId} has no worker`);
    if (patch.pauseForPlanner === false) e.info.nonDeterministic = true;
    e.settingsLog.push({ step: e.info.step, patch });
    this.post(e, { type: 'planner', patch });
    return e.info;
  }

  private exportRecord(runId: string) {
    const e = this.entry(runId);
    return { config: e.info.config, repro: e.info.repro, settingsLog: e.settingsLog, injections: e.info.repro.injections, decisions: [...e.decisions.values()], finalClassification: e.summary };
  }

  private removeRun(runId: string): undefined {
    const e = this.entry(runId);
    e.worker?.terminate();
    e.worker = null;
    if (ACTIVE.includes(e.info.state)) e.info.state = 'finished';
    setTimeout(() => this.runs.delete(runId), 10 * 60_000);
    return undefined;
  }

  // ---------------------------------------------------------------- jobs
  private newJob(kind: string, total: number): Job {
    const job: Job = { id: shortId(), kind, state: 'queued', progress: { done: 0, total }, startedAt: performance.now(), workers: [] };
    this.jobs.set(job.id, job);
    return job;
  }

  private runTask(job: Job, task: JobTask, onProgress?: (m: Extract<JobMessage, { type: 'progress' }>) => void): Promise<unknown> {
    const w = new Worker(new URL('./jobWorker.ts', import.meta.url), { type: 'module' });
    job.workers.push(w);
    job.state = 'running';
    return new Promise((resolve, reject) => {
      w.onmessage = (ev: MessageEvent<JobMessage>) => {
        const m = ev.data;
        if (m.type === 'progress') onProgress?.(m);
        else {
          w.terminate();
          if (m.type === 'done') resolve(m.result);
          else reject(new Error(m.detail));
        }
      };
      w.onerror = (ev) => reject(new Error(ev.message));
      w.postMessage(task);
    });
  }

  private finish(job: Job, p: Promise<unknown>) {
    p.then(
      (result) => {
        if (job.state === 'cancelled') return;
        job.result = result;
        job.state = 'done';
        job.progress.done = job.progress.total;
      },
      (err) => {
        if (job.state === 'cancelled') return;
        job.state = 'error';
        job.error = String(err?.message ?? err);
      },
    );
  }

  private simpleJob(kind: string, task: JobTask): { jobId: string } {
    const job = this.newJob(kind, kind === 'sensitivity' ? 2 : 1);
    this.finish(
      job,
      this.runTask(job, task, (m) => (job.progress = { done: m.done, total: m.total })),
    );
    return { jobId: job.id };
  }

  private fork(run: RunConfig, injections: Injection[], req: ForkRequest): { jobId: string } {
    const job = this.newJob('fork', 1);
    this.finish(job, this.runTask(job, { kind: 'fork', run, injections, req, forkId: job.id }));
    return { jobId: job.id };
  }

  private bench(req: BenchRequest): { jobId: string } {
    const rounds = req.rounds ?? BENCH_DEFAULT_ROUNDS;
    const hash = settingsHash(defaultConfigs(), rounds);
    try {
      checkFrozen(req.split, hash, undefined);
    } catch (err) {
      throw problem(422, 'Settings not frozen', String((err as Error).message), [{ path: 'split', message: 'test-split runs require frozen settings' }]);
    }
    const items = req.families.flatMap((family) => seedsFor(req.split, family, req.seedsPerFamily).map((seed) => ({ family, seed })));
    const job = this.newJob('bench', items.length);
    const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
    const nW = Math.max(1, Math.min(4, cores - 1, items.length));
    const records: SeedRecord[] = [];
    const t0 = performance.now();
    const chunks = Array.from({ length: nW }, (_, w) => items.filter((_, i) => i % nW === w));
    const all = Promise.all(
      chunks.map((chunk) =>
        this.runTask(job, { kind: 'benchChunk', items: chunk, rounds, oracle: req.oracleBelief, durationHours: this.benchDurationHours }, (m) => {
          if (m.record) records.push(m.record as SeedRecord);
          job.progress.done = records.length;
        }),
      ),
    ).then((): BenchResult => {
      const byFamily = req.families.map((family) => ({
        family,
        index: Math.max(0, FAMILIES.indexOf(family as (typeof FAMILIES)[number])),
        recs: records.filter((r) => r.family === family).sort((a, b) => a.seed - b.seed),
      }));
      return {
        families: summarize(byFamily),
        settingsHash: hash,
        codeVersion: CODE_VERSION,
        runtimeMs: performance.now() - t0,
        rounds,
        split: req.split,
        experiment: req.experiment,
        extra: { benchWorkers: nW, durationHours: this.benchDurationHours, runtime: 'browser', seeds: Object.fromEntries(req.families.map((f) => [f, seedsFor(req.split, f, req.seedsPerFamily)])) },
      };
    });
    this.finish(job, all);
    return { jobId: job.id };
  }

  private job(jobId: string) {
    const j = this.jobs.get(jobId);
    if (!j) throw notFound(`job ${jobId}`);
    const elapsed = performance.now() - j.startedAt;
    const etaMs = j.state === 'running' && j.progress.done > 0 ? (elapsed / j.progress.done) * (j.progress.total - j.progress.done) : undefined;
    return { jobId: j.id, kind: j.kind, state: j.state, progress: j.progress, etaMs, result: j.result, error: j.error };
  }

  private readonly exportUrls = new Map<string, string>();

  /** CSV or JSON of a finished job, as an object URL for a download link (made once per job and format). */
  exportUrl(jobId: string, format: 'csv' | 'json'): string {
    const j = this.jobs.get(jobId);
    if (!j || j.state !== 'done') return '#';
    const key = `${jobId}:${format}`;
    const cached = this.exportUrls.get(key);
    if (cached) return cached;
    const url = this.makeExportUrl(j, format);
    this.exportUrls.set(key, url);
    return url;
  }

  private makeExportUrl(j: Job, format: 'csv' | 'json'): string {
    const jobId = j.id;
    if (format === 'json') return URL.createObjectURL(new Blob([JSON.stringify(this.job(jobId), null, 1)], { type: 'application/json' }));
    const r = j.result as BenchResult | undefined;
    if (!r?.families) return '#';
    const head = ['family', 'n', 'paired', 'meanPos_B0', 'meanPos_B1', 'meanPos_OPT', 'D_OPT_B1', 'boot_lo', 'boot_hi', 't_lo', 't_hi', 'holmP', 'win', 'tie', 'loss', 'pFinish_OPT', 'decisionMsP95', 'claim'];
    const rows = r.families.map((f) => {
      const d = f.diffs['OPT-B1'];
      return [f.family, f.n, f.paired, f.meanPos.B0, f.meanPos.B1, f.meanPos.OPT, d.mean, d.ciBoot95[0], d.ciBoot95[1], d.ciT95[0], d.ciT95[1], d.holmAdjustedP, ...f.winTieLoss['OPT-B1'], f.pFinish.OPT, f.decisionMsP95, f.claimOptBeatsB1 ?? false];
    });
    const meta = `# settingsHash=${r.settingsHash} codeVersion=${r.codeVersion} split=${r.split} rounds=${r.rounds.join('|')} runtime=browser`;
    const csv = [meta, head.join(','), ...rows.map((row) => row.map((v) => (typeof v === 'number' ? Number(v.toFixed(6)) : v)).join(','))].join('\n') + '\n';
    return URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  }

  // ---------------------------------------------------------------- tools worker (model builds)
  private toolsCall(req: ToolsCall): Promise<unknown> {
    if (!this.tools) {
      this.tools = new Worker(new URL('./toolsWorker.ts', import.meta.url), { type: 'module' });
      this.tools.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: unknown; detail?: string }>) => {
        const p = this.toolsPending.get(ev.data.id);
        if (!p) return;
        this.toolsPending.delete(ev.data.id);
        if (ev.data.ok) p.resolve(ev.data.result);
        else p.reject(problem(500, 'Model build failed', ev.data.detail));
      };
    }
    const id = ++this.toolsSeq;
    return new Promise((resolve, reject) => {
      this.toolsPending.set(id, { resolve, reject });
      this.tools!.postMessage({ ...req, id } as ToolsRequest);
    });
  }
}

let server: LocalServer | null = null;
export function localServer(): LocalServer {
  server ??= new LocalServer();
  return server;
}
