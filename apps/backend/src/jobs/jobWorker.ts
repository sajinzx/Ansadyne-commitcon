// Bench pool worker: a transport adapter around the engine's job runner (headless races, experiments,
// sensitivity, forks; no nested pools, B22).
import { parentPort } from 'node:worker_threads';
import { runJobTask, type JobTask, type JobMessage } from '@pitwall/engine';

export type { JobTask, JobMessage as JobWorkerMessage };

const port = parentPort!;
port.on('message', (task: JobTask) => runJobTask(task, (m) => port.postMessage(m)));
