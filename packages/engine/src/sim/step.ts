// M08 §8.3 — the lap procedure for one world and one step. Pit state machine (M07 §7.2):
//   decision point  = line crossing at the end of lap k−1 (strategies return the action for lap k)
//   execution point = pit entry on lap k (s = 5613 m): engine legality on truth, fuel at the box
//   state update    = box arrival on lap k+1 (out-lap): fuel, tyres, wear, temperature, sets — exactly once
import type { Action, CarLapRecord, Compound, RaceEvent } from '@pitwall/shared';
import type { ModelBundle } from '../vehicle/model';
import { lapFraction, surrogateLap } from '../vehicle/model';
import type { Predraw } from '../rng/predraw';
import { categoricalFromU } from '../rng/rng';
import type { EnvTimeline } from '../world/weather';
import { stepMultipliers, type ClipCounter } from '../stochastic/ou';
import { sTrack } from '../track/surface';
import { burnPerLap } from '../vehicle/fuel';
import { newTyreTemp, punctureProb, sCar, tyreTempNext, wearRate } from '../vehicle/tyre';
import { inLapTime, outLapTime, serviceTime, refuelRequest } from './pit';
import type { CarTruth, CautionState, ForcedReason, WorldTruth } from './world';

export const STAY: Action = { pit: false, refuel_kg: 0, tyres: 'none', driverChange: false, mode: 'normal' };

export interface StepContext {
  model: ModelBundle;
  pd: Predraw;
  env: EnvTimeline;
  k: number;
  actions: Map<number, Action>;
  egoNo: number;
  injectedCaution: boolean;
  forcedCautionStep?: boolean;
  clips?: ClipCounter;
}

export interface StepResult {
  records: CarLapRecord[];
  events: RaceEvent[];
}

export function laneOpenAt(c: CautionState | null, t: number): boolean {
  if (!c) return true;
  if (t < c.t_c) return true;
  if (c.t_end !== null && t >= c.t_end) return true;
  if (c.pitOpenTime !== null && t >= c.pitOpenTime) return true;
  return false;
}

export function cautionAt(c: CautionState | null, t: number): boolean {
  return !!c && t >= c.t_c && (c.t_end === null || t < c.t_end);
}

