// M02 §2.4 — the single surface-grip function, used by both the UI (preview) and the lap solver.
//   grip_j = S_track · node_j     (exact factorisation; no per-segment temperature or rubber)
import type { SegmentOverride, TrackConfig } from '@pitwall/shared';
import type { NodeGrid } from './geometry';

export const GRIP_FLOOR = 0.05;

export function clip(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Temperature factor: peaks at 38 °C, floor 0.80. */
export function fTrk(T: number): number {
  return Math.max(0.8, 1 - ((T - 38) / 48) ** 2);
}

/** Standing-water indicator in [0, 1] (display as sw × 4 mm). */
export function standingWater(w: number): number {
  return clip((w - 0.6) / 0.4, 0, 1);
}

/** Uniform track part: temperature and rubber. */
export function sTrack(trackTemp: number, rubber: number, wetness: number, meanDryGrip: number): number {
  return fTrk(trackTemp) * (1 + (rubber * (1 - wetness)) / meanDryGrip);
}

export interface SegmentGripState {
  w: number;
  blend: number;
  sw: number;
  node: number;
  debris: boolean;
}

/** Segment-specific part for one segment at global wetness w with an optional override. */
export function segmentNode(dryGrip: number, wetGrip: number, w: number, ov?: SegmentOverride): SegmentGripState {
  const wj = clip(w + (ov?.wetnessOffset ?? 0), 0, 1);
  const blend = (1 - wj) * dryGrip + wj * wetGrip;
  const sw = standingWater(wj);
  const debris = !!ov?.debris;
  const node = Math.max(GRIP_FLOOR, blend - 0.2 * sw - 0.08 * (debris ? 1 : 0));
  return { w: wj, blend, sw, node, debris };
}

export interface SurfaceState {
  wetness: number;
  trackTemp_C: number;
  rubber: number;
  overrides: SegmentOverride[];
}

export function overrideFor(overrides: SegmentOverride[], segId: string): SegmentOverride | undefined {
  return overrides.find((o) => o.segmentId === segId);
}

/** Effective grip per segment as shown in the UI. */
export function segmentGrips(track: TrackConfig, st: SurfaceState) {
  const S = sTrack(st.trackTemp_C, st.rubber, st.wetness, track.meanDryGrip);
  return track.segments.map((seg) => {
    const n = segmentNode(seg.dryGrip.value, seg.wetGrip.value, st.wetness, overrideFor(st.overrides, seg.id));
    return {
      id: seg.id,
      effectiveGrip: S * n.node,
      node: n.node,
      sTrack: S,
      standingWater_mm: n.sw * 4,
      hazard: n.debris ? 'debris' : n.sw > 0 ? 'standing water' : 'clear',
      wetness: n.w,
    };
  });
}

/** Per-node segment factor array for the solver at global wetness w with overrides. */
export function nodeFactors(track: TrackConfig, grid: NodeGrid, w: number, overrides: SegmentOverride[]): Float64Array {
  const perSeg = track.segments.map((seg) => segmentNode(seg.dryGrip.value, seg.wetGrip.value, w, overrideFor(overrides, seg.id)).node);
  const out = new Float64Array(grid.n);
  for (let i = 0; i < grid.n; i++) out[i] = perSeg[grid.seg[i]];
  return out;
}
