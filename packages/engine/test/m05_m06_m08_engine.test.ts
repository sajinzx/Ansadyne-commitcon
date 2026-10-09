import { describe, expect, it } from 'vitest';
import type { CarLapRecord, LapEvent, StrategyId } from '@pitwall/shared';
import { buildModel } from '../src/vehicle/model';
import { Race } from '../src/sim/race';
import { zeroNoise } from '../src/rng/predraw';
import { Rng, categoricalFromU } from '../src/rng/rng';
import { rainProbTable, EnvTimeline, clockString } from '../src/world/weather';
import { predraw, predrawSizes } from '../src/rng/predraw';
import { DEFAULT_WEATHER_MATRIX } from '../src/vehicle/model';
import { laneOpenAt } from '../src/sim/step';
import { CFG, RUN, b1Race, b1Strategies, hashOf, lapEvents, ScriptedStrategy, sharedModel } from './helpers';

const SLOW = !!process.env.PITWALL_SLOW;

describe('M05 weather and environment', () => {
  it('long-run regime fractions match 81 / 11 / 8 %', () => {
    const r = new Rng(1);
    const counts = [0, 0, 0];
    let s = 0;
    for (let i = 0; i < 200_000; i++) {
      s = categoricalFromU(DEFAULT_WEATHER_MATRIX[s], r.uniform());
      counts[s]++;
    }
    const f = counts.map((c) => c / 200_000);
    expect(f[0]).toBeCloseTo(0.811, 1);
    expect(Math.abs(f[1] - 0.108)).toBeLessThan(0.01);
    expect(Math.abs(f[2] - 0.081)).toBeLessThan(0.01);
  });

  it('rain probability matches the closed-form values', () => {
    const t = rainProbTable(DEFAULT_WEATHER_MATRIX);
    expect(t[0].in10).toBeCloseTo(0.005, 3);
    expect(t[0].in20).toBeCloseTo(0.016, 3);
    expect(t[0].in40).toBeCloseTo(0.047, 3);
    expect(t[1].in10).toBeCloseTo(0.231, 3);
    expect(t[1].in20).toBeCloseTo(0.357, 3);
    expect(t[1].in40).toBeCloseTo(0.47, 2);
    expect(t[2].in20).toBe(1);
  });

  it('wetness and rubber stay in range, the clock wraps past midnight', () => {
    for (const seed of [1, 2, 3, 50, 99]) {
      const env = new EnvTimeline(predraw(seed, predrawSizes(6 * 3600, 107, 10)), DEFAULT_WEATHER_MATRIX, 107, '20:00');
      for (const e of env.ticks) {
        expect(e.w).toBeGreaterThanOrEqual(0);
        expect(e.w).toBeLessThanOrEqual(1);
        expect(e.rubber).toBeGreaterThanOrEqual(0);
        expect(e.rubber).toBeLessThanOrEqual(0.06 + 1e-12);
        expect(e.hour).toBeGreaterThanOrEqual(0);
        expect(e.hour).toBeLessThan(24);
      }
    }
    expect(clockString(23.5, 3600)).toBe('00:30');
  });
});

describe('M08 single-car deterministic race with one stop (gate 2)', () => {
  const cfg = structuredClone(CFG);
  cfg.field.cars = cfg.field.cars.filter((c) => c.no === cfg.field.ego);
  const run = { ...RUN, durationHours: 1 as const };
  const model = buildModel(cfg, run, { calibration: { cal: sharedModel().cal, geo: sharedModel().geo }, surrogate: sharedModel().surrogate });
  const pitAt = new Map([[10, { pit: true, refuel_kg: 30, tyres: 'dry' as const, driverChange: false as const, mode: 'normal' as const }]]);
  const mk = () =>
    new Race({
      run,
      configs: cfg,
      model,
      predrawTransform: zeroNoise,
      strategies: { B0: new ScriptedStrategy('B0', pitAt), B1: new ScriptedStrategy('B1', pitAt), OPT: new ScriptedStrategy('OPT', pitAt) },
    });

  it('reproduces the pit route timings and fuel accounting exactly', () => {
    const race = mk();
    const ev = lapEvents(race).filter((e) => e.world === 'B1');
    const recs = ev.flatMap((e) => e.cars);
    const inLap = recs.find((r) => r.pit?.phase === 'in')!;
    const outLap = recs.find((r) => r.pit?.phase === 'out')!;
    const L = model.lane;
    expect(inLap.lap).toBe(10);
    expect(outLap.lap).toBe(11);
    expect(inLap.pit!.t_line! - inLap.pit!.t_entry!).toBeCloseTo(L.entryLoss + L.toLine, 9);
    expect(outLap.pit!.t_box! - inLap.pit!.t_line!).toBeCloseTo(L.lineToBox, 9);
    expect(outLap.pit!.t_exit! - outLap.pit!.t_box!).toBeCloseTo(outLap.pit!.service_s! + L.boxToExit + L.exitLoss, 9);
    // zero noise: service is the base time (refuel / 2 kg/s + 16 s tyres, sequential); refuel clamped to the room in the tank
    expect(outLap.pit!.refuelApplied_kg!).toBeLessThanOrEqual(30);
    expect(outLap.pit!.service_s).toBeCloseTo(outLap.pit!.refuelApplied_kg! / 2 + 16, 9);
    expect(outLap.ego!.truth!.fuel_kg).toBeLessThanOrEqual(model.cfg.car.fuel.capacity_kg);
    const ego = race.world('B1').cars[0];
    expect(ego.stops).toBe(1);
    expect(ego.setsLeft.dry).toBe(model.tyreSets.dry - 2);
    // green laps without events are smooth: consecutive lap times differ by < 0.5 s
    const green = recs.filter((r) => !r.pit && r.lap > 2 && r.lap < 9).map((r) => r.lapTime_s);
    for (let i = 1; i < green.length; i++) expect(Math.abs(green[i] - green[i - 1])).toBeLessThan(0.5);
    // ego truth fuel never exceeds capacity
    for (const r of recs) expect(r.ego!.truth!.fuel_kg).toBeLessThanOrEqual(model.cfg.car.fuel.capacity_kg + 1e-9);
  });

  it('is identical on rerun', () => {
    expect(hashOf(lapEvents(mk()))).toBe(hashOf(lapEvents(mk())));
  });
});

