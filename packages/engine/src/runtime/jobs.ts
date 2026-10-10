// Long jobs (bench chunks, experiments, sensitivity, forks), independent of the transport: a Node worker
// thread on the server, a Web Worker in the static web build. Headless races run with the planner inline.
import type { ForkRequest, Injection, RunConfig } from '@pitwall/shared';
import { defaultConfigs, defaultRunConfig } from '@pitwall/shared';
import { benchContext, runSeed } from '../bench/runner';
import { runExperiment } from '../bench/experiments';
import { runSensitivity } from '../bench/sensitivity';
import { buildModel } from '../vehicle/model';
import { forkRun } from '../fork';

export type JobTask =
  | { kind: 'benchChunk'; items: { family: string; seed: number }[]; rounds?: number[]; oracle?: boolean; durationHours?: 1 | 3 | 6; trackId?: string }
  | { kind: 'experiment'; id: string; families: string[]; seedsPerFamily: number; rounds?: number[]; durationHours?: 1 | 3 | 6 }
  | { kind: 'sensitivity'; param: string; seeds: number; rounds?: number[]; durationHours?: 1 | 3 | 6 }
  | { kind: 'fork'; run: RunConfig; injections: Injection[]; req: ForkRequest; forkId: string };

export type JobMessage =
  | { type: 'progress'; done: number; total: number; record?: unknown }
  | { type: 'done'; result: unknown }
  | { type: 'error'; detail: string };

export function runJobTask(task: JobTask, post: (m: JobMessage) => void): void {
  try {
    const configs = defaultConfigs();
    switch (task.kind) {
      case 'benchChunk': {
        const run: Partial<RunConfig> = { durationHours: task.durationHours ?? 3, ...(task.trackId ? { trackId: task.trackId } : {}) };
        const model = buildModel(configs, { ...defaultRunConfig(), ...run });
        const ctx = benchContext(configs, run, { rounds: task.rounds, oracle: task.oracle, model });
        task.items.forEach((it, i) => {
          const record = runSeed(ctx, it.family, it.seed, run);
          post({ type: 'progress', done: i + 1, total: task.items.length, record });
        });
        post({ type: 'done', result: null });
        break;
      }
      case 'experiment': {
        const result = runExperiment(configs, task.id, {
          families: task.families,
          seedsPerFamily: task.seedsPerFamily,
          rounds: task.rounds,
          durationHours: task.durationHours,
          onProgress: (done, total) => post({ type: 'progress', done, total }),
        });
        post({ type: 'done', result });
        break;
      }
      case 'sensitivity': {
        post({ type: 'done', result: runSensitivity(configs, task.param, { seeds: task.seeds, rounds: task.rounds, durationHours: task.durationHours }) });
        break;
      }
      case 'fork': {
        post({ type: 'done', result: forkRun(configs, task.run, task.injections, task.req, task.forkId) });
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', detail: String((err as Error).stack ?? err) });
  }
}
