// Live "team radio": plain-language messages from the engine about our car in each world, each with the
// evidence behind it (belief, weather, plan, decision statistics). Messages describe what happened and why;
// they never reveal hidden truth beyond what the crew can measure (fuel rig, tread gauge).
import type { Belief, CarLapRecord, Decision, Observation, RaceEvent, RadioMessage, StrategyId } from '@pitwall/shared';
import type { ModelBundle } from '../vehicle/model';
import type { EnvState } from '../world/weather';
import type { CarTruth } from './world';
import { expectedService, netPitLoss } from './pit';
import { nominalBurn } from '../vehicle/fuel';

const CAND: Record<string, string> = {
  stay: 'keep the plan',
  pit_fuel: 'pit now, fuel only',
  pit_fuel_tyres: 'pit now, fuel + tyres',
  pit_swap_compound: 'pit now and swap compound',
  pit_in_2: 'pit in 2 laps',
  pit_in_4: 'pit in 4 laps',
  save_then_pit: 'save fuel 5 laps, then pit',
  push_to_stop: 'push to the stop',
  b1_action: 'follow the rule-based call',
};

const B1_RULE: Record<string, string> = {
  fuel: 'fuel rule: not enough fuel to do another lap and reach the pit entry with a reserve lap',
  caution: 'caution rule: lane open and the tank is half used (cheap stop under caution)',
  wetIn: 'wet-in rule: observed wetness passed 0.30 on slicks',
  wetOut: 'wet-out rule: wetness at or below 0.15 for 3 laps on wet tyres',
  wear: 'wear rule: tyres past the wear limit for their age',
  driver: 'driver rule: the other driver still needs their minimum drive time (taken under caution, or at the last safe lap)',
};

export interface RadioContext {
  world: StrategyId;
  step: number;
  model: ModelBundle;
  ego: CarTruth;
  rec: CarLapRecord | undefined;
  events: RaceEvent[];
  decision: Decision | undefined;
  note: string | undefined;
  obs: Observation | null;
  belief: Belief | null;
  env: EnvState;
  prevEnv: EnvState | null;
  rainIn20: number;
  /** regime of each of the last few ticks seen by our car (newest last) */
  regimeHistory: string[];
}

const pct = (p: number) => `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`;

