// M02 §2.3 — Daytona road-course geometry: smoothed schematic centreline, lookups, solver node grid.
import type { TrackConfig, TrackGeometryPayload } from '@pitwall/shared';

export const DS = 2; // solver node spacing (m)

type Pt = [number, number];

/** Centripetal Catmull–Rom point between p1 and p2 at t ∈ [0, 1]. */
function catmullRom(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const alpha = 0.5;
  const td = (a: Pt, b: Pt) => Math.max(1e-6, Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), alpha));
  const t0 = 0;
  const t1 = t0 + td(p0, p1);
  const t2 = t1 + td(p1, p2);
  const t3 = t2 + td(p2, p3);
  const tt = t1 + (t2 - t1) * t;
  const lerp = (a: Pt, b: Pt, ta: number, tb: number): Pt => {
    const w = (tt - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  };
  const a1 = lerp(p0, p1, t0, t1);
  const a2 = lerp(p1, p2, t1, t2);
  const a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2);
  const b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}

class Polyline {
  readonly cum: Float64Array;
  readonly length: number;
  constructor(readonly pts: Pt[]) {
    this.cum = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) {
      this.cum[i] = this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    this.length = this.cum[pts.length - 1];
  }
  /** Point and heading at fraction f ∈ [0, 1] of arc length. */
  at(f: number): { x: number; y: number; heading: number } {
    const target = Math.max(0, Math.min(1, f)) * this.length;
    let lo = 0;
    let hi = this.pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= target) lo = mid;
      else hi = mid;
    }
    const segLen = this.cum[hi] - this.cum[lo] || 1;
    const w = (target - this.cum[lo]) / segLen;
    const a = this.pts[lo];
    const b = this.pts[hi];
    return { x: a[0] + (b[0] - a[0]) * w, y: a[1] + (b[1] - a[1]) * w, heading: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  }
}

export interface NodeGrid {
  n: number;
  ds: number;
  s: Float64Array;
  seg: Int32Array;
  sector: Int32Array;
  theta: Float64Array;
  invR: Float64Array; // 1 / radius; 0 on straights / outside apex windows
  dryGrip: Float64Array;
  wetGrip: Float64Array;
}

export class TrackGeometry {
  readonly lapLength: number;
  readonly segPolys: Polyline[];
  readonly pitPoly: Polyline;
  readonly grid: NodeGrid;
  readonly stretch_m: number;

  constructor(readonly cfg: TrackConfig) {
    this.lapLength = cfg.lapLength_m.value;
    this.segPolys = this.buildSegmentPolylines();
    this.pitPoly = new Polyline(cfg.pitLane.points);
    this.grid = this.buildGrid();
    this.stretch_m = this.lapLength - cfg.pitLane.entry_s_m + cfg.pitLane.exit_s_m;
  }

  private buildSegmentPolylines(): Polyline[] {
    const ctrl: Pt[] = [];
    const spanSeg: number[] = [];
    this.cfg.segments.forEach((seg, j) => {
      const pts = seg.points;
      const startIdx = j === 0 ? 0 : 1;
      for (let i = startIdx; i < pts.length; i++) ctrl.push(pts[i]);
      for (let i = 0; i < pts.length - 1; i++) spanSeg.push(j);
    });
    // closed loop: the last control point duplicates the first
    ctrl.pop();
    const n = ctrl.length; // number of spans equals number of points in a closed loop
    const samplesBySeg: Pt[][] = this.cfg.segments.map(() => []);
    const SAMPLES = 40;
    for (let i = 0; i < n; i++) {
      const p0 = ctrl[(i - 1 + n) % n];
      const p1 = ctrl[i];
      const p2 = ctrl[(i + 1) % n];
      const p3 = ctrl[(i + 2) % n];
      const j = spanSeg[i];
      for (let k = 0; k < SAMPLES; k++) samplesBySeg[j].push(catmullRom(p0, p1, p2, p3, k / SAMPLES));
    }
    // close each segment with the first sample of the next one so segments join exactly
    return samplesBySeg.map((pts, j) => {
      const next = samplesBySeg[(j + 1) % samplesBySeg.length][0];
      return new Polyline([...pts, next]);
    });
  }

  private buildGrid(): NodeGrid {
    const n = Math.round(this.lapLength / DS);
    const g: NodeGrid = {
      n,
      ds: DS,
      s: new Float64Array(n),
      seg: new Int32Array(n),
      sector: new Int32Array(n),
      theta: new Float64Array(n),
      invR: new Float64Array(n),
      dryGrip: new Float64Array(n),
      wetGrip: new Float64Array(n),
    };
    for (let i = 0; i < n; i++) {
      const s = i * DS;
      const j = this.segmentIndexAt(s);
      const seg = this.cfg.segments[j];
      g.s[i] = s;
      g.seg[i] = j;
      g.sector[i] = this.sectorIndexAt(s);
      g.theta[i] = (seg.banking_deg.value * Math.PI) / 180;
      g.dryGrip[i] = seg.dryGrip.value;
      g.wetGrip[i] = seg.wetGrip.value;
      const len = seg.end_m - seg.start_m;
      let inApex = false;
      for (const a of seg.apex) {
        const c = seg.start_m + a.at * len;
        if (Math.abs(s - c) <= a.window_m / 2 + 1e-9) inApex = true;
      }
      g.invR[i] = inApex && seg.cornerRadius_m ? 1 / seg.cornerRadius_m.value : 0;
    }
    return g;
  }

