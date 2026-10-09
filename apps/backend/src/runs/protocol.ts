// Messages between the RunManager (main thread) and a race worker.
import type { Injection, InjectionKind, PlannerConfig, ProblemDetails, RunConfig, RunInit, RunSummary, StreamType } from '@pitwall/shared';

export type ToWorker =
  | { type: 'init'; runId: string; config: RunConfig }
  | { type: 'control'; action: 'start' | 'pause' | 'step'; headless?: boolean }
  | { type: 'display'; raceTime_s: number | null }
  | { type: 'inject'; kind: InjectionKind; params?: { segmentId?: string } }
  | { type: 'planner'; patch: PlannerPatch };

export type PlannerPatch = Partial<Omit<PlannerConfig, 'triggers'>> & { triggers?: Partial<PlannerConfig['triggers']> };

export type FromWorker =
  | { type: 'ready'; init: RunInit }
  | { type: 'messages'; msgs: { type: StreamType; payload: unknown }[]; step: number; raceTime_s: number; injections: Injection[] }
  | { type: 'state'; state: 'running' | 'paused' | 'finished'; step: number; raceTime_s: number }
  | { type: 'summary'; summary: RunSummary }
  | { type: 'error'; problem: ProblemDetails };
