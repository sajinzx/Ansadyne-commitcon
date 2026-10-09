// Fastify server: CORS for the Vite dev server, WebSocket stream, REST routes and RFC 7807 errors.
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { RunManager, type RunManagerOptions } from './runs/RunManager';
import { JobManager, type JobManagerOptions } from './jobs/JobManager';
import { registerStream } from './ws';
import { registerRunRoutes } from './routes/runs';
import { registerMiscRoutes } from './routes/misc';
import { ProblemError } from './problem';

export interface ServerOptions extends RunManagerOptions, JobManagerOptions {
  logger?: boolean;
  heartbeatMs?: number;
  corsOrigin?: string | string[];
}

export interface PitwallServer {
  app: FastifyInstance;
  runs: RunManager;
  jobs: JobManager;
}

export async function buildServer(opts: ServerOptions = {}): Promise<PitwallServer> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  const runs = new RunManager(opts);
  const jobs = new JobManager(opts);
  await app.register(cors, { origin: opts.corsOrigin ?? ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173'] });
  await app.register(websocket);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ProblemError) {
      reply.code(err.status).type('application/problem+json').send(err.toJSON(req.url));
      return;
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const title = status === 400 ? 'Bad request' : status === 415 ? 'Unsupported media type' : 'Internal error';
    reply.code(status).type('application/problem+json').send({ type: 'about:blank', title, status, detail: err.message, instance: req.url });
  });
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).type('application/problem+json').send({ type: 'about:blank', title: 'Not found', status: 404, detail: `no route ${req.method} ${req.url}`, instance: req.url });
  });

  registerStream(app, runs, opts.heartbeatMs);
  registerRunRoutes(app, runs, jobs);
  registerMiscRoutes(app, jobs);
  app.addHook('onClose', async () => {
    await runs.close();
    await jobs.close();
  });
  return { app, runs, jobs };
}