function recordsBy(events: LapEvent[], world: StrategyId): CarLapRecord[] {
  return events.filter((e) => e.world === world).flatMap((e) => e.cars);
}

describe('M08 determinism, pairing and legality (gates 3–4)', () => {
  it(`identical event streams on rerun (${SLOW ? 50 : 15} seeds, B1 in all slots)`, () => {
    for (let seed = 1; seed <= (SLOW ? 50 : 15); seed++) {
      expect(hashOf(lapEvents(b1Race(seed)))).toBe(hashOf(lapEvents(b1Race(seed))));
    }
  });

  it('worlds with identical ego strategies are identical; a different ego pit leaves earlier laps untouched', () => {
    const ev = lapEvents(b1Race(42));
    const strip = (e: LapEvent) => JSON.parse(JSON.stringify(e).replace(/"world":"(B0|B1|OPT)"/g, '"world":"X"'));
    const byWorld = (id: StrategyId) => ev.filter((e) => e.world === id).map(strip);
    expect(hashOf(byWorld('B0'))).toBe(hashOf(byWorld('B1')));
    expect(hashOf(byWorld('OPT'))).toBe(hashOf(byWorld('B1')));

    const model = sharedModel();
    const strategies = b1Strategies(model);
    strategies.OPT = new ScriptedStrategy('OPT', new Map([[6, { pit: true, refuel_kg: 10, tyres: 'dry', driverChange: false, mode: 'normal' }]]));
    const ev2 = lapEvents(b1Race(42, { strategies }));
    const early = (id: StrategyId) =>
      ev2
        .filter((e) => e.world === id && e.step < 5)
        .map(strip)
        .map((e: LapEvent) => ({ ...e, cars: e.cars.map((c) => ({ ...c, ego: undefined })) }));
    expect(hashOf(early('OPT'))).toBe(hashOf(early('B1')));
  });

  it(`legality over ${SLOW ? 1000 : 60} seeds × 3 worlds`, () => {
    const model = sharedModel();
    const cap = model.cfg.car.fuel.capacity_kg;
    const splash = model.cfg.race.rules.emergencyFuelWhenClosed.splash_kg;
    let pitsChecked = 0;
    for (let seed = 1; seed <= (SLOW ? 1000 : 60); seed++) {
      const race = b1Race(seed);
      const ev = lapEvents(race);
      for (const id of ['B0', 'B1', 'OPT'] as StrategyId[]) {
        const w = race.world(id);
        const recs = recordsBy(ev, id);
        const byCar = new Map<number, CarLapRecord[]>();
        for (const r of recs) byCar.set(r.no, [...(byCar.get(r.no) ?? []), r]);
        for (const [, list] of byCar) {
          for (let i = 0; i < list.length; i++) {
            const r = list[i];
            if (r.ego?.truth) expect(r.ego.truth.fuel_kg).toBeLessThanOrEqual(cap + 1e-9);
            if (r.pit?.phase === 'in') {
              pitsChecked++;
              // lane open at the entry, or an emergency splash
              const open = w.cautionLog.every((c) => laneOpenAt(c, r.pit!.t_entry!));
              const out = list[i + 1];
              if (!open && out?.pit?.phase === 'out') {
                expect(out.pit.tyres).toBe('none');
                expect(out.pit.refuelApplied_kg!).toBeLessThanOrEqual(splash + 1e-9);
              }
            }
            if (r.pit?.phase === 'out') {
              expect(list[i - 1]?.pit?.phase).toBe('in');
            }
          }
        }
        for (const c of w.cars) {
          expect(c.setsLeft.dry).toBeGreaterThanOrEqual(0);
          expect(c.setsLeft.wet).toBeGreaterThanOrEqual(0);
          if (c.dnf) expect(['fuel', 'incident', 'failure']).toContain(c.dnf.cause);
        }
      }
    }
    expect(pitsChecked).toBeGreaterThan(100);
  });

  it('race end: every finisher is classified at its first crossing at or after the flag', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const race = b1Race(seed);
      race.runToEnd();
      for (const w of race.worlds) {
        const Tf = w.finish.T_finish_s!;
        expect(Tf).toBeGreaterThanOrEqual(race.model.cfg.race.duration_s);
        for (const c of w.cars) {
          if (c.dnf) continue;
          expect(c.classified).toBe(true);
          expect(c.crossings[c.crossings.length - 1]).toBeGreaterThanOrEqual(Tf);
          expect(c.crossings[c.crossings.length - 2]).toBeLessThan(Tf);
        }
      }
    }
  });
});

