// M12 §12.4–12.6 — rollout worlds built from observations and beliefs only (never the engine's truth),
// common random numbers across candidates, and per-path finishing positions.
import type { Belief, Compound, Mode, ObsHistory, Observation, Plan } from '@pitwall/shared';
import type { ModelBundle } from '../vehicle/model';
import { surrogateLap } from '../vehicle/model';
import { Rng } from '../rng/rng';
import { cholesky } from '../estimator/ekf';
import { sCar, newTyreTemp, wearRate, punctureProb, massRef } from '../vehicle/tyre';
import { sTrack } from '../track/surface';
import { netPitLoss, expectedService, fuelAtBox } from '../sim/pit';
import { categoricalFromU } from '../rng/rng';
import { stationarySd } from '../stochastic/ou';
import { chooseDriver, otherDriverNeed, driverStopDue } from '../strategy/drivers';

export interface RivalCautionStats {
  [no: number]: { pitted: number; stayed: number };
}

/** Everything a rollout needs, built from the observation, history and belief (fixes A05). */
export interface RolloutWorld {
  model: ModelBundle;
  N: number;
  H: number;
  lap0: number; // laps completed at the decision point
  t0: number; // race time at the decision point
  duration: number;
  egoNo: number;
  egoPace: number;
  egoGrip: number;
  egoWetSkill: number;
  egoWearMult: number;
  egoBurnMult: number;
  compound0: Compound;
  tyreAge0: number;
  tyreTemp0: number;
  sets0: { dry: number; wet: number };
  regime0: number;
  wet0: number;
  trackTemp: number;
  airTemp: number;
  rubber: number;
  cautionActive0: boolean;
  cautionLapsElapsed0: number;
  pitOpen0: boolean;
  nextIsOutLap: boolean;
  forcedPending: boolean;
  lapsToFlag: number;
  /** our driver line-up state (pace factors, who drives, drive-time bookkeeping) */
  drivers: { pace: number[]; current: number; total_s: number[]; continuous_s: number; minDrive_s: number; maxContinuous_s: number } | null;
  // hidden ego state per path
  F: Float64Array;
  xi: Float64Array;
  eta: Float64Array;
  bY: Float64Array;
  W: Float64Array;
  zeta: Float64Array;
  bZ: Float64Array;
  // rivals
  rivals: {
    no: number;
    t0: number;
    lapsDelta: number;
    paceMean: number;
    paceSd: number;
    lapsIntoStint: number;
    pCautionPit: number;
    running: boolean;
  }[];
  // futures (common random numbers), [path * H + lap]
  fut: {
    weatherU: Float64Array;
    cautionU: Float64Array;
    cautionDurU: Float64Array;
    n1: Float64Array;
    n2: Float64Array;
    n3: Float64Array;
    eps: Float64Array;
    trafficU: Float64Array;
    trafficE: Float64Array;
    incidentU: Float64Array;
    retireU: Float64Array;
    punctureU: Float64Array;
    rivalZ: Float64Array; // [path * H * R + lap * R + r]
    rivalWindowU: Float64Array; // [path * R + r]
    rivalCautionU: Float64Array; // [path * H * R + lap * R + r]
  };
}

const regimeIndex = (r: string) => (r === 'dry' ? 0 : r === 'damp' ? 1 : 2);

export function rivalPaceFromHistory(obs: Observation, history: ObsHistory, no: number, fallback: number): { mean: number; sd: number } {
  const laps: number[] = [];
  for (const o of [...history.last, obs]) {
    const r = o.rivals.find((x) => x.no === no);
    if (r && r.lastLapGreen && r.lastLap_s > 60 && r.lastLap_s < 300) laps.push(r.lastLap_s);
  }
  const recent = laps.slice(-5);
  if (recent.length < 2) return { mean: fallback, sd: 0.4 };
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const sd = Math.sqrt(recent.reduce((a, b) => a + (b - mean) ** 2, 0) / (recent.length - 1));
  return { mean, sd: Math.max(0.2, Math.min(1.5, sd)) };
}

