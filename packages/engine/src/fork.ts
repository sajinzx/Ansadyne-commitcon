// What-if forks (BACKEND §B.3): replay a run deterministically (same seed and injections) to `fromStep`, then let
// one world follow a forced static plan to the flag, and compare with the unforced replay of that world.
import type { Configs, ForkRequest, ForkResult, Injection, RunConfig, StrategyId } from '@pitwall/shared';
import { STRATEGIES } from '@pitwall/shared';
import { buildModel, type ModelBundle } from './vehicle/model';
import { Race } from './sim/race';
import { Estimator } from './estimator/ekf';
import { B0Strategy, b0Plan } from './strategy/b0';
import { B1Strategy, defaultB1Options } from './strategy/b1';
import { OptStrategy } from './strategy/opt';

function replay(configs: Configs, run: RunConfig, model: ModelBundle, injections: Injection[], world: StrategyId, forced: ForkRequest | null) {
  const b0 = b0Plan(model);
  const race = new Race({
    configs,
    model,
    run,
    estimatorFactory: (m) => new Estimator(m),
    strategies: { B0: new B0Strategy(b0), B1: new B1Strategy(defaultB1Options(model)), OPT: new OptStrategy({ initialPlan: b0 }) },
  });
  const wi = STRATEGIES.indexOf(world);
  const trace: number[] = [];
  while (!race.finished && race.k < 10_000) {
    for (const inj of injections) if (inj.step === race.k) race.inject(inj.kind, inj.params);
    if (forced && race.k === forced.fromStep) race.strategies[wi] = new B0Strategy(forced.forcedPlan);
    const out = race.step();
    if (!forced || out.step >= forced.fromStep) {
      const rec = out.laps.find((l) => l.world === world)?.cars.find((c) => c.no === race.egoNo);
      if (rec) trace.push(rec.position);
    }
  }
  const r = race.results()[world];
  return { finalPos: r.finalPos, laps: r.laps, trace };
}

export function forkRun(configs: Configs, run: RunConfig, injections: Injection[], req: ForkRequest, forkId: string, model?: ModelBundle): ForkResult {
  const m = model ?? buildModel(configs, run);
  const parent = replay(configs, run, m, injections, req.world, null);
  const child = replay(configs, run, m, injections, req.world, req);
  return {
    forkId,
    finalPos: child.finalPos,
    laps: child.laps,
    positionTrace: child.trace,
    deltaVsParent: child.finalPos - parent.finalPos,
    parentFinalPos: parent.finalPos,
  };
}