describe('M06 cautions (gate 4)', () => {
  it('no computed lap ever contains a later-declared caution start', () => {
    for (let seed = 1; seed <= 80; seed++) {
      const race = b1Race(seed);
      const outs = race.runToEnd();
      for (const w of race.worlds) {
        for (const c of w.cautionLog) {
          for (const o of outs) {
            if (o.step >= c.startStep) break;
            const le = o.laps.find((l) => l.world === w.id);
            for (const r of le?.cars ?? []) expect(r.lineCross_s).toBeLessThanOrEqual(c.t_c + 1e-9);
          }
        }
      }
    }
  });

  it('under caution nobody passes on track; the leader runs at pace, others at run-to-queue speed unless held at the queue gap', () => {
    const model = sharedModel();
    const tRun = model.cfg.race.caution.runToQueueFactor * model.lapRef;
    const tPace = model.cfg.race.caution.paceLapFactor * model.lapRef;
    const gapQ = model.cfg.race.caution.queueGap_s;
    const limp = model.cfg.car.tyres.puncture.limpLoss_s;
    let checked = 0;
    let held = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const race = b1Race(seed, { family: 'F3' });
      const outs = race.runToEnd();
      for (const o of outs) {
        const le = o.laps.find((l) => l.world === 'B1');
        if (!le) continue;
        const all = [...le.cars].sort((a, b) => a.lapStart_s - b.lapStart_s);
        const onTrack = all.filter((r) => r.running && !r.pit && r.flag === 'caution');
        for (let i = 1; i < onTrack.length; i++) expect(onTrack[i].lineCross_s).toBeGreaterThan(onTrack[i - 1].lineCross_s);
        for (let i = 1; i < all.length; i++) {
          const a = all[i - 1];
          const b = all[i];
          if (a.pit?.phase === 'in' || b.pit || b.flag !== 'caution' || !b.running) continue;
          const lt = b.lapTime_s;
          const isRun = Math.abs(lt - tRun) < 1e-6 || Math.abs(lt - tRun - limp) < 1e-6;
          const isHeld = Math.abs(b.lineCross_s - a.lineCross_s - gapQ) < 1e-6;
          expect(isRun || isHeld).toBe(true);
          if (isHeld) held++;
          checked++;
        }
        if (all[0] && all[0].flag === 'caution' && !all[0].pit && all[0].running) {
          const lt = all[0].lapTime_s;
          expect(Math.abs(lt - tPace) < 1e-6 || Math.abs(lt - tPace - limp) < 1e-6).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(held).toBeGreaterThan(10);
  });

  it('forced family cautions start at the same step in every world', () => {
    for (const fam of ['F2', 'F3', 'F4', 'F10']) {
      const race = b1Race(7, { family: fam });
      race.runToEnd();
      const forced = race.worlds.map((w) => w.cautionLog.filter((c) => c.cause === 'injected').map((c) => c.startStep));
      expect(forced[0].length).toBeGreaterThan(0);
      expect(forced[1]).toEqual(forced[0]);
      expect(forced[2]).toEqual(forced[0]);
    }
  });

  it('injected caution, rain and fuel spike apply in all worlds at the same step', () => {
    const race = b1Race(11);
    for (let i = 0; i < 20; i++) race.step();
    race.inject('caution');
    race.inject('rain');
    race.inject('fuelSpike');
    race.step();
    for (const w of race.worlds) {
      expect(w.cautionLog.some((c) => c.cause === 'injected' && c.startStep === 20)).toBe(true);
    }
    expect(race.injections.map((i) => i.step)).toEqual([20, 20, 20]);
    const tick = race.env.tickAt(race.maxComputedTime());
    expect(race.env.ticks[tick + 3].regime).toBe('wet');
  });
});