/** Build a rollout world of N paths over H laps from the observation, history and belief only. */
export function sampleWorld(
  obs: Observation,
  history: ObsHistory,
  belief: Belief,
  model: ModelBundle,
  rng: Rng,
  N: number,
  H: number,
  cautionStats: RivalCautionStats = {},
): RolloutWorld {
  const cfg = model.cfg;
  const field = cfg.field.cars.find((c) => c.no === obs.ego.no)!;
  const R = obs.rivals.length;
  // hidden state draws (joint Gaussian from the belief covariances)
  const Lg = cholesky(belief.gripCov);
  const Lf = cholesky(belief.fuelCov);
  const F = new Float64Array(N);
  const xi = new Float64Array(N);
  const eta = new Float64Array(N);
  const bY = new Float64Array(N);
  const W = new Float64Array(N);
  const zeta = new Float64Array(N);
  const bZ = new Float64Array(N);
  for (let p = 0; p < N; p++) {
    const zg = [rng.normal(), rng.normal(), rng.normal(), rng.normal()];
    const zf = [rng.normal(), rng.normal(), rng.normal()];
    const g = belief.gripMean.map((m, i) => m + Lg[i].reduce((s, v, j) => s + v * zg[j], 0));
    const f = belief.fuelMean.map((m, i) => m + Lf[i].reduce((s, v, j) => s + v * zf[j], 0));
    xi[p] = g[0];
    eta[p] = g[1];
    bY[p] = g[2];
    W[p] = Math.max(0, Math.min(1, g[3]));
    F[p] = Math.max(0, f[0]);
    zeta[p] = f[1];
    bZ[p] = f[2];
  }
  const NH = N * H;
  const vec = (n: number, kind: 'u' | 'n' | 'e') => {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = kind === 'u' ? rng.uniform() : kind === 'n' ? rng.normal() : rng.exponential1();
    return a;
  };
  const fut = {
    weatherU: vec(NH, 'u'),
    cautionU: vec(NH, 'u'),
    cautionDurU: vec(NH, 'u'),
    n1: vec(NH, 'n'),
    n2: vec(NH, 'n'),
    n3: vec(NH, 'n'),
    eps: vec(NH, 'n'),
    trafficU: vec(NH, 'u'),
    trafficE: vec(NH, 'e'),
    incidentU: vec(NH, 'u'),
    retireU: vec(NH, 'u'),
    punctureU: vec(NH, 'u'),
    rivalZ: vec(NH * R, 'n'),
    rivalWindowU: vec(N * R, 'u'),
    rivalCautionU: vec(NH * R, 'u'),
  };
  const tLapGuess = obs.ego.lastLap_s > 60 && obs.ego.lastLap_s < 300 && !obs.ego.lastLapFlags.caution ? obs.ego.lastLap_s : model.lapRef;
  const rivals = obs.rivals.map((r) => {
    const pace = rivalPaceFromHistory(obs, history, r.no, model.lapRef);
    const st = cautionStats[r.no] ?? { pitted: 0, stayed: 0 };
    return {
      no: r.no,
      t0: obs.raceTime_s + r.gap_s,
      lapsDelta: r.laps - obs.lap,
      paceMean: pace.mean,
      paceSd: pace.sd,
      lapsIntoStint: r.tyreAgeSinceSeenStop,
      pCautionPit: (1 + st.pitted) / (2 + st.pitted + st.stayed),
      running: r.running,
    };
  });
  return {
    model,
    N,
    H,
    lap0: obs.lap,
    t0: obs.raceTime_s,
    duration: cfg.race.duration_s,
    egoNo: obs.ego.no,
    egoPace: field.paceFactor,
    egoGrip: field.gripSkill,
    egoWetSkill: field.wetSkill,
    egoWearMult: field.wearMult,
    egoBurnMult: field.burnMult,
    compound0: obs.ego.compound,
    tyreAge0: obs.ego.tyreAgeLaps,
    tyreTemp0: obs.ego.tyreTemp_C,
    sets0: { ...obs.ego.setsLeft },
    regime0: regimeIndex(obs.regime),
    wet0: obs.wetness_est,
    trackTemp: obs.trackTemp_C,
    airTemp: obs.airTemp_C,
    rubber: obs.rubber_est,
    cautionActive0: obs.flag === 'caution',
    cautionLapsElapsed0: obs.cautionLapsElapsed,
    pitOpen0: obs.pitOpen,
    nextIsOutLap: obs.ego.lastLapFlags.inLap,
    forcedPending: obs.ego.forcedPending,
    lapsToFlag: Math.ceil(Math.max(0, obs.remaining_s) / tLapGuess) + 1,
    drivers: obs.ego.drivers
      ? {
          pace: obs.ego.drivers.lineup.map((d) => d.pace),
          current: obs.ego.drivers.current,
          total_s: [...obs.ego.drivers.total_s],
          continuous_s: obs.ego.drivers.continuous_s,
          minDrive_s: obs.ego.drivers.minDrive_s,
          maxContinuous_s: obs.ego.drivers.maxContinuous_s,
        }
      : null,
    F,
    xi,
    eta,
    bY,
    W,
    zeta,
    bZ,
    rivals,
    fut,
  };
}

