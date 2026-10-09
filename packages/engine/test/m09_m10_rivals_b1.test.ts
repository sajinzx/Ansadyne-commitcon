import { describe, expect, it } from 'vitest';
import type { Observation } from '@pitwall/shared';
import { b1Decide, defaultB1Options, projectNextStop } from '../src/strategy/b1';
import { makeRivalPolicy } from '../src/strategy/rivals';
import { CFG, sharedModel, b1Race } from './helpers';

function obs(over: Partial<Observation['ego']> = {}, top: Partial<Observation> = {}): Observation {
  return {
    step: 10,
    lap: 10,
    raceTime_s: 1070,
    remaining_s: 9730,
    clock: '14:00',
    flag: 'green',
    pitOpen: true,
    cautionLapsElapsed: 0,
    regime: 'dry',
    wetness_est: 0,
    trackTemp_C: 30,
    airTemp_C: 22,
    rubber_est: 0,
    rainProb: { in10: 0.005, in20: 0.016, in40: 0.047 },
    overrides: [],
    ego: {
      no: 12,
      lastLap_s: 107,
      sectorTimes_s: [29, 47, 31],
      fuelGauge_kg: 50,
      compound: 'dry',
      tyreAgeLaps: 10,
      lapsSinceStop: 10,
      tyreTemp_C: 92,
      mode: 'normal',
      stops: 0,
      position: 5,
      gapAhead_s: 2,
      gapBehind_s: 2,
      setsLeft: { dry: 8, wet: 5 },
      lastRefuelApplied_kg: null,
      lastLapFlags: { inLap: false, outLap: false, caution: false, incident: false },
      fuelUsedSinceStop_kg: 26.5,
      running: true,
      forcedPending: false,
      ...over,
    },
    rivals: [],
    ...top,
  };
}

describe('M09 field and rivals', () => {
  it('field has exactly one ego and grid slots are a permutation of 1–10', () => {
    const cars = CFG.field.cars;
    expect(cars.filter((c) => c.archetype === 'ego').map((c) => c.no)).toEqual([CFG.field.ego]);
    expect(cars.map((c) => c.grid).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('fixedStint rivals stop every 29 laps at defaults', () => {
    const p = makeRivalPolicy('fixedStint', sharedModel(), [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(p.decide(obs({ lapsSinceStop: 27, fuelGauge_kg: 70 }), { last: [] }).pit).toBe(false);
    expect(p.decide(obs({ lapsSinceStop: 28, fuelGauge_kg: 70 }), { last: [] }).pit).toBe(true);
  });

  it('rivals on the grid start in grid order, our car takes its slot', () => {
    const race = b1Race(1, { run: { egoGridSlot: 2 } });
    const w = race.world('B1');
    const ego = w.cars.find((c) => c.no === 12)!;
    expect(ego.lapStart_s).toBeCloseTo(0.6, 9);
  });
});

describe('M10 B1 rules', () => {
  const model = sharedModel();
  const opt = defaultB1Options(model);
  it('stays out with plenty of fuel and fresh tyres', () => {
    expect(b1Decide(obs(), { last: [] }, model, opt).rule).toBeNull();
  });
  it('fuel rule fires when the car cannot do another lap and reach the box after it', () => {
    expect(b1Decide(obs({ fuelGauge_kg: 7 }), { last: [] }, model, opt).rule).toBe('fuel');
  });
  it('does not stop for fuel when the car can reach the flag', () => {
    expect(b1Decide(obs({ fuelGauge_kg: 7 }, { remaining_s: 100 }), { last: [] }, model, opt).rule).toBeNull();
  });
  it('caution rule fires when the lane is open and enough fuel has been used', () => {
    const o = obs({ fuelUsedSinceStop_kg: 40 }, { flag: 'caution', pitOpen: true });
    expect(b1Decide(o, { last: [] }, model, opt).rule).toBe('caution');
    expect(b1Decide({ ...o, pitOpen: false }, { last: [] }, model, opt).rule).toBeNull();
  });
  it('weather rules switch to wets above 0.30 and back after 3 dry readings', () => {
    expect(b1Decide(obs({}, { wetness_est: 0.35 }), { last: [] }, model, opt).rule).toBe('wetIn');
    const dryObs = obs({ compound: 'wet' }, { wetness_est: 0.1 });
    expect(b1Decide(dryObs, { last: [dryObs, dryObs] }, model, opt).rule).toBe('wetOut');
  });
  it('wear rule fires on old tyres; never pits on an out-lap', () => {
    expect(b1Decide(obs({ tyreAgeLaps: 60, fuelGauge_kg: 70 }), { last: [] }, model, opt).rule).toBe('wear');
    const outLapNext = obs({ fuelGauge_kg: 7, lastLapFlags: { inLap: true, outLap: false, caution: false, incident: false } });
    expect(b1Decide(outLapNext, { last: [] }, model, opt).action.pit).toBe(false);
  });
  it('projects the next stop from fuel and wear', () => {
    const n = projectNextStop(obs({ fuelGauge_kg: 30 }), model, opt);
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(12);
  });
});
