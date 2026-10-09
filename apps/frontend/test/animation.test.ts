import { describe, expect, it } from 'vitest';
import type { CarLapRecord, RunInfo, StreamMessage } from '@pitwall/shared';
import fixture from './fixtures/stream.json';
import { TrackMapper } from '../src/lib/geometry';
import { carPose } from '../src/lib/animation';

const info = (fixture as unknown as StreamMessage[])[0].payload as RunInfo;
const init = info.init!;
const map = new TrackMapper(init.track, init.tau);
const lane = init.track.pitLane;

function rec(over: Partial<CarLapRecord>): CarLapRecord {
  return {
    no: 12, lap: 10, lapStart_s: 1000, lapTime_s: 107, lineCross_s: 1107, sectorTimes_s: [29, 47, 31], position: 5, lapsDown: 0, gapLeader_s: 3, gapAhead_s: 1,
    compound: 'dry', tyreAgeLaps: 9, stops: 0, flag: 'green', pit: null, running: true, classified: false, mode: 'normal', ...over,
  };
}

describe('car animation through the pit lane', () => {
  it('in-lap: on track until lane entry, then the lane up to the timing line', () => {
    const r = rec({ lapTime_s: 112, pit: { phase: 'in', t_entry: 1000 + 104, t_line: 1112 } });
    const a = carPose([r], 1050, map)!;
    expect(a.inLane).toBe(false);
    expect(a.s!).toBeLessThan(lane.entry_s_m);
    const b = carPose([r], 1108, map)!;
    expect(b.inLane).toBe(true);
    expect(b.u!).toBeGreaterThan(0);
    expect(b.u!).toBeLessThanOrEqual(lane.timingLine_u_m);
  });

  it('out-lap: lane stations in order, stationary during service, then back on track after the exit', () => {
    const tBox = 1000 + (lane.box_u_m - lane.timingLine_u_m) / (lane.speedLimit_kph / 3.6);
    const svc = 30;
    const tExit = tBox + svc + (lane.laneLength_m - lane.box_u_m) / (lane.speedLimit_kph / 3.6) + 2.5;
    const r = rec({ lapTime_s: 160, pit: { phase: 'out', t_box: tBox, service_s: svc, t_exit: tExit } });
    const us: number[] = [];
    for (let t = 1000; t < tExit; t += 0.5) {
      const p = carPose([r], t, map)!;
      expect(p.inLane).toBe(true);
      us.push(p.u!);
    }
    for (let i = 1; i < us.length; i++) expect(us[i]).toBeGreaterThanOrEqual(us[i - 1] - 1e-9);
    expect(us[0]).toBeCloseTo(lane.timingLine_u_m, 3);
    const s1 = carPose([r], tBox + 1, map)!;
    const s2 = carPose([r], tBox + svc - 1, map)!;
    expect(s1.stationary && s2.stationary).toBe(true);
    expect([s1.x, s1.y]).toEqual([s2.x, s2.y]);
    const after = carPose([r], tExit + 5, map)!;
    expect(after.inLane).toBe(false);
    expect(after.s!).toBeGreaterThanOrEqual(lane.exit_s_m);
  });

  it('normal laps follow the τ curve and never extrapolate past the last record', () => {
    const r = rec({});
    const mid = carPose([r], 1000 + 53.5, map)!;
    expect(mid.s!).toBeGreaterThan(0);
    expect(mid.s!).toBeLessThan(map.L);
    expect(carPose([r], 1107.1, map)).toBeNull();
  });
});
