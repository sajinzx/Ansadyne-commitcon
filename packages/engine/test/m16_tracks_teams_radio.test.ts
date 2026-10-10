// Circuits, team names and the always-on team radio.
import { describe, expect, it } from 'vitest';
import { RunConfigSchema, TRACK_IDS, applyTrack, defaultConfigs, defaultRunConfig, trackList } from '@pitwall/shared';
import type { RadioMessage } from '@pitwall/shared';
import { buildModel } from '../src/vehicle/model';
import { TrackGeometry } from '../src/track/geometry';
import { Race } from '../src/sim/race';
import { Estimator } from '../src/estimator/ekf';
import { B0Strategy, b0Plan } from '../src/strategy/b0';
import { B1Strategy, defaultB1Options } from '../src/strategy/b1';
import { OptStrategy } from '../src/strategy/opt';
import { RaceSession, type FromSession } from '../src/runtime/raceSession';
import { runJobTask, type JobMessage } from '../src/runtime/jobs';

describe('circuits', () => {
  it('the track list has the five circuits with their real lengths', () => {
    const list = trackList();
    expect(list.map((t) => t.id)).toEqual([...TRACK_IDS]);
    const len = Object.fromEntries(list.map((t) => [t.id, t.lapLength_m]));
    expect(len).toEqual({ daytona: 5730, sebring: 6021, 'road-atlanta': 4088, 'watkins-glen': 5472, spa: 7004 });
  });

  it('every circuit config is consistent: segments tile the lap, sectors cover it, the outline closes', () => {
    for (const id of TRACK_IDS) {
      const cfg = applyTrack(defaultConfigs(), id);
      const t = cfg.track;
      const L = t.lapLength_m.value;
      expect(t.segments[0].start_m).toBe(0);
      expect(t.segments.at(-1)!.end_m).toBe(L);
      for (let i = 1; i < t.segments.length; i++) expect(t.segments[i].start_m).toBe(t.segments[i - 1].end_m);
      expect(t.sectors[0].from_m).toBe(0);
      expect(t.sectors.at(-1)!.to_m).toBe(L);
      for (let i = 1; i < t.sectors.length; i++) expect(t.sectors[i].from_m).toBe(t.sectors[i - 1].to_m);
      expect(t.pitLane.entry_s_m).toBeGreaterThan(L / 2);
      expect(t.pitLane.exit_s_m).toBeLessThan(L / 2);
      const geo = new TrackGeometry(t);
      const a = geo.xyAt(0);
      const b = geo.xyAt(L - 0.01);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(2);
      const pay = geo.payload();
      for (const p of pay.centerline) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1000);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(620);
      }
    }
  });

  it('per-lap quantities scale with lap length; Daytona is unchanged', () => {
    const base = defaultConfigs();
    expect(applyTrack(defaultConfigs(), 'daytona')).toEqual(base);
    const spa = applyTrack(defaultConfigs(), 'spa');
    const r = 7004 / 5730;
    expect(spa.car.fuel.qBase_kg_per_lap).toBeCloseTo(base.car.fuel.qBase_kg_per_lap * r, 9);
    expect(spa.car.tyres.dry.kBase_per_lap).toBeCloseTo(base.car.tyres.dry.kBase_per_lap * r, 9);
    expect(spa.race.caution.background_per_lap).toBeCloseTo(base.race.caution.background_per_lap * r, 9);
    expect(spa.car.lapRef_s.value).toBe(137.8);
    expect(spa.car.lapRef_s.provenance).toBe('FITTED');
    expect(() => applyTrack(defaultConfigs(), 'monza')).toThrow(/unknown track/);
  });

  it('the run schema accepts the circuit ids and rejects others', () => {
    for (const id of TRACK_IDS) expect(RunConfigSchema.safeParse({ ...defaultRunConfig(), trackId: id }).success).toBe(true);
    expect(RunConfigSchema.safeParse({ ...defaultRunConfig(), trackId: 'monza' }).success).toBe(false);
  });

  it(
    'each circuit calibrates to its FITTED reference lap with a plausible peak friction',
    () => {
      for (const id of TRACK_IDS) {
        const m = buildModel(defaultConfigs(), defaultRunConfig({ trackId: id }));
        expect(m.cal.reference.lapTime).toBeCloseTo(m.lapRef, 1);
        expect(m.cal.muPeak).toBeGreaterThan(1.2);
        expect(m.cal.muPeak).toBeLessThan(1.8);
        expect(m.cal.physics.topSpeed_kph).toBeGreaterThan(240);
        expect(m.cal.physics.topSpeed_kph).toBeLessThan(310);
      }
    },
    120_000,
  );

  it(
    'a full 1-hour race with B0, B1 and OPT runs on every circuit and classifies the field',
    () => {
      for (const id of TRACK_IDS) {
        const run = defaultRunConfig({ trackId: id, durationHours: 1, masterSeed: 77 });
        const configs = defaultConfigs();
        const model = buildModel(configs, run);
        const b0 = b0Plan(model);
        const race = new Race({
          configs,
          model,
          run,
          estimatorFactory: (m) => new Estimator(m),
          strategies: { B0: new B0Strategy(b0), B1: new B1Strategy(defaultB1Options(model)), OPT: new OptStrategy({ initialPlan: b0 }) },
        });
        while (!race.finished && race.k < 2000) race.step();
        expect(race.finished).toBe(true);
        const res = race.results();
        for (const w of ['B0', 'B1', 'OPT'] as const) {
          expect(res[w].finalPos).toBeGreaterThanOrEqual(1);
          expect(res[w].finalPos).toBeLessThanOrEqual(10);
          // laps in an hour follow the circuit's lap time (within caution and pit losses)
          expect(res[w].laps).toBeGreaterThan(3600 / model.lapRef - 8);
          expect(res[w].laps).toBeLessThanOrEqual(Math.ceil(3600 / model.lapRef) + 1);
        }
      }
    },
    240_000,
  );
});

