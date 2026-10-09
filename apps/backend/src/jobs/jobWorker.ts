// Bench pool worker: headless races with the planner inline (no nested pools, B22); also experiments,
// sensitivity and forks.
import { parentPort } from 'node:worker_threads';
import type { ForkRequest, Injection, RunConfig } from '@pitwall/shared';
import { defaultConfigs, defaultRunConfig } from '@pitwall/shared';
import { benchContext, buildModel, forkRun, runExperiment, runSeed, runSensitivity } from '@pitwall/engine';

export type JobTask =
  | { kind: 'benchChunk'; items: { family: string; seed: number }[]; rounds?: number[]; oracle?: boolean; durationHours?: 1 | 3 | 6 }
  | { kind: 'experiment'; id: string; families: string[]; seedsPerFamily: number; rounds?: number[]; durationHours?: 1 | 3 | 6 }
  | { kind: 'sensitivity'; param: string; seeds: number; rounds?: number[]; durationHours?: 1 | 3 | 6 }
  | { kind: 'fork'; run: RunConfig; injections: Injection[]; req: ForkRequest; forkId: string };

export type JobWorkerMessage =
  | { type: 'progress'; done: number; total: number; record?: unknown }
  | { type: 'done'; result: unknown }
  | { type: 'error'; detail: string };

const port = parentPort!;

port.on('message', (task: JobTask) => {
  try {
    const configs = defaultConfigs();
    switch (task.kind) {
      case 'benchChunk': {
        const run: Partial<RunConfig> = { durationHours: task.durationHours ?? 3 };
        const model = buildModel(configs, { ...defaultRunConfig(), ...run });
        const ctx = benchContext(configs, run, { rounds: task.rounds, oracle: task.oracle, model });
        task.items.forEach((it, i) => {
          const record = runSeed(ctx, it.family, it.seed, run);
          port.postMessage({ type: 'progress', done: i + 1, total: task.items.length, record } satisfies JobWorkerMessage);
        });
        port.postMessage({ type: 'done', result: null } satisfies JobWorkerMessage);
        break;
      }
      case 'experiment': {
        const result = runExperiment(configs, task.id, {
          families: task.families,
          seedsPerFamily: task.seedsPerFamily,
          rounds: task.rounds,
          durationHours: task.durationHours,
          onProgress: (done, total) => port.postMessage({ type: 'progress', done, total } satisfies JobWorkerMessage),
        });
        port.postMessage({ type: 'done', result } satisfies JobWorkerMessage);
        break;
      }
      case 'sensitivity': {
        const result = runSensitivity(configs, task.param, { seeds: task.seeds, rounds: task.rounds, durationHours: task.durationHours });
        port.postMessage({ type: 'done', result } satisfies JobWorkerMessage);
        break;
      }
      case 'fork': {
        const result = forkRun(configs, task.run, task.injections, task.req, task.forkId);
        port.postMessage({ type: 'done', result } satisfies JobWorkerMessage);
        break;
      }
    }
  } catch (err) {
    port.postMessage({ type: 'error', detail: String((err as Error).stack ?? err) } satisfies JobWorkerMessage);
  }
});