export function stepWorld(w: WorldTruth, ctx: StepContext): StepResult {
  const { model, pd, k } = ctx;
  const cfg = model.cfg;
  const carCfg = cfg.car;
  const race = cfg.race;
  const L = model.lapLength;
  const lane = model.lane;
  const events: RaceEvent[] = [];
  const records: CarLapRecord[] = [];
  w.step = k;

  // close a caution that ended during the previous step
  if (w.caution && w.caution.t_end !== null) {
    w.caution = null;
    w.lastCautionEndStep = k - 1;
  }

  const running = w.cars.filter((c) => c.running && !c.classified);
  if (running.length === 0) {
    w.finished = true;
    return { records, events };
  }
  const W_lo = Math.max(...running.map((c) => c.lapStart_s));

  // ---- 1. caution start (window rule: t_c ≥ every running car's current lap start)
  // no new caution once the flag is known or the field is past the duration (it could not affect the result,
  // and classified cars' crossings would lie after its start)
  if (!w.caution && w.finish.T_finish_s === null && W_lo < race.duration_s) {
    let tc: number | null = null;
    let cause: CautionState['cause'] = 'background';
    if (w.pendingCautionStart_s !== null) {
      tc = Math.max(w.pendingCautionStart_s, W_lo);
      cause = w.pendingCautionCause ?? 'incident';
    } else if (ctx.injectedCaution || ctx.forcedCautionStep) {
      tc = W_lo + pd.cautionStartU.get(k) * model.lapRef;
      cause = 'injected';
    } else if (k > 0 && k - w.lastCautionEndStep > race.caution.minGreenLapsBetween) {
      const env = ctx.env.at(W_lo);
      const p = race.caution.background_per_lap * (1 + race.caution.wetMultiplier * env.w) * (env.night ? race.caution.nightMultiplier : 1);
      if (pd.cautionU.get(k) < p) {
        tc = W_lo + pd.cautionStartU.get(k) * model.lapRef;
        cause = 'background';
      }
    }
    if (tc !== null) {
      const durKeys = Object.keys(race.caution.durationLaps).map(Number);
      const durProbs = durKeys.map((d) => race.caution.durationLaps[String(d)]);
      const dur = durKeys[categoricalFromU(durProbs, pd.cautionDurU.get(k))];
      w.caution = { active: true, t_c: tc, durationLaps: dur, leaderCrossings: 0, pitOpenTime: null, t_end: null, cause, startStep: k };
      w.cautionLog.push(w.caution);
      for (const c of w.cars) c.pittedThisCaution = false;
      events.push({ type: 'caution_start', step: k, t_c: tc, cause, world: w.id });
    }
  }
  w.pendingCautionStart_s = null;
  w.pendingCautionCause = null;

  // ---- 2. cars in running order (lap-synchronous: order by lap start)
  const order = [...running].sort((a, b) => b.laps - a.laps || a.lapStart_s - b.lapStart_s);
  const leaderNo = order[0].no;
  let prevCross: number | null = null;
  let prevLapTime = 0;

  for (const car of order) {
    const Tf = w.finish.T_finish_s;
    // laps that would start after the flag are not run; until the flag is known, cars already past the
    // duration wait (lap-synchronous engine: this keeps lapped cars from running laps that will be void)
    if (Tf !== null && car.lapStart_s >= Tf) {
      car.classified = true;
      continue;
    }
    if (Tf === null && car.lapStart_s >= race.duration_s) continue;
    records.push(computeLap(car));
  }

  // the flag falls at the leader's first crossing at or after the duration (M08 §8.5); the leader is the
  // running car with the most crossings up to the duration (ties: earliest such crossing)
  if (w.finish.T_finish_s === null) {
    let leader: CarTruth | null = null;
    let leaderN = -1;
    for (const c of w.cars) {
      if (!c.running) continue;
      let n = 0;
      while (n < c.crossings.length && c.crossings[n] < race.duration_s) n++;
      if (n > leaderN || (n === leaderN && leader && n > 0 && c.crossings[n - 1] < leader.crossings[n - 1])) {
        leader = c;
        leaderN = n;
      }
    }
    if (leader && leader.crossings.length > leaderN) w.finish.T_finish_s = leader.crossings[leaderN];
  }

  // ---- 3. positions and gaps
  rankCars(w);
  for (const rec of records) {
    const car = w.cars.find((c) => c.no === rec.no)!;
    rec.position = car.position;
    rec.gapAhead_s = car.gapAhead_s;
    const leader = w.cars.find((c) => c.position === 1)!;
    rec.lapsDown = leader.laps - car.laps;
    rec.gapLeader_s = car.laps > 0 && leader.crossings[car.laps - 1] !== undefined ? car.lapStart_s - leader.crossings[car.laps - 1] : 0;
    car.lastLap = rec;
  }

  // ---- 4. finish
  const Tf = w.finish.T_finish_s;
  if (Tf !== null) {
    const minDrive = race.rules.drivers.minDrive_s[String(model.durationHours)] ?? 0;
    for (const c of w.cars) {
      if (c.running && !c.classified && c.laps > 0 && c.lapStart_s >= Tf) {
        c.classified = true;
        if (c.drivers.lineup.length > 1 && c.drivers.total_s.some((t) => t < minDrive)) {
          c.driveViolation = true;
          const short = c.drivers.lineup.filter((_, i) => c.drivers.total_s[i] < minDrive).map((d) => d.name).join(', ');
          events.push({ type: 'penalty', car: c.no, step: k, reason: `minimum drive time missed (${short})`, world: w.id });
        }
      }
    }
    if (w.cars.some((c) => c.driveViolation)) rankCars(w);
    for (const rec of records) {
      const c = w.cars.find((x) => x.no === rec.no)!;
      rec.classified = c.classified;
    }
  }
  if (w.cars.every((c) => !c.running || c.classified)) w.finished = true;
  w.events = events;
  return { records, events };

  // ------------------------------------------------------------------ per-car lap
  function computeLap(car: CarTruth): CarLapRecord {
    const idx = car.idx;
    const act = ctx.actions.get(car.no) ?? STAY;
    const isLeader = car.no === leaderNo;
    const lapStart = car.lapStart_s;
    const env = ctx.env.at(lapStart);
    const fc0 = car.field;
    car.mode = act.mode;

    [car.lnX, car.lnY, car.lnZ] = stepMultipliers(
      car.lnX,
      car.lnY,
      car.lnZ,
      pd.n1.get(idx, k),
      pd.n2.get(idx, k),
      pd.n3.get(idx, k),
      model.multipliers,
      ctx.clips,
    );
    const X = Math.exp(car.lnX);
    const Y = Math.exp(car.lnY);
    const Z = Math.exp(car.lnZ);

    // ---- out-lap: state update at box arrival (exactly once)
    const out = car.pendingOutLap;
    if (out) {
      car.fuel_kg += out.refuelApplied_kg;
      car.lastRefuelApplied_kg = out.refuelApplied_kg;
      car.treadMeasured = null;
      if (out.tyres !== 'none') {
        // the crew measures the tread of the removed set (gauge noise ~0.01 of full wear)
        const sigma = carCfg.tyres.treadGaugeSigma ?? 0.01;
        car.treadMeasured = {
          wear: Math.max(0, Math.min(1, car.wear + sigma * pd.treadN.get(idx, Math.min(car.stopIndex - 1, pd.sizes.S - 1)))),
          laps: car.tyreAgeLaps,
          compound: car.compound,
        };
        car.compound = out.tyres;
        car.wear = 0;
        car.tyreAgeLaps = 0;
        car.tyreTemp_C = newTyreTemp(carCfg, env.airTemp);
        car.setsLeft[out.tyres] = Math.max(0, car.setsLeft[out.tyres] - 1);
      }
      if (out.driverTo !== null && out.driverTo !== car.drivers.current) {
        events.push({
          type: 'driver_change',
          car: car.no,
          step: k,
          from: car.drivers.lineup[car.drivers.current].name,
          to: car.drivers.lineup[out.driverTo].name,
          world: w.id,
        });
        car.drivers.current = out.driverTo;
        car.drivers.continuous_s = 0;
      }
      const cur = car.stints[car.stints.length - 1];
      cur.endLap = car.laps - 1;
      car.stints.push({ startLap: car.laps, compound: car.compound, startFuel_kg: car.fuel_kg, laps: 0 });
      car.lapsSinceStop = 0;
      car.fuelUsedSinceStop_kg = 0;
    } else {
      car.lastRefuelApplied_kg = null;
      car.treadMeasured = null;
    }

    const c = w.caution;
    const cautionLap = !!c && lapStart >= c.t_c && (c.t_end === null || lapStart < c.t_end);

    const spike = car.fuelSpikeLaps > 0 ? 1.15 : 1;
    const mStart = carCfg.mass_dry_kg.value + car.fuel_kg;
    const qGreen = burnPerLap(carCfg, { bZ: car.coeff.bZ, burnMult: fc0.burnMult, mode: car.mode, mStart, fc: 0, Z, fuelSpike: spike });
    const mMid = carCfg.mass_dry_kg.value + car.fuel_kg - qGreen / 2;
    const S =
      sCar(carCfg, {
        compound: car.compound,
        w: env.w,
        tyreTemp: car.tyreTemp_C,
        wear: car.wear,
        X,
        gripSkill: car.pace.gripSkill,
        wetSkill: fc0.wetSkill,
      }) * sTrack(env.trackTemp, env.rubber, env.w, cfg.track.meanDryGrip);
    const driverPace = car.drivers.lineup[car.drivers.current]?.pace ?? 1;
    const base = surrogateLap(model, S, mMid, env.w, car.mode, env.airTemp) * car.pace.paceFactor * driverPace;
    const traffic = pd.trafficU.get(idx, k) < race.traffic.pPerLap ? race.traffic.meanLoss_s * pd.trafficE.get(idx, k) : 0;
    const dirty =
      !cautionLap && car.gapAhead_s < race.dirtyAir.gapThreshold_s
        ? race.dirtyAir.maxLoss_s * (1 - car.gapAhead_s / race.dirtyAir.gapThreshold_s)
        : 0;
    const eps = race.residualSigma_s.value * pd.epsN.get(idx, k);
    const tGreen = base + traffic + dirty + eps;
    const tPace = race.caution.paceLapFactor * model.lapRef;
    const tRun = race.caution.runToQueueFactor * model.lapRef;
    let tFull: number;
    let fc: number;
    let partial = false;
    if (cautionLap) {
      tFull = isLeader ? tPace : tRun;
      fc = 1;
    } else if (c && c.t_c > lapStart && c.t_c < lapStart + tGreen) {
      const fn = (c.t_c - lapStart) / tGreen;
      tFull = fn * tGreen + (1 - fn) * (isLeader ? tPace : tRun);
      fc = 1 - fn;
      partial = true;
    } else {
      tFull = tGreen;
      fc = 0;
    }
    const frac = (s: number) => lapFraction(model, s, cautionLap);
    const q = burnPerLap(carCfg, { bZ: car.coeff.bZ, burnMult: fc0.burnMult, mode: car.mode, mStart, fc, Z, fuelSpike: spike });
    const kt = wearRate(carCfg, {
      compound: car.compound,
      bY: car.coeff.bY,
      wearMult: fc0.wearMult,
      mMid,
      tyreTemp: car.tyreTemp_C,
      mode: car.mode,
      fc,
      w: env.w,
      Y,
    });

    // ---- engine-side forced reasons
    // fuel emergency: the car could not reach the box after this lap and cannot reach the flag either
    const lapsToFlag = w.finish.T_finish_s !== null ? 1 : Math.ceil(Math.max(0, race.duration_s - lapStart) / Math.max(60, tFull)) + 1;
    const canFinish = car.fuel_kg >= q + qGreen * (lapsToFlag - 1);
    if (!out && !canFinish && car.fuel_kg < q + (qGreen * lane.entryS) / L && !car.forced.includes('fuel')) car.forced.push('fuel');
    if (car.wear >= carCfg.tyres[car.compound].Wlimit && !car.forced.includes('wearLimit')) car.forced.push('wearLimit');
    // drive-time limit: hand over before the current driver would exceed the continuous maximum
    const dr = race.rules.drivers;
    if (car.drivers.lineup.length > 1 && car.drivers.continuous_s + 2 * tFull > dr.maxContinuous_s && !car.forced.includes('driveTime')) car.forced.push('driveTime');

    let wantPit = act.pit || car.forced.length > 0;
    if (out && wantPit) {
      if (act.pit) events.push({ type: 'pit', car: car.no, step: k, forced: false, refused: 'out-lap', world: w.id });
      wantPit = false;
    }

    // ---- hazards (pure): occurrence and position from pre-draws, outcome applied below
    const sFrom = out ? lane.exitS : 0;
    const laneOut = out ? lane.lineToBox + out.service_s + lane.boxToExit + lane.exitLoss : 0;
    const tAt = (s: number) => (out ? lapStart + laneOut + tFull * (frac(s) - frac(lane.exitS)) : lapStart + tFull * frac(s));
    const riskF = carCfg.modes[car.mode].riskFactor;
    const inc = race.incidents;
    const pInc =
      inc.base_per_car_lap *
      (1 + inc.wetMultiplier * env.w) *
      (1 + inc.wearMultiplier * Math.max(0, car.wear - 0.6)) *
      riskF *
      (env.night ? inc.nightMultiplier : 1);
    const pFail = carCfg.reliability.failure_per_lap * riskF;
    const pPunct = punctureProb(carCfg, car.wear);
    type Hz = { kind: 'incident' | 'failure' | 'puncture'; s: number; retire: boolean };
    const hz: Hz[] = [];
    if (pd.incidentU.get(idx, k) < pInc) hz.push({ kind: 'incident', s: L * pd.incidentPosU.get(idx, k), retire: pd.incidentRetireU.get(idx, k) < inc.pRetire });
    if (pd.failureU.get(idx, k) < pFail)
      hz.push({ kind: 'failure', s: L * pd.failurePosU.get(idx, k), retire: pd.failureRetireU.get(idx, k) < carCfg.reliability.pRetireOnFailure });
    if (pd.punctureU.get(idx, k) < pPunct) hz.push({ kind: 'puncture', s: L * pd.puncturePosU.get(idx, k), retire: false });
    hz.sort((a, b) => a.s - b.s);
    const limpLoss = carCfg.tyres.puncture.limpLoss_s;
    const firstRetire = hz.find((h) => h.retire && h.s >= sFrom);
    const limpBeforeEntry = hz.some((h) => h.kind === 'puncture' && h.s >= sFrom && h.s < lane.entryS) ? limpLoss : 0;

    // ---- pit legality at the execution point (pit entry), on truth
    let pitLegal = false;
    let pitTyres: 'none' | Compound = 'none';
    let pitRefuel = 0;
    if (wantPit && !(firstRetire && firstRetire.s < lane.entryS)) {
      const tEntry = tAt(lane.entryS) + limpBeforeEntry;
      const open = laneOpenAt(w.caution, tEntry);
      const fuelBox = car.fuel_kg - (q * lane.entryS) / L;
      const forcedTyres = car.forced.some((r) => r === 'puncture' || r === 'wearLimit' || r === 'repair');
      pitTyres = act.pit ? act.tyres : 'none';
      if (forcedTyres && pitTyres === 'none') pitTyres = car.compound;
      pitRefuel = act.pit ? act.refuel_kg : 0;
      if (car.forced.includes('fuel') && pitRefuel <= 0) {
        pitRefuel = refuelRequest(model, car.fuel_kg, q, tEntry + lane.toLine + lane.lineToBox, model.lapRef);
      }
      let refused: string | null = null;
      if (!open) {
        const emergency = race.rules.emergencyFuelWhenClosed.value && fuelBox < 2 * q;
        if (emergency) {
          pitTyres = 'none';
          pitRefuel = race.rules.emergencyFuelWhenClosed.splash_kg;
        } else {
          refused = 'lane closed';
        }
      }
      if (pitTyres !== 'none' && car.setsLeft[pitTyres] <= 0) pitTyres = 'none';
      if (refused) events.push({ type: 'pit', car: car.no, step: k, forced: !act.pit, refused, world: w.id });
      else pitLegal = true;
    }
    const sEnd = pitLegal ? lane.entryS : L;

    // ---- apply hazards that happen on the track portion [sFrom, sEnd)
    let limp = 0;
    let incidentFlag = false;
    let retire: { cause: 'incident' | 'failure'; s: number } | null = null;
    for (const h of hz) {
      if (h.s < sFrom || h.s >= sEnd) continue;
      const zone = model.geo.incidentZonesAt(h.s)[0]?.name;
      incidentFlag = true;
      if (h.kind === 'puncture') {
        limp += limpLoss;
        if (!car.forced.includes('puncture')) car.forced.push('puncture');
        events.push({ type: 'puncture', car: car.no, step: k, atLapDist_m: h.s, zone, outcome: 'limp', world: w.id });
        continue;
      }
      const isInc = h.kind === 'incident';
      const fcyU = isInc ? pd.incidentFcyU.get(idx, k) : pd.failureFcyU.get(idx, k);
      const pFcy = isInc ? race.caution.pFcyGivenIncident : race.caution.pFcyGivenFailure;
      if (fcyU < pFcy && !w.caution && w.pendingCautionStart_s === null) {
        w.pendingCautionStart_s = tAt(h.s) + race.caution.raceControlDelay_s;
        w.pendingCautionCause = isInc ? 'incident' : 'failure';
      }
      if (h.retire) {
        retire = { cause: h.kind as 'incident' | 'failure', s: h.s };
        events.push({ type: h.kind, car: car.no, step: k, atLapDist_m: h.s, zone, outcome: 'retire', world: w.id });
        break;
      }
      const [lo, hi] = isInc ? inc.repair_s : carCfg.reliability.repair_s;
      const repU = isInc ? pd.incidentRepairU.get(idx, k) : pd.failureRepairU.get(idx, k);
      car.repair_s = Math.max(car.repair_s, lo + (hi - lo) * repU);
      if (!car.forced.includes('repair')) car.forced.push('repair');
      events.push({ type: h.kind, car: car.no, step: k, atLapDist_m: h.s, zone, outcome: 'repair', world: w.id });
    }

    const rec: CarLapRecord = {
      no: car.no,
      lap: car.laps + 1,
      lapStart_s: lapStart,
      lapTime_s: 0,
      lineCross_s: 0,
      sectorTimes_s: [0, 0, 0],
      position: car.position,
      lapsDown: 0,
      gapLeader_s: 0,
      gapAhead_s: 0,
      compound: car.compound,
      tyreAgeLaps: car.tyreAgeLaps,
      stops: car.stops,
      flag: cautionLap ? 'caution' : partial ? 'mixed' : 'green',
      pit: null,
      running: true,
      classified: false,
      mode: car.mode,
      driver: car.drivers.lineup[car.drivers.current]?.name,
    };

    // ---- retirement or fuel exhaustion on the track portion (fuel is never clamped to hide it)
    const needFuel = (q * (sEnd - sFrom)) / L;
    if (retire || car.fuel_kg < needFuel) {
      let sStop: number;
      let cause: 'incident' | 'failure' | 'fuel';
      if (retire && car.fuel_kg >= (q * (retire.s - sFrom)) / L) {
        sStop = retire.s;
        cause = retire.cause;
      } else {
        sStop = sFrom + (Math.max(0, car.fuel_kg) / q) * L;
        cause = 'fuel';
      }
      const tStop = tAt(sStop) + limp;
      car.running = false;
      car.dnf = { cause, atTime_s: tStop, atLapDist_m: sStop };
      car.fuel_kg = Math.max(0, car.fuel_kg - (q * (sStop - sFrom)) / L);
      events.push({ type: 'dnf', car: car.no, cause, step: k, world: w.id });
      rec.running = false;
      rec.dnf = car.dnf;
      rec.lapTime_s = tStop - lapStart;
      rec.lineCross_s = tStop;
      car.pendingOutLap = null;
      return rec;
    }

    let tLap = 0;
    let inLap = false;
    if (pitLegal) {
      const tEntry = tAt(lane.entryS) + limp;
      const fuelBox = car.fuel_kg - (q * lane.entryS) / L;
      const cap = carCfg.fuel.capacity_kg;
      const refuelApplied = Math.max(0, Math.min(pitRefuel, cap - fuelBox));
      if (pitRefuel - refuelApplied > 0.5 && car.no === ctx.egoNo) {
        events.push({
          type: 'warning',
          code: 'refuel_clamped',
          detail: `car ${car.no} requested ${pitRefuel.toFixed(1)} kg, applied ${refuelApplied.toFixed(1)} kg`,
        });
      }
      const j = car.stopIndex;
      const repairS = car.forced.includes('repair') ? car.repair_s : 0;
      const nDrivers = car.drivers.lineup.length;
      let driverTo: number | null = act.pit && act.driverChange && nDrivers > 1 ? (act.nextDriver ?? (car.drivers.current + 1) % nDrivers) : null;
      if (driverTo === null && car.forced.includes('driveTime') && nDrivers > 1) driverTo = (car.drivers.current + 1) % nDrivers;
      if (driverTo === car.drivers.current) driverTo = null;
      const svc = serviceTime(model, {
        refuel_kg: refuelApplied,
        tyres: pitTyres,
        driverChange: driverTo !== null,
        logN: pd.pitLogN.get(idx, j),
        slowU: pd.pitSlowU.get(idx, j),
        slowAddU: pd.pitSlowAddU.get(idx, j),
        repair_s: repairS,
      });
      tLap = inLapTime(model, tFull, cautionLap) + limp;
      car.wear = Math.min(1, car.wear + (kt * lane.entryS) / L);
      car.fuelUsedSinceStop_kg += car.fuel_kg - fuelBox;
      car.fuel_kg = fuelBox;
      car.pendingOutLap = { service_s: svc, refuelApplied_kg: refuelApplied, tyres: pitTyres, t_line: lapStart + tLap, repaired: repairS > 0, driverTo };
      car.stopIndex++;
      car.stops++;
      const forcedList = [...car.forced] as ForcedReason[];
      car.forced = [];
      car.repair_s = 0;
      if (cautionAt(w.caution, tEntry)) car.pittedThisCaution = true;
      events.push({ type: 'pit', car: car.no, step: k, forced: !act.pit, world: w.id });
      rec.pit = { phase: 'in', t_entry: tEntry, t_line: lapStart + tLap, forced: act.pit ? undefined : forcedList };
      inLap = true;
    } else if (out) {
      tLap = outLapTime(model, out.service_s, tFull, cautionLap) + limp;
      const portion = (L - lane.exitS) / L;
      car.fuel_kg -= q * portion;
      car.fuelUsedSinceStop_kg += q * portion;
      car.wear = Math.min(1, car.wear + kt * portion);
      const tBox = lapStart + lane.lineToBox;
      rec.pit = {
        phase: 'out',
        t_box: tBox,
        service_s: out.service_s,
        t_exit: tBox + out.service_s + lane.boxToExit + lane.exitLoss,
        refuelApplied_kg: out.refuelApplied_kg,
        tyres: out.tyres,
      };
      car.pendingOutLap = null;
    } else {
      tLap = tFull + limp;
      car.fuel_kg -= q;
      car.fuelUsedSinceStop_kg += q;
      car.wear = Math.min(1, car.wear + kt);
    }

    car.tyreTemp_C = tyreTempNext(carCfg, car.tyreTemp_C, env.trackTemp, car.mode, mMid, car.coeff.heat, fc, pd.tyreTempN.get(idx, k));
    car.tyreAgeLaps += 1;
    car.lapsSinceStop += 1;
    if (car.fuelSpikeLaps > 0) car.fuelSpikeLaps--;

    // ---- crossing: green holding/overtaking or caution queue
    let cross = lapStart + tLap;
    if (!inLap && prevCross !== null) {
      if (cautionLap || partial) {
        if (!isLeader) cross = Math.max(cross, prevCross + race.caution.queueGap_s);
      } else if (cross < prevCross + race.overtaking.holdGap_s) {
        if (prevLapTime - (cross - lapStart) >= race.overtaking.passDelta_s) cross += race.overtaking.passCost_s;
        else cross = prevCross + race.overtaking.holdGap_s;
      }
    }
    tLap = cross - lapStart;
    car.drivers.total_s[car.drivers.current] += tLap;
    car.drivers.continuous_s += tLap;
    if (!inLap) {
      prevCross = cross;
      prevLapTime = tLap;
    }

    // ---- caution bookkeeping on the leader's crossings
    const cs = w.caution;
    if (cs && car.no === leaderNo && cross > cs.t_c && cs.t_end === null) {
      cs.leaderCrossings++;
      if (cs.leaderCrossings === race.rules.pitClosedFirstCautionLaps.value && cs.pitOpenTime === null) {
        cs.pitOpenTime = cross;
        events.push({ type: 'pit_open', step: k, world: w.id });
      }
      if (cs.leaderCrossings >= cs.durationLaps) {
        cs.t_end = cross;
        events.push({ type: 'caution_end', step: k, world: w.id });
      }
    }

    const secFrac = model.surrogate.sectorFrac(Math.max(0.35, Math.min(1.25, S)), mMid, env.w, car.mode);
    rec.sectorTimes_s = [secFrac[0] * tLap, secFrac[1] * tLap, secFrac[2] * tLap];
    rec.lapTime_s = tLap;
    rec.lineCross_s = cross;
    rec.compound = car.compound;
    rec.tyreAgeLaps = car.tyreAgeLaps;
    rec.stops = car.stops;
    car.lastLapTime_s = tLap;
    car.lapStart_s = cross;
    car.crossings.push(cross);
    car.laps += 1;
    car.stints[car.stints.length - 1].laps += 1;
    car.lastLapFlags = { inLap, outLap: !!out, caution: cautionLap || partial, incident: incidentFlag };
    return rec;
  }
}