describe('teams', () => {
  it('our car is Ansadyne and the nine rivals carry distinct F1 team names', () => {
    const f = defaultConfigs().field;
    const ego = f.cars.find((c) => c.no === f.ego)!;
    expect(ego.team).toBe('Ansadyne');
    const rivals = f.cars.filter((c) => c.no !== f.ego).map((c) => c.team);
    expect(rivals).toHaveLength(9);
    expect(new Set(rivals).size).toBe(9);
    expect(rivals).toEqual(expect.arrayContaining(['McLaren', 'Mercedes', 'Red Bull Racing', 'Ferrari', 'Williams', 'Racing Bulls', 'Aston Martin', 'Haas', 'Audi']));
    for (const c of f.cars) expect(c.code).toMatch(/^[A-Z]{3}$/);
  });
});

describe('team radio is live from the start', () => {
  it('a race session streams a lights-out call at the green flag and a status call every 5 laps, naming the cars around us', async () => {
    const out: FromSession[] = [];
    const session = new RaceSession(
      (m) => out.push(m),
      () => Promise.resolve(),
    );
    session.handle({ type: 'init', runId: 't', config: defaultRunConfig({ durationHours: 1, trackId: 'road-atlanta' }) });
    expect(out[0].type).toBe('ready');
    for (let i = 0; i < 12; i++) session.handle({ type: 'control', action: 'step' });
    await new Promise((r) => setTimeout(r, 50));
    while (!out.some((m) => m.type === 'messages' && m.step >= 11)) await new Promise((r) => setTimeout(r, 20));
    const radio = out.flatMap((m) => (m.type === 'messages' ? m.msgs.filter((x) => x.type === 'radio').map((x) => x.payload as RadioMessage) : []));
    for (const w of ['B0', 'B1', 'OPT'] as const) {
      const mine = radio.filter((r) => r.world === w);
      const start = mine.find((r) => r.title.startsWith('Lights out'));
      expect(start, `${w} lights out`).toBeDefined();
      expect(start!.title).toContain('Ansadyne');
      expect(start!.raceTime_s).toBeLessThan(10); // the green flag (grid stagger), not the end of lap 1
      const status = mine.filter((r) => r.kind === 'status' && /^Lap \d+/.test(r.title));
      expect(status.map((r) => r.lap)).toEqual(expect.arrayContaining([5, 10]));
      expect(status.some((r) => /(McLaren|Mercedes|Red Bull Racing|Ferrari|Williams|Racing Bulls|Aston Martin|Haas|Audi) #\d+ (ahead|behind)/.test(r.text))).toBe(true);
    }
  }, 60_000);

  it('the job runner runs a bench chunk on another circuit and reports each seed', () => {
    const msgs: JobMessage[] = [];
    runJobTask({ kind: 'benchChunk', items: [{ family: 'F5', seed: 3 }], rounds: [50], durationHours: 1, trackId: 'spa' }, (m) => msgs.push(m));
    const prog = msgs.filter((m) => m.type === 'progress');
    expect(prog).toHaveLength(1);
    expect(msgs.at(-1)!.type).toBe('done');
  }, 60_000);
});
