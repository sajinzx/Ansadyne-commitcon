import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BenchRequestSchema, SensitivitySchema, TrackPreviewSchema, FAMILIES, defaultConfigs, defaultRunConfig } from '@pitwall/shared';
import { CODE_VERSION, EXPERIMENTS, buildModel, sensitiveParams, trackPreview, type ModelBundle } from '@pitwall/engine';
import type { JobManager } from '../jobs/JobManager';
import { ProblemError, parse } from '../problem';

const ExperimentBody = z
  .object({ seedsPerFamily: z.number().int().min(1).max(500).default(20), families: z.array(z.enum(FAMILIES)).min(1).default(['F5']) })
  .strict();

let model: ModelBundle | null = null;
/** The default calibrated model (track payload, previews); built once on first use. */
export function defaultModel(): ModelBundle {
  model ??= buildModel(defaultConfigs(), defaultRunConfig());
  return model;
}

export function registerMiscRoutes(app: FastifyInstance, jobs: JobManager): void {
  const P = '/api/v1';
  app.get(`${P}/health`, async () => ({ status: 'ok', codeVersion: CODE_VERSION, node: process.versions.node }));
  app.get(`${P}/config/defaults`, async () => defaultConfigs());
  app.get(`${P}/track`, async () => defaultModel().geo.payload());
  app.post(`${P}/track/preview`, async (req) => trackPreview(defaultModel(), parse(TrackPreviewSchema, req.body)));
  app.get(`${P}/sensitivity/params`, async () => sensitiveParams(defaultConfigs()));
  app.get(`${P}/experiments`, async () => EXPERIMENTS.map((e) => ({ id: e.id, title: e.title, variants: e.variants.map((v) => v.label) })));

  app.post(`${P}/bench`, async (req, reply) => {
    const b = parse(BenchRequestSchema, req.body);
    reply.code(202);
    return jobs.bench(b);
  });
  app.post<{ Params: { name: string } }>(`${P}/experiments/:name`, async (req, reply) => {
    if (!EXPERIMENTS.some((e) => e.id === req.params.name)) throw new ProblemError(404, 'Not found', `experiment ${req.params.name} not found`);
    const b = parse(ExperimentBody, req.body);
    reply.code(202);
    return jobs.experiment(req.params.name, b.families, b.seedsPerFamily);
  });
  app.post(`${P}/sensitivity`, async (req, reply) => {
    const b = parse(SensitivitySchema, req.body);
    if (!sensitiveParams(defaultConfigs()).some((p) => p.path === b.param)) {
      throw new ProblemError(422, 'Invalid request', `unknown or calibrated parameter ${b.param}`, [{ path: 'param', message: 'not an assumed/illustrative/uncalibrated parameter' }]);
    }
    reply.code(202);
    return jobs.sensitivity(b.param, b.seeds ?? 100);
  });
  app.get<{ Params: { jobId: string } }>(`${P}/jobs/:jobId`, async (req) => jobs.get(req.params.jobId));
  app.delete<{ Params: { jobId: string } }>(`${P}/jobs/:jobId`, async (req, reply) => {
    await jobs.cancel(req.params.jobId);
    reply.code(204);
    return null;
  });
  app.get<{ Params: { jobId: string }; Querystring: { format?: string } }>(`${P}/jobs/:jobId/export`, async (req, reply) => {
    if (req.query.format === 'csv') {
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="bench-${req.params.jobId}.csv"`);
      return jobs.exportCsv(req.params.jobId);
    }
    reply.header('content-disposition', `attachment; filename="job-${req.params.jobId}.json"`);
    return jobs.get(req.params.jobId);
  });
}
