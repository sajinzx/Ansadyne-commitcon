// A live race session, independent of the transport: the Node server runs it in a worker thread, the static
// web build in a Web Worker. Three paired worlds step in lockstep; the planner runs inline (results are identical
// to a shared pool, see M12 §12.8). The session stays at most 3 laps ahead of the furthest display clock.
import type { Injection, InjectionKind, InjectionParams, PlannerConfig, ProblemDetails, RunConfig, RunInit, RunSummary, StrategyId, StreamType } from '@pitwall/shared';
import { defaultConfigs } from '@pitwall/shared';
import { Race } from '../sim/race';
import { buildModel, roundsFor } from '../vehicle/model';
import { Estimator } from '../estimator/ekf';
import { B0Strategy, b0Plan } from '../strategy/b0';
import { B1Strategy, defaultB1Options } from '../strategy/b1';
import { OptStrategy } from '../strategy/opt';
import { projection, runInit } from '../api';

export type PlannerPatch = Partial<Omit<PlannerConfig, 'triggers'>> & { triggers?: Partial<PlannerConfig['triggers']> };

export type ToSession =
  | { type: 'init'; runId: string; config: RunConfig }
  | { type: 'control'; action: 'start' | 'pause' | 'step'; headless?: boolean }
  | { type: 'display'; raceTime_s: number | null }
  | { type: 'inject'; kind: InjectionKind; params?: InjectionParams }
  | { type: 'planner'; patch: PlannerPatch };

export type FromSession =
  | { type: 'ready'; init: RunInit }
  | { type: 'messages'; msgs: { type: StreamType; payload: unknown }[]; step: number; raceTime_s: number; injections: Injection[] }
  | { type: 'state'; state: 'running' | 'paused' | 'finished'; step: number; raceTime_s: number }
  | { type: 'summary'; summary: RunSummary }
  | { type: 'error'; problem: ProblemDetails };

/**
 * Drive a race from messages. `send` posts to the owner; `yieldNow` lets the host's event loop breathe between
 * steps (setImmediate in Node, a MessageChannel tick in the browser).
 */
export class RaceSession {
  private race: Race | null = null;
  private running = false;
  private headless = false;
  private stepsRequested = 0;
  private displayTime: number | null = null;
  private finished = false;
  private wake: (() => void) | null = null;
  private pumping = false;

  constructor(
    private readonly send: (m: FromSession) => void,
    private readonly yieldNow: () => Promise<void>,
  ) {}

  handle(m: ToSession): void {
    switch (m.type) {
      case 'init':
        try {
          this.init(m.config);
        } catch (err) {
          this.send({ type: 'error', problem: { type: 'about:blank', title: 'Run initialisation failed', status: 500, detail: String(err) } });
        }
        break;
      case 'control':
        if (m.action === 'start') {
          this.running = true;
          this.headless = !!m.headless;
        } else if (m.action === 'pause') this.running = false;
        else this.stepsRequested++;
        if (this.race) this.send({ type: 'state', state: this.finished ? 'finished' : this.running ? 'running' : 'paused', step: this.race.k, raceTime_s: this.race.maxComputedTime() });
        break;
      case 'display':
        this.displayTime = m.raceTime_s;
        break;
      case 'inject':
        this.race?.inject(m.kind, m.params);
        break;
      case 'planner':
        if (this.race) {
          const p = this.race.model.cfg.planner;
          const { triggers, ...rest } = m.patch;
          Object.assign(p, rest);
          if (rest.paths !== undefined) p.rounds = roundsFor(rest.paths);
          if (triggers) Object.assign(p.triggers, triggers);
        }
        break;
    }
    const w = this.wake;
    this.wake = null;
    w?.();
    if (!this.pumping) void this.pump();
  }

  private init(config: RunConfig) {
    const configs = defaultConfigs();
    const model = buildModel(configs, config);
    const b0 = b0Plan(model);
    this.race = new Race({
      configs,
      model,
      run: config,
      estimatorFactory: (m) => new Estimator(m),
      strategies: {
        B0: new B0Strategy(b0),
        B1: new B1Strategy(defaultB1Options(model)),
        OPT: new OptStrategy({ initialPlan: b0 }),
      },
    });
    this.send({ type: 'ready', init: runInit(model, b0) });
  }

  private doStep() {
    const r = this.race!;
    const out = r.step();
    const msgs: { type: StreamType; payload: unknown }[] = [];
    for (const lap of out.laps) msgs.push({ type: 'lap', payload: lap });
    for (const d of out.decisions) msgs.push({ type: 'decision', payload: d });
    for (const m of out.radio) msgs.push({ type: 'radio', payload: m });
    for (const e of out.events) {
      if (e.type === 'warning') msgs.push({ type: 'warning', payload: { code: e.code, detail: e.detail } });
      else msgs.push({ type: 'event', payload: e });
    }
    for (const d of out.decisions) if (d.overBudget) msgs.push({ type: 'warning', payload: { code: 'planner_over_budget', detail: `${d.id}: ${d.elapsedMs.toFixed(0)} ms` } });
    if (out.step % 5 === 0 || out.triggers.length) {
      for (const id of ['B0', 'B1', 'OPT'] as StrategyId[]) {
        const p = projection(r, id);
        if (p) msgs.push({ type: 'projection', payload: p });
      }
    }
    const raceTime_s = r.maxComputedTime();
    this.send({ type: 'messages', msgs, step: r.k, raceTime_s, injections: r.injections });
    if (r.finished) {
      this.finished = true;
      this.running = false;
      this.send({ type: 'summary', summary: { byStrategy: r.results(), decisions: r.decisionCount, injections: r.injections } });
      this.send({ type: 'state', state: 'finished', step: r.k, raceTime_s });
    }
  }

  private shouldStep(): boolean {
    const r = this.race;
    if (!r || this.finished) return false;
    if (this.stepsRequested > 0) return true;
    if (!this.running) return false;
    if (this.headless || this.displayTime === null) return this.headless;
    return r.maxComputedTime() < this.displayTime + 3 * r.model.lapRef;
  }

  private async pump() {
    this.pumping = true;
    for (;;) {
      if (this.shouldStep()) {
        if (this.stepsRequested > 0) this.stepsRequested--;
        try {
          this.doStep();
        } catch (err) {
          this.running = false;
          this.send({ type: 'error', problem: { type: 'about:blank', title: 'Race worker error', status: 500, detail: String((err as Error).stack ?? err) } });
          this.pumping = false;
          return;
        }
        await this.yieldNow();
      } else {
        await new Promise<void>((res) => (this.wake = res));
      }
    }
  }
}
