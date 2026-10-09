// Long jobs (bench, experiments, sensitivity, forks): progress, cancel, results, CSV/JSON export.
import { randomUUID } from 'node:crypto';
import type { Worker } from 'node:worker_threads';
import type { BenchRequest, BenchResult, ForkRequest, Injection, RunConfig } from '@pitwall/shared';
import { FAMILIES, defaultConfigs } from '@pitwall/shared';
import { CODE_VERSION, checkFrozen, seedsFor, settingsHash, summarize, BENCH_DEFAULT_ROUNDS, type SeedRecord } from '@pitwall/engine';
import { cpuCount, spawnWorker } from '../workers';
import { ProblemError, notFound } from '../problem';
import type { JobTask, JobWorkerMessage } from './jobWorker';

export type JobState = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

interface Job {
  id: string;
  kind: JobTask['kind'] | 'bench';
  state: JobState;
  progress: { done: number; total: number };
  startedAt: number;
  result?: unknown;
  error?: string;
  workers: Worker[];
  meta: Record<string, unknown>;
}

export interface JobManagerOptions {
  benchWorkers?: number;
  /** frozen settings hash required for test-split benches */
  frozenSettingsHash?: string;
  /** race duration used by bench jobs (hours) */
  benchDurationHours?: 1 | 3 | 6;
}

