// Race worker: three paired worlds in lockstep (M08) with estimators and OPT; the planner runs inline in this
// worker (documented deviation from the shared planner pool; results are identical, see M12 §12.8).
import { parentPort } from 'node:worker_threads';
import type { RunConfig, StrategyId, StreamType } from '@pitwall/shared';
import { defaultConfigs } from '@pitwall/shared';
import { B0Strategy, B1Strategy, Estimator, OptStrategy, Race, b0Plan, buildModel, defaultB1Options, projection, roundsFor, runInit } from '@pitwall/engine';
import type { FromWorker, ToWorker } from './protocol';

const port = parentPort!;
const send = (m: FromWorker) => port.postMessage(m);

let race: Race | null = null;
let running = false;
let headless = false;
let stepsRequested = 0;
let displayTime: number | null = null;
let finished = false;
let wake: (() => void) | null = null;

function wakeUp() {
  const w = wake;
  wake = null;
  w?.();
}

function init(config: RunConfig) {
  const configs = defaultConfigs();
  const model = buildModel(configs, config);
  const b0 = b0Plan(model);
  race = new Race({
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
  send({ type: 'ready', init: runInit(model, b0) });
}

function doStep() {
  const r = race!;
  const out = r.step();
  const msgs: { type: StreamType; payload: unknown }[] = [];
  for (const lap of out.laps) msgs.push({ type: 'lap', payload: lap });
  for (const d of out.decisions) msgs.push({ type: 'decision', payload: d });
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
  send({ type: 'messages', msgs, step: r.k, raceTime_s, injections: r.injections });
  if (r.finished) {
    finished = true;
    running = false;
    const summary = { byStrategy: r.results(), decisions: r.decisionCount, injections: r.injections };
    send({ type: 'summary', summary });
    send({ type: 'state', state: 'finished', step: r.k, raceTime_s });
  }
}

function shouldStep(): boolean {
  if (!race || finished) return false;
  if (stepsRequested > 0) return true;
  if (!running) return false;
  if (headless || displayTime === null) return headless;
  return race.maxComputedTime() < displayTime + 3 * race.model.lapRef;
}

async function pump() {
  for (;;) {
    if (shouldStep()) {
      if (stepsRequested > 0) stepsRequested--;
      try {
        doStep();
      } catch (err) {
        running = false;
        send({ type: 'error', problem: { type: 'about:blank', title: 'Race worker error', status: 500, detail: String((err as Error).stack ?? err) } });
        return;
      }
      await new Promise((res) => setImmediate(res));
    } else {
      await new Promise<void>((res) => (wake = res));
    }
  }
}

port.on('message', (m: ToWorker) => {
  switch (m.type) {
    case 'init':
      try {
        init(m.config);
      } catch (err) {
        send({ type: 'error', problem: { type: 'about:blank', title: 'Run initialisation failed', status: 500, detail: String(err) } });
      }
      break;
    case 'control':
      if (m.action === 'start') {
        running = true;
        headless = !!m.headless;
      } else if (m.action === 'pause') running = false;
      else stepsRequested++;
      if (race) send({ type: 'state', state: finished ? 'finished' : running ? 'running' : 'paused', step: race.k, raceTime_s: race.maxComputedTime() });
      break;
    case 'display':
      displayTime = m.raceTime_s;
      break;
    case 'inject':
      race?.inject(m.kind, m.params);
      break;
    case 'planner':
      if (race) {
        const p = race.model.cfg.planner;
        const { triggers, ...rest } = m.patch;
        Object.assign(p, rest);
        if (rest.paths !== undefined) p.rounds = roundsFor(rest.paths);
        if (triggers) Object.assign(p.triggers, triggers);
      }
      break;
  }
  wakeUp();
});

void pump();
