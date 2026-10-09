// M08 §8.4 — what the pit wall can see. Truth → Observation (noisy fuel gauge, estimated wetness).
import type { Observation } from '@pitwall/shared';
import type { ModelBundle } from '../vehicle/model';
import type { Predraw } from '../rng/predraw';
import type { EnvTimeline } from '../world/weather';
import type { WorldTruth, CarTruth } from './world';
import { cautionAt, laneOpenAt } from './step';
import { nominalBurn } from '../vehicle/fuel';

export function observe(w: WorldTruth, car: CarTruth, k: number, model: ModelBundle, pd: Predraw, env: EnvTimeline): Observation {
  const t = car.lapStart_s;
  const e = env.at(t);
  const cs = w.caution;
  const caution = cautionAt(cs, t);
  const rp = env.rainProb(e.regimeIdx);
  const kk = Math.min(k, pd.sizes.K - 1);
  const gauge = car.fuel_kg + model.cfg.car.fuel.gaugeNoise_kg * pd.gaugeN.get(car.idx, kk);
  const last = car.lastLap;
  return {
    step: k,
    lap: car.laps,
    raceTime_s: t,
    remaining_s: model.cfg.race.duration_s - t,
    clock: env.clock(t),
    flag: caution ? 'caution' : 'green',
    pitOpen: laneOpenAt(cs, t),
    cautionLapsElapsed: cs && caution ? cs.leaderCrossings : 0,
    regime: e.regime,
    wetness_est: Math.max(0, Math.min(1, e.w + 0.03 * pd.wetObsN.get(kk))),
    trackTemp_C: e.trackTemp,
    airTemp_C: e.airTemp,
    rubber_est: e.rubber,
    rainProb: { in10: rp.in10, in20: rp.in20, in40: rp.in40 },
    overrides: model.overrides,
    ego: {
      no: car.no,
      lastLap_s: car.lastLapTime_s,
      sectorTimes_s: last ? last.sectorTimes_s : [0, 0, 0],
      fuelGauge_kg: Math.max(0, gauge),
      compound: car.compound,
      tyreAgeLaps: car.tyreAgeLaps,
      lapsSinceStop: car.lapsSinceStop,
      tyreTemp_C: car.tyreTemp_C,
      mode: car.mode,
      stops: car.stops,
      position: car.position,
      gapAhead_s: car.gapAhead_s,
      gapBehind_s: car.gapBehind_s,
      setsLeft: { ...car.setsLeft },
      lastRefuelApplied_kg: car.lastRefuelApplied_kg,
      lastLapFlags: { ...car.lastLapFlags },
      fuelUsedSinceStop_kg: car.lapsSinceStop * nominalBurn(model.cfg.car),
      running: car.running && !car.classified,
      forcedPending: car.forced.length > 0,
    },
    rivals: w.cars
      .filter((c) => c.no !== car.no)
      .map((c) => ({
        no: c.no,
        position: c.position,
        laps: c.laps,
        gap_s: c.lapStart_s - t,
        lastLap_s: c.lastLapTime_s,
        tyreAgeSinceSeenStop: c.lapsSinceStop,
        stops: c.stops,
        inPit: !!c.pendingOutLap,
        running: c.running && !c.classified,
        lastLapGreen: !!c.lastLap && c.lastLap.flag === 'green' && !c.lastLapFlags.inLap && !c.lastLapFlags.outLap,
        pittedThisCaution: c.pittedThisCaution,
      })),
  };
}
