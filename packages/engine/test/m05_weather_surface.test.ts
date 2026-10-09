import { describe, expect, it } from 'vitest';
import { b1Race } from './helpers';
import { regimeDistribution } from '../src/world/weather';

describe('weather Markov controls and persistent surface', () => {
  it('forcing a state applies in every world for the chosen ticks, then the chain resumes', () => {
    const race = b1Race(21);
    for (let i = 0; i < 10; i++) race.step();
    race.inject('weather', { regime: 'damp', ticks: 6 });
    const out = race.step();
    const tick = race.env.tickAt(race.maxComputedTime());
    for (let j = tick; j < tick + 5; j++) expect(race.env.ticks[j].regime).toBe('damp');
    expect(out.laps.every((l) => l.env.forecast!.in5.length === 3)).toBe(true);
  });

  it('a new transition matrix changes the future chain and the forecasts, not the past', () => {
    const race = b1Race(22);
    for (let i = 0; i < 10; i++) race.step();
    const before = race.env.ticks.slice(0, race.env.tickAt(race.maxComputedTime()) + 1).map((t) => t.regime);
    const wetty = [
      [0.5, 0.5, 0],
      [0, 0.5, 0.5],
      [0, 0, 1],
    ];
    race.inject('weatherMatrix', { matrix: wetty });
    const out = race.step();
    expect(race.env.ticks.slice(0, before.length).map((t) => t.regime)).toEqual(before);
    expect(out.laps[0].env.matrix).toEqual(wetty);
    expect(race.env.rainProb(0).in20).toBeGreaterThan(0.9);
    expect(regimeDistribution(wetty, 0, 1)).toEqual([0.5, 0.5, 0]);
    expect(race.env.ticks.at(-1)!.regime).toBe('wet');
  });

  it('a surface set-up persists until replaced, and temporary debris never wipes it', () => {
    const race = b1Race(23);
    for (let i = 0; i < 5; i++) race.step();
    race.inject('surface', { overrides: [{ segmentId: 'S05', wetnessOffset: 0.4 }], trackTempOffset_C: 5 });
    race.step();
    race.inject('debris', { segmentId: 'S05' });
    for (let i = 0; i < 25; i++) race.step();
    // debris expired after 10 ticks; the user's wetness offset and temperature offset are still there
    expect(race.model.overrides).toEqual([{ segmentId: 'S05', wetnessOffset: 0.4 }]);
    expect(race.surface.trackTempOffset_C).toBe(5);
    const out = race.step();
    expect(out.laps[0].env.surface).toEqual({ overrides: [{ segmentId: 'S05', wetnessOffset: 0.4 }], trackTempOffset_C: 5 });
    race.inject('surface', { overrides: [], trackTempOffset_C: 0 });
    race.step();
    expect(race.model.overrides).toEqual([]);
  }, 60_000);
});
