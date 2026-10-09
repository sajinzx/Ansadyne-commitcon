import { create } from 'zustand';
import type { BenchResult } from '@pitwall/shared';
import { api, type JobStatus } from '../api/client';

interface Tracked<R> {
  jobId: string;
  status: JobStatus<R> | null;
}

interface BenchState {
  bench: Tracked<BenchResult> | null;
  experiments: Record<string, Tracked<BenchResult>>;
  sensitivity: Record<string, Tracked<{ param: { path: string; value: number }; seeds: number; low: { value: number; meanD: number }; high: { value: number; meanD: number } }>>;
  startBench(req: Parameters<typeof api.bench>[0]): Promise<void>;
  startExperiment(id: string, families: string[], seedsPerFamily: number): Promise<void>;
  startSensitivity(param: string, seeds?: number): Promise<void>;
}

async function poll<R>(jobId: string, update: (s: JobStatus<R>) => void): Promise<void> {
  for (;;) {
    const s = await api.job<R>(jobId);
    update(s);
    if (s.state !== 'running' && s.state !== 'queued') return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export const useBench = create<BenchState>((set, get) => ({
  bench: null,
  experiments: {},
  sensitivity: {},
  startBench: async (req) => {
    const { jobId } = await api.bench(req);
    set({ bench: { jobId, status: null } });
    await poll<BenchResult>(jobId, (status) => set({ bench: { jobId, status } }));
  },
  startExperiment: async (id, families, seedsPerFamily) => {
    const { jobId } = await api.experiment(id, { families, seedsPerFamily });
    set({ experiments: { ...get().experiments, [id]: { jobId, status: null } } });
    await poll<BenchResult>(jobId, (status) => set({ experiments: { ...get().experiments, [id]: { jobId, status } } }));
  },
  startSensitivity: async (param, seeds) => {
    const { jobId } = await api.sensitivity(param, seeds);
    set({ sensitivity: { ...get().sensitivity, [param]: { jobId, status: null } } });
    await poll(jobId, (status) => set({ sensitivity: { ...get().sensitivity, [param]: { jobId, status: status as never } } }));
  },
}));
