import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ControlSchema, ForkSchema, InjectSchema, PlannerUpdateSchema, RiskSchema, RunConfigSchema, SpeedSchema, type StreamType } from '@pitwall/shared';
import type { RunManager } from '../runs/RunManager';
import type { JobManager } from '../jobs/JobManager';
import { ProblemError, parse } from '../problem';

const TriggersPatch = z
  .object({
    gripZ: z.number().min(1).max(5).optional(),
    gripCooldown: z.number().int().min(0).max(50).optional(),
    scheduledEvery: z.number().int().min(1).max(100).optional(),
  })
  .strict();
const PlannerPatch = PlannerUpdateSchema.and(z.object({ triggers: TriggersPatch.optional() }));
const EventsQuery = z.object({ fromSeq: z.coerce.number().int().min(0).optional(), types: z.string().optional(), limit: z.coerce.number().int().min(1).max(100_000).optional() });

export function registerRunRoutes(app: FastifyInstance, runs: RunManager, jobs: JobManager): void {
  const P = '/api/v1/runs';
  app.post(P, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body && typeof body === 'object' && 'oracleBelief' in body && body.oracleBelief) {
      throw new ProblemError(422, 'Invalid request', 'oracleBelief is a bench-only flag', [{ path: 'oracleBelief', message: 'allowed only on /bench' }]);
    }
    const config = parse(RunConfigSchema, req.body);
    const info = await runs.create(config);
    reply.code(201);
    return info;
  });
  app.get<{ Params: { runId: string } }>(`${P}/:runId`, async (req) => runs.get(req.params.runId));
  app.post<{ Params: { runId: string }; Querystring: { headless?: string } }>(`${P}/:runId/control`, async (req) => {
    const c = parse(ControlSchema, req.body);
    return runs.control(req.params.runId, c.action, { headless: req.query.headless === 'true', speed: c.speed });
  });
  app.put<{ Params: { runId: string } }>(`${P}/:runId/speed`, async (req) => runs.setSpeed(req.params.runId, parse(SpeedSchema, req.body).speed));
  app.post<{ Params: { runId: string } }>(`${P}/:runId/inject`, async (req, reply) => {
    const b = parse(InjectSchema, req.body);
    reply.code(202);
    return runs.inject(req.params.runId, b.kind, b.params);
  });
  app.put<{ Params: { runId: string } }>(`${P}/:runId/risk`, async (req) => runs.updatePlanner(req.params.runId, parse(RiskSchema, req.body)));
  app.put<{ Params: { runId: string } }>(`${P}/:runId/planner`, async (req) => {
    const { gripZ, gripCooldown, triggers, ...rest } = parse(PlannerPatch, req.body);
    const t = { ...(triggers ?? {}), ...(gripZ !== undefined ? { gripZ } : {}), ...(gripCooldown !== undefined ? { gripCooldown } : {}) };
    return runs.updatePlanner(req.params.runId, { ...rest, ...(Object.keys(t).length ? { triggers: t } : {}) });
  });
  app.post<{ Params: { runId: string } }>(`${P}/:runId/fork`, async (req, reply) => {
    const f = parse(ForkSchema, req.body);
    const info = runs.get(req.params.runId);
    if (f.fromStep > info.step) throw new ProblemError(422, 'Invalid request', 'fromStep is beyond the computed race', [{ path: 'fromStep', message: `≤ ${info.step}` }]);
    if (info.step - f.fromStep > 200) throw new ProblemError(422, 'Invalid request', 'forks reach at most 200 steps back', [{ path: 'fromStep', message: `≥ ${info.step - 200}` }]);
    reply.code(202);
    return jobs.fork(info.config, info.repro.injections, f);
  });
  app.get<{ Params: { runId: string } }>(`${P}/:runId/events`, async (req) => {
    const q = parse(EventsQuery, req.query);
    const types = q.types ? (q.types.split(',') as StreamType[]) : undefined;
    return runs.store(req.params.runId).query(q.fromSeq ?? 0, types, q.limit);
  });
  app.get<{ Params: { runId: string; decisionId: string } }>(`${P}/:runId/decisions/:decisionId`, async (req) => runs.decision(req.params.runId, req.params.decisionId));
  app.get<{ Params: { runId: string } }>(`${P}/:runId/summary`, async (req) => runs.summary(req.params.runId));
  app.get<{ Params: { runId: string } }>(`${P}/:runId/export`, async (req, reply) => {
    reply.header('content-disposition', `attachment; filename="run-${req.params.runId}.json"`);
    return runs.exportRecord(req.params.runId);
  });
  app.delete<{ Params: { runId: string } }>(`${P}/:runId`, async (req, reply) => {
    await runs.remove(req.params.runId);
    reply.code(204);
    return null;
  });
}
