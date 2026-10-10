// The in-browser backend (static web build): routes and validation that need no worker.
import { describe, expect, it } from 'vitest';
import { LocalServer } from '../src/local/server';
import { ApiError } from '../src/api/errors';

const srv = new LocalServer();
const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return (e as ApiError).problem;
  }
  throw new Error('expected an error');
};

describe('LocalServer', () => {
  it('serves health, defaults, tracks, experiments and sensitivity parameters', async () => {
    expect(await srv.handle('GET', '/health')).toMatchObject({ status: 'ok', runtime: 'browser' });
    const tracks = (await srv.handle('GET', '/tracks')) as { id: string }[];
    expect(tracks.map((t) => t.id)).toEqual(['daytona', 'sebring', 'road-atlanta', 'watkins-glen', 'spa']);
    const cfg = (await srv.handle('GET', '/config/defaults')) as { field: { cars: { team: string }[] } };
    expect(cfg.field.cars.map((c) => c.team)).toContain('Ansadyne');
    expect(((await srv.handle('GET', '/experiments')) as unknown[]).length).toBeGreaterThan(0);
    expect(((await srv.handle('GET', '/sensitivity/params')) as unknown[]).length).toBeGreaterThan(0);
  });

  it('validates like the server: 422 with the failing paths, 404 for unknown runs and routes', async () => {
    const p1 = await fail(srv.handle('POST', '/runs', { masterSeed: 0 }));
    expect(p1.status).toBe(422);
    expect(p1.errors?.some((e) => e.path === 'masterSeed')).toBe(true);
    const p2 = await fail(srv.handle('POST', '/runs', { oracleBelief: true }));
    expect(p2.errors?.[0].path).toBe('oracleBelief');
    const p3 = await fail(srv.handle('POST', '/track/preview', { wetness: 3, trackTemp_C: 30, rubber: 0.02, overrides: [] }));
    expect(p3.status).toBe(422);
    const p4 = await fail(srv.handle('GET', '/track?trackId=monza'));
    expect(p4.status).toBe(422);
    expect((await fail(srv.handle('GET', '/runs/nope'))).status).toBe(404);
    expect((await fail(srv.handle('GET', '/jobs/nope'))).status).toBe(404);
    expect((await fail(srv.handle('GET', '/nowhere'))).status).toBe(404);
    const p5 = await fail(srv.handle('POST', '/sensitivity', { param: 'car.lapRef_s' }));
    expect(p5.status).toBe(422);
  });
});
