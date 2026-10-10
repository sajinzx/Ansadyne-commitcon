// Typed REST client for the backend (BACKEND §B.3).
import type { InjectionParams, BenchRequest, Configs, Decision, ForkRequest, InjectionKind, RunConfig, RunInfo, RunSummary, SegmentOverride, StreamMessage, TrackGeometryPayload, TrackInfo } from '@pitwall/shared';

import { ApiError } from './errors';
import type { LocalServer } from '../local/server';

export { ApiError };

const host = typeof window !== 'undefined' && window.location?.hostname ? window.location.hostname : 'localhost';
export const API_URL: string = (import.meta.env?.VITE_API_URL as string | undefined) ?? `http://${host}:8787/api/v1`;

/**
 * Static web build (GitHub Pages): the whole backend runs in the browser (Web Workers) behind the same API.
 * Chosen at build time with VITE_STANDALONE=1, or at run time with ?standalone=1.
 */
export const STANDALONE: boolean =
  import.meta.env?.VITE_STANDALONE === '1' || (typeof window !== 'undefined' && new URLSearchParams(window.location?.search ?? '').get('standalone') === '1');

let local: LocalServer | null = null;
export async function localBackend(): Promise<LocalServer> {
  if (!local) local = (await import('../local/server')).localServer();
  return local;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (STANDALONE) {
    // a structured clone keeps the in-browser backend from sharing objects with the UI, like a network would
    const data = await (await localBackend()).handle(method, path, body === undefined ? undefined : structuredClone(body));
    return (data === undefined ? undefined : structuredClone(data)) as T;
  }
  const r = await fetch(`${API_URL}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new ApiError(data ?? { type: 'about:blank', title: r.statusText, status: r.status });
  return data as T;
}

export interface TrackPreview {
  segments: { id: string; effectiveGrip: number; node: number; sTrack: number; standingWater_mm: number; hazard: string; wetness: number }[];
  speedProfile: { s: number[]; v: number[] };
  lapTime_s: number;
  sectorTimes_s: [number, number, number];
  diagnostics: import('@pitwall/shared').Diagnostics;
}

export interface JobStatus<R = unknown> {
  jobId: string;
  kind: string;
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  progress: { done: number; total: number };
  etaMs?: number;
  result?: R;
  error?: string;
}

export interface SensitiveParam {
  path: string;
  value: number;
  low: number;
  high: number;
  provenance: string;
  ranged: boolean;
}

export const api = {
  health: () => req<{ status: string; codeVersion: string }>('GET', '/health'),
  defaults: () => req<Configs>('GET', '/config/defaults'),
  tracks: () => req<TrackInfo[]>('GET', '/tracks'),
  track: (trackId = 'daytona') => req<TrackGeometryPayload>('GET', `/track?trackId=${encodeURIComponent(trackId)}`),
  preview: (b: { wetness: number; trackTemp_C: number; rubber: number; overrides: SegmentOverride[]; trackId?: string }) => req<TrackPreview>('POST', '/track/preview', b),
  createRun: (c: RunConfig) => req<RunInfo>('POST', '/runs', c),
  run: (id: string) => req<RunInfo>('GET', `/runs/${id}`),
  control: (id: string, action: 'start' | 'pause' | 'step') => req<RunInfo>('POST', `/runs/${id}/control`, { action }),
  speed: (id: string, speed: number) => req<RunInfo>('PUT', `/runs/${id}/speed`, { speed }),
  inject: (id: string, kind: InjectionKind, params?: InjectionParams) => req<{ appliesAtStep: number }>('POST', `/runs/${id}/inject`, { kind, ...(params ? { params } : {}) }),
  risk: (id: string, b: { lambdaRisk?: number; cvarAlpha?: number; pFailLimit?: number }) => req<RunInfo>('PUT', `/runs/${id}/risk`, b),
  planner: (id: string, b: Record<string, unknown>) => req<RunInfo>('PUT', `/runs/${id}/planner`, b),
  fork: (id: string, f: ForkRequest) => req<{ jobId: string }>('POST', `/runs/${id}/fork`, f),
  events: (id: string, fromSeq = 0) => req<{ events: StreamMessage[]; nextSeq: number }>('GET', `/runs/${id}/events?fromSeq=${fromSeq}`),
  decision: (id: string, decisionId: string) => req<Decision>('GET', `/runs/${id}/decisions/${decisionId}`),
  summary: (id: string) => req<RunSummary>('GET', `/runs/${id}/summary`),
  deleteRun: (id: string) => req<void>('DELETE', `/runs/${id}`),
  bench: (b: BenchRequest) => req<{ jobId: string }>('POST', '/bench', b),
  experiment: (name: string, b: { seedsPerFamily: number; families: string[] }) => req<{ jobId: string }>('POST', `/experiments/${name}`, b),
  experiments: () => req<{ id: string; title: string; variants: string[] }[]>('GET', '/experiments'),
  sensitivity: (param: string, seeds?: number) => req<{ jobId: string }>('POST', '/sensitivity', { param, ...(seeds ? { seeds } : {}) }),
  sensitiveParams: () => req<SensitiveParam[]>('GET', '/sensitivity/params'),
  job: <R>(id: string) => req<JobStatus<R>>('GET', `/jobs/${id}`),
  cancelJob: (id: string) => req<void>('DELETE', `/jobs/${id}`),
  exportUrl: (id: string, format: 'csv' | 'json') => (STANDALONE && local ? local.exportUrl(id, format) : `${API_URL}/jobs/${id}/export?format=${format}`),
};