export function buildRadio(c: RadioContext): RadioMessage[] {
  const out: RadioMessage[] = [];
  const lap = c.rec?.lap ?? c.ego.laps;
  const t = c.rec?.lineCross_s ?? c.ego.lapStart_s;
  const msg = (m: Omit<RadioMessage, 'world' | 'step' | 'lap' | 'raceTime_s'>) => out.push({ world: c.world, step: c.step, lap, raceTime_s: t, ...m });
  const b = c.belief;
  const car = c.model.cfg.car;
  const weatherLine = () =>
    `weather ${c.env.regime}, wetness ${c.env.w.toFixed(2)}${c.prevEnv ? ` (${Math.abs(c.env.w - c.prevEnv.w) < 0.005 ? 'steady' : c.env.w > c.prevEnv.w ? 'rising' : 'falling'}${Math.abs(c.env.w - c.prevEnv.w) < 0.005 ? '' : ` from ${c.prevEnv.w.toFixed(2)}`})` : ''}, rain within 20 laps ${pct(c.rainIn20)}`;
  const fuelLine = () => {
    if (!b) return null;
    const q = nominalBurn(car) * b.Zeff.mean;
    return `fuel (belief) ${b.fuel.mean.toFixed(1)} ± ${b.fuel.sd.toFixed(1)} kg ≈ ${(b.fuel.mean / q).toFixed(1)} laps at ${q.toFixed(2)} kg/lap`;
  };
  const tyreLine = () => `${c.ego.compound} tyres, ${c.ego.tyreAgeLaps} laps old${b ? `, wear (belief) ${(b.W.mean * 100).toFixed(0)}% ± ${(b.W.sd * 100).toFixed(0)}` : ''}`;

  // ---- weather state changes seen by our car
  if (c.prevEnv && c.prevEnv.regime !== c.env.regime) {
    const drying = c.env.regime === 'dry' || (c.env.regime === 'damp' && c.prevEnv.regime === 'wet');
    msg({
      kind: 'weather',
      priority: c.env.regime === 'wet' || (c.env.regime === 'dry' && c.ego.compound === 'wet') ? 'alert' : 'info',
      title: drying ? (c.env.regime === 'dry' ? 'Rain has stopped' : 'Rain easing') : c.env.regime === 'wet' ? 'Heavy rain' : 'Rain starting',
      text: `Weather ${c.prevEnv.regime} → ${c.env.regime}. We are on ${c.ego.compound} tyres.`,
      proof: [weatherLine(), tyreLine()],
    });
  }

  // ---- strategy decisions (OPT planner)
  const d = c.decision;
  if (d) {
    const chosen = d.candidates.find((x) => x.id === d.chosen);
    const stay = d.candidates.find((x) => x.id === 'stay');
    const best = [...d.candidates].filter((x) => x.feasible).sort((a, b2) => a.score - b2.score)[0];
    const s0 = d.plan.stops[0];
    const planText = s0 ? `pit lap ${s0.lap}${s0.tyres !== 'none' ? `, ${s0.tyres} tyres` : ', fuel only'}` : 'no further stop planned';
    if (d.committed && chosen) {
      msg({
        kind: 'decision',
        priority: 'action',
        title: `New plan: ${CAND[d.chosen] ?? d.chosen}`,
        text: `${planText}. Trigger: ${d.trigger}.`,
        proof: [
          ...d.reasons,
          `expected finish P${chosen.meanPos.toFixed(2)} vs P${stay?.meanPos.toFixed(2) ?? '—'} keeping the plan (${d.nPaths} simulated futures, rank stability ${(d.rankStability * 100).toFixed(0)}%)`,
          `vs rule-based call: Δ ${chosen.deltaVsB1 >= 0 ? '+' : ''}${chosen.deltaVsB1.toFixed(2)} places (90% CI ${chosen.deltaCI90[0].toFixed(2)} … ${chosen.deltaCI90[1].toFixed(2)}); risk of DNF ${pct(chosen.pFail)}`,
        ],
      });
    } else if ((d.trigger === 'caution' || d.trigger === 'weather') && best) {
      msg({
        kind: 'decision',
        priority: 'info',
        title: 'Stay out, plan unchanged',
        text: `${d.keptReason ?? 'gain not significant'}. Plan: ${planText}.`,
        proof: [
          `best alternative "${CAND[best.id] ?? best.id}" P${best.meanPos.toFixed(2)} vs keep P${stay?.meanPos.toFixed(2) ?? '—'}; a change needs ≥ 0.15 places and a CI below zero`,
          ...d.reasons.slice(0, 2),
        ],
      });
    }
  }

  // ---- our pit stop (in-lap) with what the crew is doing and why
  const rec = c.rec;
  const po = c.ego.pendingOutLap;
  if (rec?.pit?.phase === 'in' && po) {
    const forced = rec.pit.forced?.length ? rec.pit.forced : null;
    const tyres = po.tyres === 'none' ? 'no tyre change' : `fresh ${po.tyres.toUpperCase()} tyres`;
    const driver = po.driverTo !== null ? `, driver change to ${c.ego.drivers.lineup[po.driverTo].name}` : '';
    const caution = rec.flag !== 'green';
    const svc = expectedService(c.model, po.refuelApplied_kg, po.tyres);
    const lossGreen = netPitLoss(c.model, svc, c.model.lapRef, false);
    const lossCaution = netPitLoss(c.model, svc, c.model.cfg.race.caution.paceLapFactor * c.model.lapRef, true);
    const why: string[] = [];
    if (forced) why.push(`forced by the rules: ${forced.join(', ')}`);
    else if (c.note && B1_RULE[c.note]) why.push(B1_RULE[c.note]);
    else if (c.note) why.push(c.note);
    else why.push('planned stop of the committed plan');
    if (po.tyres !== 'none' && po.tyres !== c.ego.compound) {
      why.push(
        po.tyres === 'dry'
          ? `rain has stopped: ${c.env.regime} for ${c.regimeHistory.filter((r) => r === 'dry').length} recent laps, wetness ${c.env.w.toFixed(2)} — slicks are faster below about 0.23`
          : `track is wet: wetness ${c.env.w.toFixed(2)} — wets are faster above about 0.23`,
      );
    }
    why.push(caution ? `under caution: stop costs ≈ ${lossCaution.toFixed(0)} s instead of ≈ ${lossGreen.toFixed(0)} s under green` : `green-flag stop costs ≈ ${lossGreen.toFixed(0)} s`);
    const fl = fuelLine();
    if (fl) why.push(fl);
    why.push(tyreLine());
    why.push(weatherLine());
    msg({
      kind: 'pit',
      priority: 'action',
      title: `BOX BOX — lap ${rec.lap}`,
      text: `${po.refuelApplied_kg.toFixed(1)} kg fuel, ${tyres}${driver}; service ≈ ${po.service_s.toFixed(1)} s.`,
      proof: why,
    });
  }

  // ---- tread measurement of the removed set (out-lap)
  if (rec?.pit?.phase === 'out' && c.obs?.ego.treadMeasured) {
    const m = c.obs.ego.treadMeasured;
    msg({
      kind: 'tyres',
      priority: 'info',
      title: 'Tyres measured',
      text: `Removed ${m.compound} set: ${(m.wear * 100).toFixed(0)}% worn after ${m.laps} laps.`,
      proof: b ? [`wear-rate estimate now ×${b.Yeff.mean.toFixed(2)} ± ${b.Yeff.sd.toFixed(2)} of nominal`, `new set: ${c.ego.compound}`] : [],
    });
  }

  // ---- low fuel without a stop coming
  if (b && rec && !rec.pit && c.obs?.ego.running) {
    const q = nominalBurn(car) * b.Zeff.mean;
    const lapsLeft = b.fuel.mean / q;
    const toFlag = Math.ceil(Math.max(0, c.obs.remaining_s) / c.model.lapRef) + 1;
    if (lapsLeft < 2.5 && lapsLeft < toFlag) {
      msg({ kind: 'fuel', priority: 'alert', title: 'Fuel critical', text: `About ${lapsLeft.toFixed(1)} laps of fuel left.`, proof: [fuelLine() ?? '', weatherLine()] });
    }
  }

  // ---- race-control and car events
  for (const e of c.events) {
    if ('world' in e && e.world !== c.world) continue;
    switch (e.type) {
      case 'caution_start':
        msg({ kind: 'caution', priority: 'alert', title: 'Full-course caution', text: `Caution (${e.cause}). Pit lane closed for 2 laps.`, proof: [tyreLine(), fuelLine() ?? ''].filter(Boolean) });
        break;
      case 'pit_open':
        msg({ kind: 'caution', priority: 'alert', title: 'Pit lane open', text: 'Pits open under caution: stops are about 16 s cheaper now.', proof: [fuelLine() ?? '', tyreLine()].filter(Boolean) });
        break;
      case 'caution_end':
        msg({ kind: 'caution', priority: 'info', title: 'Green flag', text: 'Caution over, racing resumes.', proof: [] });
        break;
      case 'driver_change':
        if (e.car === c.ego.no) {
          const totals = c.ego.drivers.lineup.map((dr, i) => `${dr.name} ${(c.ego.drivers.total_s[i] / 60).toFixed(0)} min`).join(', ');
          msg({ kind: 'driver', priority: 'info', title: 'Driver change', text: `${e.from} out, ${e.to} in.`, proof: [`drive time so far: ${totals}`, `minimum per driver ${(((c.obs?.ego.drivers?.minDrive_s ?? 0) / 60) | 0)} min`] });
        }
        break;
      case 'pit':
        if (e.car === c.ego.no && e.refused) msg({ kind: 'pit', priority: 'alert', title: 'Stop refused', text: `Could not pit: ${e.refused}.`, proof: [weatherLine()] });
        break;
      case 'incident':
      case 'failure':
      case 'puncture':
        if (e.car === c.ego.no) msg({ kind: 'incident', priority: 'alert', title: e.type === 'puncture' ? 'Puncture!' : e.type === 'failure' ? 'Mechanical failure' : 'Incident', text: `${e.outcome === 'retire' ? 'Car is out.' : e.outcome === 'repair' ? 'Repair at the next stop.' : 'Limping to the pits.'}${e.zone ? ` (${e.zone})` : ''}`, proof: [tyreLine()] });
        break;
      case 'penalty':
        if (e.car === c.ego.no) msg({ kind: 'penalty', priority: 'alert', title: 'Penalty', text: e.reason, proof: [] });
        break;
      case 'dnf':
        if (e.car === c.ego.no) msg({ kind: 'incident', priority: 'alert', title: 'Retired', text: `DNF: ${e.cause}.`, proof: [fuelLine() ?? ''].filter(Boolean) });
        break;
    }
  }
  return out;
}