/** A candidate's plan as followed inside rollouts. Laps are absolute lap numbers (1-based). */
export interface RolloutPlan {
  stops: { lap: number; refuel: 'helper' | number; tyres: 'none' | Compound | 'auto' }[];
  mode: { mode: Mode; untilLap: number } | null;
}

export function toRolloutPlan(plan: Plan): RolloutPlan {
  return { stops: plan.stops.map((s) => ({ lap: s.lap, refuel: s.refuel, tyres: s.tyres })), mode: plan.mode };
}

export interface RolloutResult {
  pos: Float64Array; // finishing position per path (1..10, fail = 11 + fraction)
  fail: Uint8Array;
}

/**
 * Roll out a candidate plan on paths [from, to). Results are written into `out` at the path index.
 * Deterministic given the world (all randomness comes from the pre-generated futures).
 */
export function rollout(world: RolloutWorld, plan: RolloutPlan, from: number, to: number, out: RolloutResult): void {
  const m = world.model;
  const cfg = m.cfg;
  const car = cfg.car;
  const race = cfg.race;
  const H = world.H;
  const R = world.rivals.length;
  const lane = m.lane;
  const L = m.lapLength;
  const entryFrac = lane.entryS / L;
  const P = m.weatherMatrix;
  const tPace = race.caution.paceLapFactor * m.lapRef;
  const tRun = race.caution.runToQueueFactor * m.lapRef;
  const gapQ = race.caution.queueGap_s;
  const cap = car.fuel.capacity_kg;
  const qBase = car.fuel.qBase_kg_per_lap;
  const mDry = car.mass_dry_kg.value;
  const mRef = massRef(car);
  const mp = m.multipliers;
  const aX = Math.exp(-mp.X.kappa);
  const aY = Math.exp(-mp.Y.kappa);
  const aZ = Math.exp(-mp.Z.kappa);
  const sX = mp.X.sigma * Math.sqrt((1 - Math.exp(-2 * mp.X.kappa)) / (2 * mp.X.kappa));
  const sY = mp.Y.sigma * Math.sqrt((1 - Math.exp(-2 * mp.Y.kappa)) / (2 * mp.Y.kappa));
  const sZ = mp.Z.sigma * Math.sqrt((1 - Math.exp(-2 * mp.Z.kappa)) / (2 * mp.Z.kappa));
  const rho = mp.rhoXY;
  const rho2 = Math.sqrt(1 - rho * rho);
  const netGreenFull = netPitLoss(m, expectedService(m, 60, 'dry'), m.lapRef, false);
  const netCautionFull = netPitLoss(m, expectedService(m, 60, 'dry'), tPace, true);
  const durKeys = Object.keys(race.caution.durationLaps).map(Number);
  const durProbs = durKeys.map((d) => race.caution.durationLaps[String(d)]);
  const classRange = Math.floor((cap - qBase) / qBase);
  const totalLapsEst = Math.max(1, Math.round(world.duration / m.lapRef));
  const stopsSorted = [...plan.stops].sort((a, b) => a.lap - b.lap);
  const lastExplicit = stopsSorted.length ? stopsSorted[stopsSorted.length - 1].lap : -1;
  const th = cfg.planner.b1;

  const T = new Float64Array(R + 1);
  const Tn = new Float64Array(R + 1);
  const laps = new Float64Array(R + 1);
  const stint = new Float64Array(R);
  const win = new Float64Array(R);
  const order: number[] = [];
  const pitted = new Uint8Array(R + 1);
  const rivalCautionPitted = new Uint8Array(R);
  const driveTot = new Float64Array(8);
  const pCover = 0.6; // share of nearby rivals that cover an undercut (reactive and aggressive archetypes)

  for (let p = from; p < to; p++) {
    // ---- per-path initial state
    let F = world.F[p];
    let xi = world.xi[p];
    let eta = world.eta[p];
    const bY = world.bY[p];
    let W = world.W[p];
    let zeta = world.zeta[p];
    const bZ = world.bZ[p];
    let compound: Compound = world.compound0;
    let tyreAge = world.tyreAge0;
    let tyreTemp = world.tyreTemp0;
    const sets = { ...world.sets0 };
    let regime = world.regime0;
    let w = world.wet0;
    let cautionLeft = world.cautionActive0 ? Math.max(1, 3 - world.cautionLapsElapsed0) : 0;
    let cautionElapsed = world.cautionActive0 ? world.cautionLapsElapsed0 : 0;
    let greenSince = 10;
    let outLap = world.nextIsOutLap;
    let forced = world.forcedPending;
    let fuelUsed = 0;
    let failed = false;
    let failLap = 0;
    let flagT = -1;
    T[0] = world.t0;
    laps[0] = world.lap0;
    for (let r = 0; r < R; r++) {
      const rv = world.rivals[r];
      T[r + 1] = rv.t0;
      laps[r + 1] = world.lap0 + rv.lapsDelta;
      stint[r] = rv.lapsIntoStint;
      win[r] = classRange - 2 + 4 * world.fut.rivalWindowU[p * R + r];
      rivalCautionPitted[r] = 0;
    }
    let lastEgoLap = m.lapRef;
    let si = 0;
    const drv = world.drivers;
    let driver = drv ? drv.current : 0;
    if (drv) for (let d = 0; d < drv.total_s.length; d++) driveTot[d] = drv.total_s[d];
    let driveCont = drv ? drv.continuous_s : 0;
    let egoPittedGreen = false;

    for (let i = 0; i < H; i++) {
      const fi = p * H + i;
      const lapNo = world.lap0 + 1 + i; // the lap about to be run (1-based)
      // ---- environment
      regime = categoricalFromU(P[regime], world.fut.weatherU[fi]);
      const rain = regime === 0 ? 0 : regime === 1 ? 0.25 : 1;
      w = Math.max(0, Math.min(1, w + 0.12 * rain - 0.06 * (world.trackTemp / 30) * w * (rain === 0 ? 1 : 0.3)));
      // ---- caution
      let caution = false;
      if (cautionLeft > 0) {
        caution = true;
        cautionElapsed++;
        cautionLeft--;
        if (cautionLeft === 0) greenSince = 0;
      } else {
        greenSince++;
        const pc = race.caution.background_per_lap * (1 + race.caution.wetMultiplier * w);
        if (greenSince > race.caution.minGreenLapsBetween && world.fut.cautionU[fi] < pc) {
          const dur = durKeys[categoricalFromU(durProbs, world.fut.cautionDurU[fi])];
          caution = true;
          cautionElapsed = 1;
          cautionLeft = dur - 1;
          for (let r = 0; r < R; r++) rivalCautionPitted[r] = 0;
        }
      }
      const laneOpen = !caution || cautionElapsed > race.rules.pitClosedFirstCautionLaps.value;

      // ---- our car: decide
      const mode: Mode = plan.mode && lapNo <= plan.mode.untilLap ? plan.mode.mode : 'normal';
      const Z = Math.exp(bZ + zeta);
      const mStart = mDry + F;
      const qG = qBase * Math.exp(bZ + zeta) * world.egoBurnMult * car.modes[mode].burnFactor * Math.pow(mStart / mRef, car.fuel.massExponent);
      const q = qG * (caution ? car.fuel.cautionBurnFactor : 1);
      void Z;
      let pit = false;
      let pitTyres: 'none' | Compound = 'none';
      let refuel = 0;
      if (!failed && !outLap) {
        const lapsToGo = Math.max(1, world.lapsToFlag - i);
        const canFinish = F >= q + qG * (lapsToGo - 1);
        // explicit stops in order; a stop the lane refused is retried for up to 2 laps
        while (si < stopsSorted.length && stopsSorted[si].lap < lapNo - 2) si++;
        const stop = si < stopsSorted.length && stopsSorted[si].lap <= lapNo ? stopsSorted[si] : undefined;
        const wantWet = w >= 0.3;
        const swapNeeded = (compound === 'dry' && w > 0.5) || (compound === 'wet' && w < 0.1 && i > 2);
        if (stop) {
          pit = true;
          pitTyres = stop.tyres === 'none' ? 'none' : stop.tyres === 'auto' ? (wantWet ? 'wet' : 'dry') : stop.tyres;
          refuel = stop.refuel === 'helper' ? -1 : stop.refuel;
        } else if (si >= stopsSorted.length && lapNo > lastExplicit) {
          // base policy after the plan's explicit stops: B1 rules on the path's state
          const Wb = tyreAge * car.tyres[compound].kBase_per_lap;
          const need = drv && drv.pace.length > 1 ? otherDriverNeed(driveTot.subarray(0, drv.pace.length), driver, drv.minDrive_s) : 0;
          const remainingNow = world.duration - T[0];
          const ownMet = !drv || driveTot[driver] >= drv.minDrive_s;
          if (need > 0 && (driverStopDue(remainingNow, need, m.lapRef) || (caution && laneOpen && ownMet && remainingNow > need + 2 * m.lapRef))) {
            pit = true;
            pitTyres = Wb >= th.cautionTyreWear ? (wantWet ? 'wet' : 'dry') : 'none';
          } else if (compound === 'dry' && w >= th.wetIn && sets.wet > 0 && lapsToGo > 1) {
            // B1's wet-in rule: slicks off at the wetness threshold, not only when they are undriveable
            pit = true;
            pitTyres = 'wet';
          } else if (compound === 'wet' && w <= th.wetOut && i > 2 && sets.dry > 0 && lapsToGo > 3) {
            pit = true;
            pitTyres = 'dry';
          } else if (!canFinish && F - q - qG * entryFrac < car.fuel.reserveLaps * qG) {
            pit = true;
            pitTyres = Wb >= th.fuelTyreWear ? (wantWet ? 'wet' : 'dry') : 'none';
          } else if (caution && laneOpen && lapsToGo > 6 && (fuelUsed >= th.cautionFuelUsed * cap || Wb >= th.cautionWear)) {
            pit = true;
            pitTyres = Wb >= th.cautionTyreWear ? (wantWet ? 'wet' : 'dry') : 'none';
          } else if (lapsToGo > 6 && Wb >= th.wearLimit) {
            pit = true;
            pitTyres = wantWet ? 'wet' : 'dry';
          }
          refuel = -1;
        }
        // engine-forced reasons and required compound swaps
        if (!canFinish && F < q + qG * entryFrac) {
          pit = true;
          refuel = -1;
        }
        if (forced || W >= car.tyres[compound].Wlimit || swapNeeded) {
          pit = true;
          pitTyres = swapNeeded ? (compound === 'dry' ? 'wet' : 'dry') : pitTyres === 'none' ? compound : pitTyres;
          if (refuel === 0) refuel = -1;
        }
        if (pit && !laneOpen) {
          // emergency splash only
          if (F - q * entryFrac < 2 * q) {
            pitTyres = 'none';
            refuel = race.rules.emergencyFuelWhenClosed.splash_kg;
          } else pit = false;
        }
        if (pitTyres !== 'none' && sets[pitTyres] <= 0) pitTyres = 'none';
        if (pit && stop) si++;
      }
      outLap = false;

      // ---- our car: lap
      let egoTime = 0;
      if (!failed) {
        xi = aX * xi + sX * world.fut.n1[fi];
        const zY = rho * world.fut.n1[fi] + rho2 * world.fut.n2[fi];
        eta = aY * eta + sY * zY;
        zeta = aZ * zeta + sZ * world.fut.n3[fi];
        const S =
          sCar(car, { compound, w, tyreTemp, wear: W, X: Math.exp(xi), gripSkill: world.egoGrip, wetSkill: world.egoWetSkill }) *
          sTrack(world.trackTemp, world.rubber, w, cfg.track.meanDryGrip);
        const Sc = S < 0.35 ? 0.35 : S > 1.25 ? 1.25 : S;
        const mMid = mDry + F - q / 2;
        let tLap = surrogateLap(m, Sc, mMid, w, mode, world.airTemp) * world.egoPace * (drv ? drv.pace[driver] : 1);
        if (world.fut.trafficU[fi] < race.traffic.pPerLap) tLap += race.traffic.meanLoss_s * world.fut.trafficE[fi];
        tLap += race.residualSigma_s.value * world.fut.eps[fi];
        if (!caution) lastEgoLap = tLap;
        egoTime = caution ? tRun : tLap;
        const kt = wearRate(car, {
          compound,
          bY,
          wearMult: world.egoWearMult,
          mMid,
          tyreTemp,
          mode,
          fc: caution ? 1 : 0,
          w,
          Y: Math.exp(eta),
        });
        // hazards
        const pInc =
          race.incidents.base_per_car_lap * (1 + race.incidents.wetMultiplier * w) * (1 + race.incidents.wearMultiplier * Math.max(0, W - 0.6)) * car.modes[mode].riskFactor;
        const pFailMech = car.reliability.failure_per_lap * car.modes[mode].riskFactor;
        if (world.fut.incidentU[fi] < pInc + pFailMech) {
          const pRetire = (pInc * race.incidents.pRetire + pFailMech * car.reliability.pRetireOnFailure) / (pInc + pFailMech);
          if (world.fut.retireU[fi] < pRetire) {
            failed = true;
            failLap = i;
          } else {
            egoTime += 0.5 * (race.incidents.repair_s[0] + race.incidents.repair_s[1]);
            forced = true;
          }
        }
        if (!failed && world.fut.punctureU[fi] < punctureProb(car, W)) {
          egoTime += car.tyres.puncture.limpLoss_s;
          forced = true;
        }
        // fuel
        const burn = pit ? q * entryFrac : q;
        if (!failed && F < burn) {
          failed = true;
          failLap = i;
        }
        if (!failed) {
          F -= burn;
          fuelUsed += burn;
          W = Math.min(1, W + kt * (pit ? entryFrac : 1));
          tyreTemp = tyreTemp + car.tyres.thermal.aHeat_C * car.modes[mode].heatFactor * (mMid / mRef) * (caution ? car.tyres.thermal.cautionHeatFactor : 1) - car.tyres.thermal.bCool * (tyreTemp - world.trackTemp);
          tyreAge++;
          if (pit) {
            const fBox = F;
            const want = refuel < 0 ? Math.max(0, Math.min(cap - fBox, qG * (world.lapsToFlag - i + car.fuel.reserveLaps) - fBox)) : Math.min(refuel, cap - fBox);
            // the crew's driver policy at this stop (same rule as the engine's crews)
            let swap = false;
            if (drv && drv.pace.length > 1) {
              const tot = Array.from({ length: drv.pace.length }, (_, d) => driveTot[d]);
              const remaining = Math.max(0, world.duration - (T[0] + egoTime));
              const next = chooseDriver({
                current: driver,
                pace: drv.pace,
                total_s: tot,
                continuous_s: driveCont,
                minDrive_s: drv.minDrive_s,
                maxContinuous_s: drv.maxContinuous_s,
                remainingAfter_s: remaining,
                nextStint_s: Math.min(remaining, (cap / qBase) * m.lapRef),
              });
              if (next !== driver) {
                swap = true;
                driver = next;
                driveCont = 0;
              }
            }
            const svc = expectedService(m, want, pitTyres, swap);
            egoTime += netPitLoss(m, svc, caution ? tPace : tLap, caution);
            F = fBox + want;
            fuelUsed = 0;
            if (pitTyres !== 'none') {
              sets[pitTyres]--;
              compound = pitTyres;
              W = 0;
              tyreAge = 0;
              tyreTemp = newTyreTemp(car, world.airTemp);
            }
            forced = false;
            outLap = true;
          }
        }
      }
      pitted[0] = pit ? 1 : 0;
      if (!failed) {
        driveTot[driver] += egoTime;
        driveCont += egoTime;
      }
      // ---- rivals
      for (let r = 0; r < R; r++) {
        const rv = world.rivals[r];
        if (!rv.running) {
          Tn[r + 1] = Infinity;
          continue;
        }
        let t = caution ? tRun : rv.paceMean + rv.paceSd * world.fut.rivalZ[fi * R + r];
        let rp = 0;
        if (stint[r] + 1 >= win[r]) rp = 1;
        else if (!caution && egoPittedGreen && Math.abs(T[r + 1] - T[0]) <= 3 && stint[r] >= 0.6 * win[r] && world.fut.rivalCautionU[fi * R + r] < pCover) rp = 1;
        else if (caution && laneOpen && !rivalCautionPitted[r] && (stint[r] >= win[r] - 2 || (stint[r] >= 8 && world.fut.rivalCautionU[fi * R + r] < rv.pCautionPit))) rp = 1;
        if (rp) {
          t += caution ? netCautionFull : netGreenFull;
          stint[r] = 0;
          if (caution) rivalCautionPitted[r] = 1;
        } else stint[r]++;
        pitted[r + 1] = rp;
        Tn[r + 1] = T[r + 1] + t;
      }
      Tn[0] = failed ? Infinity : T[0] + egoTime;
      egoPittedGreen = pit && !caution;
      // ---- caution queue: in order of the previous crossing, non-pitting cars keep the queue gap
      if (caution) {
        order.length = 0;
        for (let c = 0; c <= R; c++) if (Number.isFinite(Tn[c])) order.push(c);
        order.sort((a, b) => laps[b] - laps[a] || T[a] - T[b]);
        let prev = -Infinity;
        for (let j = 0; j < order.length; j++) {
          const c = order[j];
          if (j === 0) {
            if (!pitted[c]) Tn[c] = Math.max(Tn[c], T[c] + tPace);
            prev = Tn[c];
            continue;
          }
          if (!pitted[c]) Tn[c] = Math.max(Tn[c], prev + gapQ);
          prev = Math.max(prev, Tn[c]);
        }
      }
      for (let c = 0; c <= R; c++) {
        T[c] = Tn[c];
        if (Number.isFinite(T[c])) laps[c]++;
      }
      // ---- flag
      let leadMin = Infinity;
      let leadLaps = -1;
      for (let c = 0; c <= R; c++) {
        if (!Number.isFinite(T[c])) continue;
        if (laps[c] > leadLaps || (laps[c] === leadLaps && T[c] < leadMin)) {
          leadLaps = laps[c];
          leadMin = T[c];
        }
      }
      if (leadMin >= world.duration) {
        flagT = leadMin;
        break;
      }
      if (failed) break;
    }

    // ---- outcome
    if (failed) {
      const remaining = Math.max(0, world.lapsToFlag - failLap);
      out.pos[p] = 11 + Math.min(1, remaining / totalLapsEst);
      out.fail[p] = 1;
      continue;
    }
    out.fail[p] = 0;
    // a missed minimum drive time classifies us behind every compliant finisher (rivals are assumed compliant);
    // beyond the horizon the remaining time can still be given to the driver who needs it
    if (drv && drv.pace.length > 1) {
      const left = flagT >= 0 ? 0 : Math.max(0, world.duration - T[0]);
      let short = 0;
      for (let d = 0; d < drv.pace.length; d++) short += Math.max(0, drv.minDrive_s - driveTot[d]);
      if (short > left + 1e-6) {
        let running = 0;
        for (let r = 0; r < R; r++) if (Number.isFinite(T[r + 1])) running++;
        out.pos[p] = 1 + running + Math.min(0.99, short / Math.max(1, drv.minDrive_s));
        continue;
      }
    }
    // projected distance at the flag for every running car
    const tEgoLap = lastEgoLap;
    let better = 0;
    const egoD = projectedDistance(laps[0], T[0], tEgoLap, F, qBase * Math.exp(bZ + zeta), cap, netGreenFull, world.duration, flagT);
    for (let r = 0; r < R; r++) {
      if (!Number.isFinite(T[r + 1])) continue;
      const rv = world.rivals[r];
      const fuelLaps = Math.max(0, win[r] - stint[r]);
      const d = projectedDistanceRival(laps[r + 1], T[r + 1], rv.paceMean, fuelLaps, win[r], netGreenFull, world.duration, flagT);
      if (d > egoD) better++;
    }
    out.pos[p] = 1 + better;
  }
}

function projectedDistance(laps: number, T: number, tLap: number, F: number, q: number, cap: number, netLoss: number, duration: number, flagT: number): number {
  if (flagT >= 0) return laps - Math.max(0, T - flagT) / tLap;
  const rem = duration - T;
  const lapsLeft = Math.max(0, rem / tLap);
  // expected (fractional) stops: the timing of later stops is uncertain, and a ceiling would reward
  // artificial early stops inside the horizon
  const fuelNeed = q * (lapsLeft + 1) - F;
  const stops = fuelNeed > 0 ? fuelNeed / (cap - q) : 0;
  return laps + lapsLeft - (stops * netLoss) / tLap;
}

function projectedDistanceRival(laps: number, T: number, tLap: number, fuelLaps: number, win: number, netLoss: number, duration: number, flagT: number): number {
  if (flagT >= 0) return laps - Math.max(0, T - flagT) / tLap;
  const lapsLeft = Math.max(0, (duration - T) / tLap);
  const stops = lapsLeft > fuelLaps ? (lapsLeft - fuelLaps) / Math.max(1, win) : 0;
  return laps + lapsLeft - (stops * netLoss) / tLap;
}

/** stationary sd helper re-export for priors */
export { stationarySd, fuelAtBox };