  wrap(s: number): number {
    const L = this.lapLength;
    return ((s % L) + L) % L;
  }

  segmentIndexAt(sIn: number): number {
    const s = this.wrap(sIn);
    const segs = this.cfg.segments;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].start_m <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  segmentAt(s: number) {
    return this.cfg.segments[this.segmentIndexAt(s)];
  }

  sectorIndexAt(sIn: number): number {
    const s = this.wrap(sIn);
    const idx = this.cfg.sectors.findIndex((sc) => s >= sc.from_m && s < sc.to_m);
    return idx < 0 ? this.cfg.sectors.length - 1 : idx;
  }

  sectorAt(s: number) {
    return this.cfg.sectors[this.sectorIndexAt(s)];
  }

  incidentZonesAt(sIn: number) {
    const s = this.wrap(sIn);
    return this.cfg.incidentZones.filter((z) => s >= z.from_m && s < z.to_m);
  }

  xyAt(sIn: number): { x: number; y: number; heading: number } {
    const s = this.wrap(sIn);
    const j = this.segmentIndexAt(s);
    const seg = this.cfg.segments[j];
    const f = (s - seg.start_m) / (seg.end_m - seg.start_m);
    return this.segPolys[j].at(f);
  }

  headingAt(s: number): number {
    return this.xyAt(s).heading;
  }

  pitXyAt(u: number): { x: number; y: number; heading: number } {
    return this.pitPoly.at(u / this.cfg.pitLane.laneLength_m.value);
  }

  /** Payload for GET /track (frontend map). */
  payload(): TrackGeometryPayload {
    const cfg = this.cfg;
    const centerline: TrackGeometryPayload['centerline'] = [];
    for (let s = 0; s < this.lapLength; s += 10) {
      const p = this.xyAt(s);
      centerline.push({ x: round(p.x), y: round(p.y), s, seg: this.segmentAt(s).id });
    }
    const segPolyline = (from: number, to: number, step = 8): [number, number][] => {
      const out: [number, number][] = [];
      for (let s = from; s < to; s += step) {
        const p = this.xyAt(s);
        out.push([round(p.x), round(p.y)]);
      }
      const p = this.xyAt(to - 1e-6);
      out.push([round(p.x), round(p.y)]);
      return out;
    };
    const lane = cfg.pitLane;
    const st = (u: number): [number, number] => {
      const p = this.pitXyAt(u);
      return [round(p.x), round(p.y)];
    };
    const sf = this.xyAt(0);
    return {
      name: cfg.name,
      viewBox: cfg.viewBox,
      lapLength_m: this.lapLength,
      centerline,
      segments: cfg.segments.map((seg) => ({
        id: seg.id,
        name: seg.name,
        type: seg.type,
        start_m: seg.start_m,
        end_m: seg.end_m,
        length_m: seg.end_m - seg.start_m,
        elevation_m: seg.elevation_m,
        banking_deg: seg.banking_deg,
        cornerRadius_m: seg.cornerRadius_m,
        drawnMinRadius_m: seg.drawnMinRadius_m,
        dryGrip: seg.dryGrip,
        wetGrip: seg.wetGrip,
        polyline: segPolyline(seg.start_m, seg.end_m),
      })),
      pitLane: {
        polyline: lane.points,
        stations: {
          entry: st(0),
          line: st(lane.timingLine_u_m.value),
          box: st(lane.box_u_m.value),
          exit: st(lane.laneLength_m.value),
        },
        laneLength_m: lane.laneLength_m.value,
        timingLine_u_m: lane.timingLine_u_m.value,
        box_u_m: lane.box_u_m.value,
        entry_s_m: lane.entry_s_m,
        exit_s_m: lane.exit_s_m,
        speedLimit_kph: lane.speedLimit_kph.value,
      },
      sectors: cfg.sectors.map((sc) => {
        const p = this.xyAt(sc.from_m);
        return { id: sc.id, from_m: sc.from_m, to_m: sc.to_m, boundary: [round(p.x), round(p.y)] as [number, number] };
      }),
      incidentZones: cfg.incidentZones.map((z) => ({
        id: z.id,
        name: z.name,
        level: z.level,
        categories: z.categories,
        polyline: segPolyline(z.from_m, z.to_m),
        provenance: z.provenance,
      })),
      startFinish: { point: [round(sf.x), round(sf.y)], heading: sf.heading },
    };
  }
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}
