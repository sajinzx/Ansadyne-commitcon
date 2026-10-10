// Race worker thread: a transport adapter around the engine's RaceSession (three paired worlds, planner inline).
import { parentPort } from 'node:worker_threads';
import { RaceSession } from '@pitwall/engine';
import type { FromWorker, ToWorker } from './protocol';

const port = parentPort!;
const session = new RaceSession(
  (m: FromWorker) => port.postMessage(m),
  () => new Promise((res) => setImmediate(res)),
);
port.on('message', (m: ToWorker) => session.handle(m));