const WORKER_URL = new URL('./jobWorker.ts', import.meta.url);

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  readonly benchWorkers: number;

  constructor(private readonly opts: JobManagerOptions = {}) {
    this.benchWorkers = opts.benchWorkers ?? Math.max(1, cpuCount() - 1);
  }

  private newJob(kind: Job['kind'], total: number, meta: Record<string, unknown> = {}): Job {
    const job: Job = { id: randomUUID().slice(0, 8), kind, state: 'queued', progress: { done: 0, total }, startedAt: Date.now(), workers: [], meta };
    this.jobs.set(job.id, job);
    return job;
  }

  private runTask(job: Job, task: JobTask, onProgress?: (m: Extract<JobWorkerMessage, { type: 'progress' }>) => void): Promise<unknown> {
    const w = spawnWorker(WORKER_URL);
    job.workers.push(w);
    job.state = 'running';
    return new Promise((resolve, reject) => {
      w.on('message', (m: JobWorkerMessage) => {
        if (m.type === 'progress') onProgress?.(m);
        else if (m.type === 'done') {
          void w.terminate();
          resolve(m.result);
        } else {
          void w.terminate();
          reject(new Error(m.detail));
        }
      });
      w.on('error', reject);
      w.on('exit', (code) => {
        if (job.state === 'cancelled') reject(new Error('cancelled'));
        else if (code !== 0 && code !== 1) reject(new Error(`worker exited with ${code}`));
      });
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

  bench(req: BenchRequest): { jobId: string } {
    const rounds = req.rounds ?? BENCH_DEFAULT_ROUNDS;
    const hash = settingsHash(defaultConfigs(), rounds);
    try {
      checkFrozen(req.split, hash, this.opts.frozenSettingsHash);
    } catch (err) {
      throw new ProblemError(422, 'Settings not frozen', String((err as Error).message), [{ path: 'split', message: 'test-split runs require frozen settings' }]);
    }
    const items = req.families.flatMap((family) => seedsFor(req.split, family, req.seedsPerFamily).map((seed) => ({ family, seed })));
    const job = this.newJob('bench', items.length, { request: req });
    const nW = Math.min(this.benchWorkers, items.length);
    const records: SeedRecord[] = [];
    const t0 = Date.now();
    const chunks = Array.from({ length: nW }, (_, w) => items.filter((_, i) => i % nW === w));
    const all = Promise.all(
      chunks.map((chunk) =>
        this.runTask(job, { kind: 'benchChunk', items: chunk, rounds, oracle: req.oracleBelief, durationHours: this.opts.benchDurationHours }, (m) => {
          if (m.record) records.push(m.record as SeedRecord);
          job.progress.done = records.length;
        }),
      ),
    ).then((): BenchResult => {
      // reduce in (family, seed) order so the pool size never changes the result
      const byFamily = req.families.map((family) => ({
        family,
        index: Math.max(0, FAMILIES.indexOf(family as (typeof FAMILIES)[number])),
        recs: records.filter((r) => r.family === family).sort((a, b) => a.seed - b.seed),
      }));
      return {
        families: summarize(byFamily),
        settingsHash: hash,
        codeVersion: CODE_VERSION,
        runtimeMs: Date.now() - t0,
        rounds,
        split: req.split,
        experiment: req.experiment,
        extra: { benchWorkers: nW, durationHours: this.opts.benchDurationHours ?? 3, seeds: Object.fromEntries(req.families.map((f) => [f, seedsFor(req.split, f, req.seedsPerFamily)])) },
      };
    });
    this.finish(job, all);
    return { jobId: job.id };
  }

  experiment(id: string, families: string[], seedsPerFamily: number): { jobId: string } {
    const job = this.newJob('experiment', 1, { id });
    this.finish(
      job,
      this.runTask(job, { kind: 'experiment', id, families, seedsPerFamily, durationHours: this.opts.benchDurationHours }, (m) => (job.progress = { done: m.done, total: m.total })),
    );
    return { jobId: job.id };
  }

  sensitivity(param: string, seeds: number): { jobId: string } {
    const job = this.newJob('sensitivity', 2, { param });
    this.finish(job, this.runTask(job, { kind: 'sensitivity', param, seeds, durationHours: this.opts.benchDurationHours }));
    return { jobId: job.id };
  }

  fork(run: RunConfig, injections: Injection[], req: ForkRequest): { jobId: string } {
    const job = this.newJob('fork', 1, { world: req.world, fromStep: req.fromStep });
    this.finish(job, this.runTask(job, { kind: 'fork', run, injections, req, forkId: job.id }));
    return { jobId: job.id };
  }

  get(jobId: string) {
    const j = this.jobs.get(jobId);
    if (!j) throw notFound(`job ${jobId}`);
    const elapsed = Date.now() - j.startedAt;
    const etaMs = j.state === 'running' && j.progress.done > 0 ? (elapsed / j.progress.done) * (j.progress.total - j.progress.done) : undefined;
    return { jobId: j.id, kind: j.kind, state: j.state, progress: j.progress, etaMs, result: j.result, error: j.error };
  }

  async cancel(jobId: string): Promise<void> {
    const j = this.jobs.get(jobId);
    if (!j) throw notFound(`job ${jobId}`);
    if (j.state === 'running' || j.state === 'queued') j.state = 'cancelled';
    await Promise.all(j.workers.map((w) => w.terminate()));
  }

  exportCsv(jobId: string): string {
    const j = this.get(jobId);
    const r = j.result as BenchResult | undefined;
    if (!r?.families) throw new ProblemError(409, 'Conflict', 'no bench result to export');
    const head = ['family', 'n', 'paired', 'meanPos_B0', 'meanPos_B1', 'meanPos_OPT', 'D_OPT_B1', 'boot_lo', 'boot_hi', 't_lo', 't_hi', 'holmP', 'win', 'tie', 'loss', 'pFinish_OPT', 'decisionMsP95', 'claim'];
    const rows = r.families.map((f) => {
      const d = f.diffs['OPT-B1'];
      return [f.family, f.n, f.paired, f.meanPos.B0, f.meanPos.B1, f.meanPos.OPT, d.mean, d.ciBoot95[0], d.ciBoot95[1], d.ciT95[0], d.ciT95[1], d.holmAdjustedP, ...f.winTieLoss['OPT-B1'], f.pFinish.OPT, f.decisionMsP95, f.claimOptBeatsB1 ?? false];
    });
    const meta = `# settingsHash=${r.settingsHash} codeVersion=${r.codeVersion} split=${r.split} rounds=${r.rounds.join('|')}`;
    return [meta, head.join(','), ...rows.map((row) => row.map((v) => (typeof v === 'number' ? Number(v.toFixed(6)) : v)).join(','))].join('\n') + '\n';
  }

  async close(): Promise<void> {
    await Promise.all([...this.jobs.values()].flatMap((j) => j.workers.map((w) => w.terminate())));
  }
}
