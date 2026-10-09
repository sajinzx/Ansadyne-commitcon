import { describe, expect, it } from 'vitest';
import { defaultConfigs } from '@pitwall/shared';
import { TrackGeometry } from '../src/track/geometry';
import { segmentGrips, segmentNode, fTrk, sTrack } from '../src/track/surface';

const { track } = defaultConfigs();
const geo = new TrackGeometry(track);

describe('M02 track geometry', () => {
  it('segments are contiguous, sum to 5,730 m, radii only where an apex window exists', () => {
    let s = 0;
    for (const seg of track.segments) {
      expect(seg.start_m).toBe(s);
      s = seg.end_m;
      if (seg.apex.length === 0) expect(seg.cornerRadius_m).toBeNull();
      else expect(seg.cornerRadius_m).not.toBeNull();
      if (seg.type === 'banked_turn') expect(seg.apex[0].window_m).toBe(seg.end_m - seg.start_m);
    }
    expect(s).toBe(5730);
  });

  it('lookups match the spec examples', () => {
    expect(geo.segmentAt(2500).id).toBe('S05');
    expect(geo.sectorAt(3000).id).toBe('SC2');
    expect(geo.incidentZonesAt(4500).map((z) => z.id)).toEqual(['IZ4']);
    expect(geo.segmentAt(5729.9).id).toBe('S11');
    expect(geo.segmentAt(5730).id).toBe('S01');
  });

  it('xyAt(0) is the S01 start point and the centreline is continuous across joints', () => {
    const p = geo.xyAt(0);
    expect(p.x).toBeCloseTo(track.segments[0].points[0][0], 6);
    expect(p.y).toBeCloseTo(track.segments[0].points[0][1], 6);
    for (const seg of track.segments) {
      const a = geo.xyAt(seg.start_m - 1e-7);
      const b = geo.xyAt(seg.start_m);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1);
    }
    // continuity along the whole lap at 1 m resolution
    let maxJump = 0;
    let prev = geo.xyAt(0);
    for (let s = 1; s <= 5730; s++) {
      const q = geo.xyAt(s);
      maxJump = Math.max(maxJump, Math.hypot(q.x - prev.x, q.y - prev.y));
      prev = q;
    }
    expect(maxJump).toBeLessThan(5);
  });

  it('pit-lane stations are ordered and the lane endpoints match the polyline', () => {
    const lane = track.pitLane;
    expect(lane.timingLine_u_m.value).toBeLessThan(lane.box_u_m.value);
    expect(lane.box_u_m.value).toBeLessThan(lane.laneLength_m.value);
    const a = geo.pitXyAt(0);
    const b = geo.pitXyAt(lane.laneLength_m.value);
    expect([a.x, a.y]).toEqual(lane.points[0]);
    expect([b.x, b.y]).toEqual(lane.points[lane.points.length - 1]);
    expect(geo.stretch_m).toBe(1001);
  });

  it('builds the 2,865-node solver grid with radii only inside apex windows', () => {
    expect(geo.grid.n).toBe(2865);
    const s03 = Array.from(geo.grid.seg).map((j, i) => [j, i]).filter(([j]) => track.segments[j].id === 'S03');
    expect(s03.every(([, i]) => geo.grid.invR[i] === 0)).toBe(true);
    const s10 = Array.from(geo.grid.seg).map((j, i) => [j, i]).filter(([j]) => track.segments[j].id === 'S10');
    expect(s10.every(([, i]) => Math.abs(geo.grid.invR[i] - 1 / 284) < 1e-12)).toBe(true);
  });
});

describe('M02 surface grip', () => {
  it('S01 dry at 30 °C with no rubber is 1.011', () => {
    const g = segmentGrips(track, { wetness: 0, trackTemp_C: 30, rubber: 0, overrides: [] });
    expect(g[0].effectiveGrip).toBeCloseTo(1.0111, 3);
    expect(fTrk(38)).toBe(1);
    expect(fTrk(-100)).toBe(0.8);
  });

  it('debris lowers the node part by exactly 0.08 and grip never drops below the floor', () => {
    const a = segmentNode(1.0, 0.58, 0.2);
    const b = segmentNode(1.0, 0.58, 0.2, { segmentId: 'S02', debris: true });
    expect(a.node - b.node).toBeCloseTo(0.08, 12);
    const floor = segmentNode(0.1, 0.05, 1, { segmentId: 'S02', debris: true });
    expect(floor.node).toBe(0.05);
    expect(sTrack(10, 0, 1, track.meanDryGrip) * floor.node).toBeGreaterThanOrEqual(0.04);
  });

  it('effective grip is S_track × node for random states (exact factorisation)', () => {
    for (let i = 0; i < 200; i++) {
      const st = {
        wetness: (i * 0.137) % 1,
        trackTemp_C: 10 + ((i * 7.3) % 50),
        rubber: ((i * 0.011) % 0.06),
        overrides: i % 3 === 0 ? [{ segmentId: 'S08', wetnessOffset: 0.3, debris: i % 2 === 0 }] : [],
      };
      const S = sTrack(st.trackTemp_C, st.rubber, st.wetness, track.meanDryGrip);
      for (const g of segmentGrips(track, st)) expect(Math.abs(g.effectiveGrip - S * g.node)).toBeLessThan(1e-12);
    }
  });
});
