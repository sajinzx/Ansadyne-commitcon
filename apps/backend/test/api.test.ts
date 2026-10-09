import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Decision, LapEvent, RunInfo, StreamMessage } from '@pitwall/shared';
import { buildServer, type PitwallServer } from '../src/server';

const RUN = { masterSeed: 914, split: 'dev', durationHours: 1, startClock: '14:00', egoGridSlot: 6, multiplierModel: 'expOU', overrides: {} };
let srv: PitwallServer;
let base = '';

beforeAll(async () => {
  srv = await buildServer({ heartbeatMs: 200, benchWorkers: 2, benchDurationHours: 1, keepDeletedMs: 50 });
  await srv.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = srv.app.server.address() as { port: number };
  base = `127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await srv.app.close();
});

const api = async (method: string, url: string, body?: unknown) => {
  const r = await srv.app.inject({ method: method as 'GET', url: `/api/v1${url}`, payload: body as object });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, type: r.headers['content-type'] };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(f: () => Promise<T | null | undefined>, timeoutMs = 120_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout');
    await sleep(200);
  }
}

async function runToEnd(config = RUN, injectAtStep?: number): Promise<string> {
  const c = await api('POST', '/runs', config);
  expect(c.status).toBe(201);
  const id = (c.body as RunInfo).runId;
  if (injectAtStep !== undefined) {
    for (let i = 0; i < injectAtStep; i++) await api('POST', `/runs/${id}/control`, { action: 'step' });
    await waitFor(async () => ((await api('GET', `/runs/${id}`)).body.step >= injectAtStep ? true : null));
    await api('POST', `/runs/${id}/inject`, { kind: 'caution' });
  }
  await api('POST', `/runs/${id}/control?headless=true`, { action: 'start' });
  await waitFor(async () => ((await api('GET', `/runs/${id}`)).body.state === 'finished' ? true : null));
  return id;
}

const stripTiming = (d: Decision) => ({ ...d, elapsedMs: 0, overBudget: false });

describe('backend API', () => {
  it('health, defaults, track and preview return the documented shapes', async () => {
    expect((await api('GET', '/health')).body.status).toBe('ok');
    const d = await api('GET', '/config/defaults');
    expect(Object.keys(d.body).sort()).toEqual(['car', 'field', 'planner', 'race', 'track']);
    const t = await api('GET', '/track');
    expect(t.body.lapLength_m).toBeCloseTo(5730, 0);
    const p = await api('POST', '/track/preview', { wetness: 0.4, trackTemp_C: 30, rubber: 0.02, overrides: [{ segmentId: 'S08', debris: true }] });
    expect(p.status).toBe(200);
    expect(p.body.segments.find((s: { id: string }) => s.id === 'S08').hazard).toBe('debris');
    expect(p.body.lapTime_s).toBeGreaterThan(100);
  }, 60_000);

  it('invalid inputs return 422 problem details with the failing path; unknown run 404', async () => {
    for (const [m, u, b] of [
      ['POST', '/runs', { ...RUN, masterSeed: 6000 }],
      ['POST', '/runs', { ...RUN, durationHours: 24 }],
      ['POST', '/track/preview', { wetness: 2, trackTemp_C: 30, rubber: 0 }],
      ['POST', '/bench', { families: ['F99'], seedsPerFamily: 2, split: 'dev' }],
      ['POST', '/sensitivity', { param: 'nope' }],
    ] as const) {
      const r = await api(m, u, b);
      expect(r.status).toBe(422);
      expect(r.type).toContain('application/problem+json');
      expect(r.body.errors.length).toBeGreaterThan(0);
    }
    expect((await api('GET', '/runs/zzz')).status).toBe(404);
    expect((await api('POST', '/runs/zzz/inject', { kind: 'caution' })).status).toBe(404);
  });

  it('oracleBelief is rejected outside /bench; test-split bench needs frozen settings', async () => {
    const r = await api('POST', '/runs', { ...RUN, oracleBelief: true });
    expect(r.status).toBe(422);
    expect(r.body.errors[0].path).toBe('oracleBelief');
    const t = await api('POST', '/bench', { families: ['F5'], seedsPerFamily: 2, split: 'test' });
    expect(t.status).toBe(422);
  });

  it('stream: ordered seq with no gaps, replay from fromSeq without duplicates, heartbeats', async () => {
    const c = await api('POST', '/runs', RUN);
    const id = (c.body as RunInfo).runId;
    const got: StreamMessage[] = [];
    let heartbeats = 0;
    const ws = new WebSocket(`ws://${base}/api/v1/runs/${id}/stream?fromSeq=0`);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as StreamMessage;
      if (m.type === 'heartbeat') heartbeats++;
      else got.push(m);
    });
    await new Promise((r) => ws.on('open', r));
    await api('POST', `/runs/${id}/control?headless=true`, { action: 'start' });
    await waitFor(async () => (got.some((m) => m.type === 'run_end') ? true : null));
    ws.close();
    got.forEach((m, i) => expect(m.seq).toBe(i));
    expect(got[0].type).toBe('run_meta');
    expect(heartbeats).toBeGreaterThan(0);
    // reconnect from the middle
    const from = Math.floor(got.length / 2);
    const again: StreamMessage[] = [];
    const ws2 = new WebSocket(`ws://${base}/api/v1/runs/${id}/stream?fromSeq=${from}`);
    ws2.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as StreamMessage;
      if (m.type !== 'heartbeat') again.push(m);
    });
    await waitFor(async () => (again.length >= got.length - from ? true : null));
    ws2.close();
    expect(again.map((m) => m.seq)).toEqual(got.slice(from).map((m) => m.seq));
    // REST events agree with the stream
    const ev = await api('GET', `/runs/${id}/events?fromSeq=0&types=decision`);
    expect(ev.body.events.length).toBe(got.filter((m) => m.type === 'decision').length);
    const dec = ev.body.events[0]?.payload as Decision | undefined;
    if (dec) expect((await api('GET', `/runs/${id}/decisions/${dec.id}`)).body.id).toBe(dec.id);
    expect((await api('GET', `/runs/${id}/summary`)).status).toBe(200);
    expect((await api('GET', `/runs/${id}/export`)).body.config.masterSeed).toBe(914);
    expect((await api('DELETE', `/runs/${id}`)).status).toBe(204);
  }, 180_000);

  it('determinism through the API: same config, seed and injection give identical lap and decision payloads', async () => {
    const hash = async (id: string) => {
      const ev = (await api('GET', `/runs/${id}/events?limit=100000`)).body.events as StreamMessage[];
      const laps = ev.filter((m) => m.type === 'lap').map((m) => m.payload as LapEvent);
      const decs = ev.filter((m) => m.type === 'decision').map((m) => stripTiming(m.payload as Decision));
      return JSON.stringify({ laps, decs });
    };
    const a = await runToEnd(RUN, 6);
    const b = await runToEnd(RUN, 6);
    const ha = await hash(a);
    expect(ha.length).toBeGreaterThan(1000);
    expect(await hash(b)).toBe(ha);
    const inj = (await api('GET', `/runs/${a}`)).body.repro.injections;
    expect(inj[0]).toMatchObject({ kind: 'caution', step: 6 });
    await api('DELETE', `/runs/${a}`);
    await api('DELETE', `/runs/${b}`);
  }, 240_000);

  it('pacing: with the display time frozen at 0 the worker stays ≤ 3 laps ahead', async () => {
    const c = await api('POST', '/runs', RUN);
    const id = (c.body as RunInfo).runId;
    const ws = new WebSocket(`ws://${base}/api/v1/runs/${id}/stream`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'display', raceTime_s: 0 }));
    await sleep(100);
    await api('POST', `/runs/${id}/control`, { action: 'start' });
    await sleep(4000);
    const info = (await api('GET', `/runs/${id}`)).body as RunInfo;
    expect(info.step).toBeGreaterThan(0);
    // stepping stops once computed time ≥ display + 3·lapRef; one step may cross that line
    expect(info.raceTime_s).toBeLessThanOrEqual(4 * 107.5);
    ws.close();
    await api('DELETE', `/runs/${id}`);
  }, 60_000);

  it('concurrency: a 4th active run returns 409', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await api('POST', '/runs', RUN)).body.runId);
    const r = await api('POST', '/runs', RUN);
    expect(r.status).toBe(409);
    for (const id of ids) await api('DELETE', `/runs/${id}`);
  }, 60_000);

  it('bench job: progress, result table and CSV export; fork job returns a ForkResult', async () => {
    const b = await api('POST', '/bench', { families: ['F5'], seedsPerFamily: 2, split: 'dev', rounds: [50] });
    expect(b.status).toBe(202);
    const job = await waitFor(async () => {
      const j = (await api('GET', `/jobs/${b.body.jobId}`)).body;
      return j.state === 'done' || j.state === 'error' ? j : null;
    }, 240_000);
    expect(job.state).toBe('done');
    expect(job.result.families[0].n).toBe(2);
    const csv = await srv.app.inject({ method: 'GET', url: `/api/v1/jobs/${b.body.jobId}/export?format=csv` });
    expect(csv.body.split('\n')[1]).toContain('family,n,paired');

    const id = await runToEnd();
    const info = (await api('GET', `/runs/${id}`)).body as RunInfo;
    const f = await api('POST', `/runs/${id}/fork`, { world: 'OPT', fromStep: info.step - 20, forcedPlan: { stops: [], mode: null, source: 'what-if', committedLap: 0 } });
    expect(f.status).toBe(202);
    const fj = await waitFor(async () => {
      const j = (await api('GET', `/jobs/${f.body.jobId}`)).body;
      return j.state === 'done' || j.state === 'error' ? j : null;
    }, 240_000);
    expect(fj.state).toBe('done');
    expect(fj.result.parentFinalPos).toBeGreaterThanOrEqual(1);
    expect(fj.result.positionTrace.length).toBeGreaterThan(0);
  }, 400_000);
});
