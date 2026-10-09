// F.5 — where a car is at display time t, from its lap records (never extrapolated beyond the last record).
import type { CarLapRecord } from '@pitwall/shared';
import type { Pt, TrackMapper } from './geometry';

export interface CarPose extends Pt {
  s: number | null; // lap distance (null while in the pit lane)
  u: number | null; // pit-lane distance
  inLane: boolean;
  stationary: boolean;
  rec: CarLapRecord;
}

/** The record whose lap covers t (records sorted by lapStart), or null. */
export function recordAt(recs: CarLapRecord[], t: number): CarLapRecord | null {
  let lo = 0;
  let hi = recs.length - 1;
  if (hi < 0 || t < recs[0].lapStart_s) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (recs[mid].lapStart_s <= t) lo = mid;
    else hi = mid - 1;
  }
  const r = recs[lo];
  return t < r.lapStart_s + r.lapTime_s ? r : null;
}

export function carPose(recs: CarLapRecord[], t: number, map: TrackMapper): CarPose | null {
  const rec = recordAt(recs, t);
  if (!rec) return null;
  const lane = map.track.pitLane;
  const t0 = rec.lapStart_s;
  const t1 = rec.lapStart_s + rec.lapTime_s;
  const onTrack = (s: number): CarPose => ({ ...map.at(s), s, u: null, inLane: false, stationary: false, rec });
  const inLane = (u: number, stationary = false): CarPose => ({ ...map.lane(u), s: null, u, inLane: true, stationary, rec });
  const pit = rec.pit;
  if (pit?.phase === 'in' && pit.t_entry !== undefined && pit.t_line !== undefined) {
    if (t < pit.t_entry) {
      const tauE = map.tauAt(lane.entry_s_m);
      const phi = ((t - t0) / Math.max(1e-6, pit.t_entry - t0)) * tauE;
      return onTrack(Math.min(lane.entry_s_m, map.sAtTau(phi)));
    }
    const f = (t - pit.t_entry) / Math.max(1e-6, pit.t_line - pit.t_entry);
    return inLane(Math.min(1, f) * lane.timingLine_u_m);
  }
  if (pit?.phase === 'out' && pit.t_box !== undefined && pit.t_exit !== undefined) {
    const svc = pit.service_s ?? 0;
    if (t < pit.t_box) return inLane(lane.timingLine_u_m + ((t - t0) / Math.max(1e-6, pit.t_box - t0)) * (lane.box_u_m - lane.timingLine_u_m));
    if (t < pit.t_box + svc) return inLane(lane.box_u_m, true);
    if (t < pit.t_exit) {
      const f = (t - pit.t_box - svc) / Math.max(1e-6, pit.t_exit - pit.t_box - svc);
      return inLane(lane.box_u_m + f * (lane.laneLength_m - lane.box_u_m));
    }
    const tauX = map.tauAt(lane.exit_s_m);
    const phi = tauX + ((t - pit.t_exit) / Math.max(1e-6, t1 - pit.t_exit)) * (1 - tauX);
    return onTrack(Math.max(lane.exit_s_m, map.sAtTau(phi)));
  }
  return onTrack(map.sAtTau((t - t0) / Math.max(1e-6, rec.lapTime_s)));
}
