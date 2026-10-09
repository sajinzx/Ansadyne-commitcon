import { defaultConfigs, defaultRunConfig, type Configs, type RunConfig, type StrategyId, type Action, type ObsHistory, type Observation, type Plan, type LapEvent } from '@pitwall/shared';
import { buildModel, type ModelBundle } from '../src/vehicle/model';
import { Race, type RaceOptions } from '../src/sim/race';
import { B1Strategy, defaultB1Options } from '../src/strategy/b1';
import type { Strategy, StrategyContext, StrategyOutput } from '../src/strategy/strategy';

export const CFG: Configs = defaultConfigs();
export const RUN: RunConfig = defaultRunConfig();

let shared: ModelBundle | null = null;
export function sharedModel(): ModelBundle {
  if (!shared) shared = buildModel(CFG, RUN);
  return shared;
}

export function b1Strategies(model: ModelBundle): Record<StrategyId, Strategy> {
  const b = () => new B1Strategy(defaultB1Options(model));
  return { B0: b(), B1: b(), OPT: b() };
}

export function b1Race(seed: number, extra: Omit<Partial<RaceOptions>, 'run'> & { run?: Partial<RunConfig> } = {}): Race {
  const { run, ...rest } = extra;
  const model = rest.model ?? sharedModel();
  return new Race({
    configs: CFG,
    model,
    strategies: rest.strategies ?? b1Strategies(model),
    ...rest,
    run: { ...RUN, masterSeed: seed, ...(run ?? {}) },
  });
}

/** Deterministic hash of a value (FNV-1a over its JSON). */
export function hashOf(v: unknown): string {
  const s = JSON.stringify(v);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

export function lapEvents(race: Race): LapEvent[] {
  return race.runToEnd().flatMap((o) => o.laps);
}

/** A scripted strategy: pit with the given action at the given laps, otherwise stay out. */
export class ScriptedStrategy implements Strategy {
  constructor(
    readonly id: StrategyId,
    private readonly pits: Map<number, Action>,
  ) {}
  decide(obs: Observation, _h: ObsHistory, _b: unknown, _ctx: StrategyContext): StrategyOutput {
    const a = this.pits.get(obs.lap + 1);
    return { action: a ?? { pit: false, refuel_kg: 0, tyres: 'none', driverChange: false, mode: 'normal' } };
  }
  getState() {
    return null;
  }
  setState() {}
  currentPlan(): Plan | null {
    return null;
  }
}
