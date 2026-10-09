import { describe, expect, it } from 'vitest';
import type { ObsHistory, Observation } from '@pitwall/shared';
import { b1Race, sharedModel } from './helpers';
import { chooseDriver } from '../src/strategy/drivers';
import { shouldCover } from '../src/strategy/rivals';

const base = { pace: [1, 1.007], minDrive_s: 2700, maxContinuous_s: 14400, remainingAfter_s: 7000, nextStint_s: 3300 };

describe('driver policy', () => {
  it('hands over to the driver who still needs time once the current one has met the minimum', () => {
    expect(chooseDriver({ ...base, current: 0, total_s: [3300, 0], continuous_s: 3300 })).toBe(1);
  });
  it('keeps the current driver while their own minimum is unmet and time allows', () => {
    expect(chooseDriver({ ...base, current: 0, total_s: [1500, 0], continuous_s: 1500 })).toBe(0);
  });
  it('switches early when the remaining minimums only just fit', () => {
    expect(chooseDriver({ ...base, current: 0, total_s: [1500, 0], continuous_s: 1500, remainingAfter_s: 3000 })).toBe(1);
  });
  it('puts the fastest driver back once every minimum is met', () => {
    expect(chooseDriver({ ...base, current: 1, total_s: [3300, 3300], continuous_s: 3300 })).toBe(0);
  });
  it('never exceeds the continuous limit', () => {
    expect(chooseDriver({ ...base, current: 0, total_s: [13000, 3000], continuous_s: 13000 })).toBe(1);
  });

  it('every classified car meets the minimum drive time and lap records name the driver', () => {
    for (const seed of [1, 4, 9]) {
      const race = b1Race(seed);
      const outs = race.runToEnd();
      const minDrive = race.model.cfg.race.rules.drivers.minDrive_s['3'];
      for (const w of race.worlds) {
        for (const c of w.cars) {
          if (!c.classified) continue;
          expect(c.driveViolation).toBe(false);
          for (const t of c.drivers.total_s) expect(t).toBeGreaterThanOrEqual(minDrive);
        }
      }
      const names = new Set(outs.flatMap((o) => o.laps.filter((l) => l.world === 'B1').flatMap((l) => l.cars.filter((c) => c.no === 12).map((c) => c.driver))));
      expect(names).toEqual(new Set(['Pro', 'Bronze']));
      expect(outs.flatMap((o) => o.events).some((e) => e.type === 'driver_change')).toBe(true);
    }
  });
});

function obs(lapsSinceStop: number, rivalStops: number, gap: number): Observation {
  return {
    step: 20, lap: 20, raceTime_s: 2140, remaining_s: 8000, clock: '14:20', flag: 'green', pitOpen: true, cautionLapsElapsed: 0,
    regime: 'dry', wetness_est: 0, trackTemp_C: 30, airTemp_C: 22, rubber_est: 0, rainProb: { in10: 0, in20: 0, in40: 0 }, overrides: [],
    ego: {
      no: 5, lastLap_s: 108, sectorTimes_s: [29, 47, 31], fuelGauge_kg: 30, compound: 'dry', tyreAgeLaps: lapsSinceStop, lapsSinceStop, tyreTemp_C: 92,
      mode: 'normal', stops: 0, position: 3, gapAhead_s: 1, gapBehind_s: 1, setsLeft: { dry: 8, wet: 5 }, lastRefuelApplied_kg: null,
      lastLapFlags: { inLap: false, outLap: false, caution: false, incident: false }, fuelUsedSinceStop_kg: 50, running: true, forcedPending: false,
    },
    rivals: [{ no: 12, position: 4, laps: 20, gap_s: gap, lastLap_s: 108, tyreAgeSinceSeenStop: 0, stops: rivalStops, inPit: rivalStops > 0, running: true, lastLapGreen: true, pittedThisCaution: false }],
  };
}

describe('reactive rivals', () => {
  const model = sharedModel();
  it('cover an undercut by a car within the window when their own window is open', () => {
    const hist: ObsHistory = { last: [obs(21, 0, 1.5)] };
    expect(shouldCover(obs(22, 1, 1.5), hist, model, 3, 0.6)).toBe(true);
  });
  it('ignore far-away stops and stay out early in their stint', () => {
    expect(shouldCover(obs(22, 1, 12), { last: [obs(21, 0, 12)] }, model, 3, 0.6)).toBe(false);
    expect(shouldCover(obs(8, 1, 1.5), { last: [obs(7, 0, 1.5)] }, model, 3, 0.6)).toBe(false);
  });
});
