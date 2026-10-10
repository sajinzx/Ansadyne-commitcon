// Web Worker: one long job (bench chunk, experiment, sensitivity, what-if fork) for the static web build.
import { runJobTask, type JobTask } from '@pitwall/engine';

const ctx = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent<JobTask>) => void) | null };
ctx.onmessage = (e) => runJobTask(e.data, (m) => ctx.postMessage(m));
