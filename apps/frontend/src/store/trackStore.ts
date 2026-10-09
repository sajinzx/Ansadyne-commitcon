// Track tab state. Lives outside the component so a set-up survives switching tabs; what was last applied to
// the race is kept here too, and stays in force in the engine until the user resets it.
import { create } from 'zustand';
import type { SegmentOverride } from '@pitwall/shared';

export type ColourBy = 'grip' | 'type' | 'wetness';

export interface AppliedSurface {
  overrides: SegmentOverride[];
  trackTempOffset_C: number;
  wetAll: number;
  atLap: number;
}

interface TrackState {
  wetness: number;
  temp: number;
  rubber: number;
  overrides: SegmentOverride[];
  segId: string;
  colourBy: ColourBy;
  marker: number;
  /** race set-up: added to every segment's wetness, and to the modelled track temperature */
  wetAll: number;
  tempOffset: number;
  applied: AppliedSurface | null;
  set(patch: Partial<Omit<TrackState, 'set' | 'resetDraft'>>): void;
  resetDraft(): void;
}

const DRAFT = { overrides: [] as SegmentOverride[], wetAll: 0, tempOffset: 0 };

export const useTrack = create<TrackState>((set) => ({
  wetness: 0,
  temp: 30,
  rubber: 0.02,
  segId: 'S05',
  colourBy: 'grip',
  marker: 1500,
  applied: null,
  ...DRAFT,
  set: (patch) => set(patch),
  resetDraft: () => set({ ...DRAFT }),
}));

/** The overrides actually sent to the engine: per-segment offsets plus the all-segment wetness offset. */
export function raceOverrides(segIds: string[], overrides: SegmentOverride[], wetAll: number): SegmentOverride[] {
  const out: SegmentOverride[] = [];
  for (const id of segIds) {
    const o = overrides.find((x) => x.segmentId === id);
    const w = Math.max(-1, Math.min(1, (o?.wetnessOffset ?? 0) + wetAll));
    if (w !== 0 || o?.debris) out.push({ segmentId: id, ...(w !== 0 ? { wetnessOffset: Number(w.toFixed(3)) } : {}), ...(o?.debris ? { debris: true } : {}) });
  }
  return out;
}
