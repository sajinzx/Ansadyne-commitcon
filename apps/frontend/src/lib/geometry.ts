// Map lap distance and pit-lane distance to SVG points, and invert the τ curve (lap-time fraction → distance).
import type { RunInit, TrackGeometryPayload } from '@pitwall/shared';

export interface Pt {
  x: number;
  y: number;
}

function cumulative(poly: [number, number][]): number[] {
  const c = [0];
  for (let i = 1; i < poly.length; i++) c.push(c[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]));
  return c;
}

function bisect(a: ArrayLike<number>, v: number): number {
  let lo = 0;
  let hi = a.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= v) lo = mid;
    else hi = mid;
  }
  return lo;
}

export class TrackMapper {
  private readonly cs: number[];
  private readonly laneCum: number[];
  private readonly laneScale: number;

  constructor(
    readonly track: TrackGeometryPayload,
    readonly tau?: RunInit['tau'],
  ) {
    this.cs = track.centerline.map((p) => p.s);
    this.laneCum = cumulative(track.pitLane.polyline);
    this.laneScale = (this.laneCum[this.laneCum.length - 1] || 1) / track.pitLane.laneLength_m;
  }

  get L(): number {
    return this.track.lapLength_m;
  }

  /** Point on the centreline at lap distance s. */
  at(s: number): Pt {
    const L = this.L;
    const cl = this.track.centerline;
    const ss = ((s % L) + L) % L;
    const i = bisect(this.cs, ss);
    const a = cl[i];
    const b = cl[(i + 1) % cl.length];
    const sb = i + 1 < cl.length ? b.s : L;
    const f = sb > a.s ? (ss - a.s) / (sb - a.s) : 0;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }

  segmentAt(s: number): string {
    const L = this.L;
    const ss = ((s % L) + L) % L;
    return this.track.segments.find((g) => ss >= g.start_m && ss < g.end_m)?.id ?? this.track.segments[0].id;
  }

  /** Point in the pit lane at lane distance u (0 = lane entry, laneLength = exit). */
  lane(u: number): Pt {
    const poly = this.track.pitLane.polyline;
    const d = Math.max(0, Math.min(this.laneCum[this.laneCum.length - 1], u * this.laneScale));
    const i = Math.min(poly.length - 2, bisect(this.laneCum, d));
    const seg = this.laneCum[i + 1] - this.laneCum[i] || 1;
    const f = (d - this.laneCum[i]) / seg;
    return { x: poly[i][0] + (poly[i + 1][0] - poly[i][0]) * f, y: poly[i][1] + (poly[i + 1][1] - poly[i][1]) * f };
  }

  /** τ(s): fraction of a reference lap's time spent before s. */
  tauAt(s: number): number {
    if (!this.tau) return s / this.L;
    const { s: S, tau } = this.tau;
    const i = bisect(S, s);
    const j = Math.min(S.length - 1, i + 1);
    const f = S[j] > S[i] ? (s - S[i]) / (S[j] - S[i]) : 0;
    return tau[i] + (tau[j] - tau[i]) * f;
  }

  /** τ⁻¹(φ): lap distance reached after a fraction φ of the lap time. */
  sAtTau(phi: number): number {
    if (!this.tau) return phi * this.L;
    const { s: S, tau } = this.tau;
    const p = Math.max(0, Math.min(1, phi));
    const i = bisect(tau, p);
    const j = Math.min(S.length - 1, i + 1);
    const f = tau[j] > tau[i] ? (p - tau[i]) / (tau[j] - tau[i]) : 0;
    return S[i] + (S[j] - S[i]) * f;
  }

  /** SVG path through a polyline. */
  static path(poly: [number, number][], closed = false): string {
    if (!poly.length) return '';
    return poly.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('') + (closed ? 'Z' : '');
  }

  centerPath(from = 0, to = this.L, step = 10): string {
    const pts: [number, number][] = [];
    for (let s = from; s <= to; s += step) {
      const p = this.at(Math.min(s, to - 0.01));
      pts.push([p.x, p.y]);
    }
    return TrackMapper.path(pts, from === 0 && to >= this.L);
  }
}
