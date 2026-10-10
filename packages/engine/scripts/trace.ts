// Trace one seed: OPT decisions and every world's stops (debugging aid).
//   pnpm tsx packages/engine/scripts/trace.ts F1 2 1
import { defaultConfigs, defaultRunConfig } from '@pitwall/shared';
import { benchContext } from '../src/bench/runner';
import { Race } from '../src/sim/race';
import { Estimator } from '../src/estimator/ekf';
import { B0Strategy } from '../src/strategy/b0';
import { B1Strategy, defaultB1Options } from '../src/strategy/b1';
import { OptStrategy } from '../src/strategy/opt';

const [fam = 'F1', seedS = '2', hoursS = '1'] = process.argv.slice(2);
const hours = Number(hoursS) as 1 | 3 | 6;
const trackId = process.env.TRACK ?? 'daytona';
const ctx = benchContext(defaultConfigs(), { ...defaultRunConfig(), durationHours: hours, trackId });
const m = ctx.base;
const race = new Race({
  configs: m.cfg,
  model: m,
  family: fam,
  run: { ...defaultRunConfig(), durationHours: hours, trackId, masterSeed: Number(seedS), family: fam },
  estimatorFactory: (x) => new Estimator(x),
  strategies: { B0: new B0Strategy(ctx.b0), B1: new B1Strategy(defaultB1Options(m)), OPT: new OptStrategy({ initialPlan: ctx.b0 }) },
});
const dbg = process.env.DBG_LAPS ? process.env.DBG_LAPS.split(',').map(Number) : [];
while (!race.finished && race.k < 10_000) {
  const pre = race.worldContext('OPT');
  if (pre && dbg.includes(pre.obs.lap)) {
    const o = pre.obs;
    console.log(`  dbg L${o.lap} fuelGauge=${o.ego.fuelGauge_kg.toFixed(1)} belief=${pre.belief?.fuel.mean.toFixed(1)}±${pre.belief?.fuel.sd.toFixed(1)} inLap=${o.ego.lastLapFlags.inLap} rem=${o.remaining_s.toFixed(0)} plan=${JSON.stringify(pre.plan?.stops.slice(0, 2))} src=${pre.plan?.source}`);
  }
  const out = race.step();
  for (const d of out.decisions) {
    const top = [...d.candidates].sort((a, b) => a.score - b.score).slice(0, 4);
    console.log(`L${d.lap} ${d.trigger.padEnd(10)} ${d.committed ? 'COMMIT ' : 'kept   '} ${d.chosen.padEnd(16)} ${top.map((c) => `${c.id}:${c.meanPos.toFixed(2)}/f${(c.pFail * 100).toFixed(0)}%`).join('  ')}  stops=${d.plan.stops.map((s) => s.lap + s.tyres[0]).join(',')}`);
  }
  for (const r of out.radio ?? []) if (r.kind === 'pit' && r.title.startsWith('BOX')) console.log(`   [${r.world}] L${r.lap} ${r.title} — ${r.text}`);
}
const res = race.results();
for (const id of ['B0', 'B1', 'OPT'] as const) console.log(id, res[id].finalPos, 'stops', res[id].stops, res[id].dnf ?? '');