/** Order: running/classified by laps (desc) then last crossing (asc); DNFs after, by laps then time. */
export function rankCars(w: WorldTruth): void {
  const finishers = w.cars.filter((c) => c.running || c.classified);
  const dnfs = w.cars.filter((c) => !c.running && !c.classified);
  // a drive-time violation classifies the car behind every compliant finisher
  finishers.sort((a, b) => Number(a.driveViolation) - Number(b.driveViolation) || b.laps - a.laps || a.lapStart_s - b.lapStart_s);
  dnfs.sort((a, b) => b.laps - a.laps || (b.dnf?.atTime_s ?? 0) - (a.dnf?.atTime_s ?? 0));
  const all = [...finishers, ...dnfs];
  all.forEach((c, i) => {
    c.position = i + 1;
  });
  for (let i = 0; i < finishers.length; i++) {
    const c = finishers[i];
    const ahead = finishers[i - 1];
    const behind = finishers[i + 1];
    c.gapAhead_s = ahead ? gapBetween(ahead, c) : 99;
    c.gapBehind_s = behind ? gapBetween(c, behind) : 99;
  }
}

/** Time gap from car `a` (ahead) to car `b` at the line, comparing the same lap index when possible. */
function gapBetween(a: CarTruth, b: CarTruth): number {
  if (b.laps === 0) return 0.6;
  const aCross = a.crossings[b.laps - 1];
  return aCross !== undefined ? Math.max(0, b.lapStart_s - aCross) : 99;
}
