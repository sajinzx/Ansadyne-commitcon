import { useMemo, useState } from 'react';
import type { CarLapRecord, StrategyId } from '@pitwall/shared';
import { Panel } from '../layout/Panel';
import { WORLD_COLOR } from '../layout/Badge';
import { useRace, WORLDS } from '../../store/raceStore';
import { useUi } from '../../store/uiStore';
import { TrackMapper } from '../../lib/geometry';
import { carPose, recordAt, type CarPose } from '../../lib/animation';
import { egoRecord } from '../../lib/derive';
import { fmt, lapTimeStr } from '../../lib/format';

const SECTOR_COLORS = ['var(--opt)', 'var(--b1)', 'var(--b0)'];

export function useMapper(): TrackMapper | null {
  const init = useRace((s) => s.init);
  return useMemo(() => (init ? new TrackMapper(init.track, init.tau) : null), [init]);
}

export function RaceMap() {
  const map = useMapper();
  const init = useRace((s) => s.init);
  const recs = useRace((s) => s.recs);
  const laps = useRace((s) => s.laps);
  const events = useRace((s) => s.events);
  const t = useUi((s) => s.displayTime);
  const world = useUi((s) => s.world);
  const ghosts = useUi((s) => s.ghosts);
  const setWorld = useUi((s) => s.setWorld);
  const toggleGhost = useUi((s) => s.toggleGhost);
  const selected = useUi((s) => s.selectedCar);
  const [hover, setHover] = useState<{ no: number; x: number; y: number } | null>(null);

  const chips = (
    <>
      {WORLDS.map((w) => (
        <button
          key={w}
          className="badge cursor-pointer"
          style={world === w ? { background: WORLD_COLOR[w], color: '#0e1013', borderColor: WORLD_COLOR[w] } : { color: WORLD_COLOR[w], opacity: ghosts[w] ? 1 : 0.45 }}
          onClick={(e) => (e.shiftKey ? toggleGhost(w) : setWorld(w))}
          title="click: show this world · shift-click: toggle its ghost"
          aria-pressed={world === w}
        >
          {w}
        </button>
      ))}
    </>
  );

  if (!map || !init) {
    return (
      <Panel title="Race map" right={chips} className="min-h-[420px]">
        <div className="flex-1 grid place-items-center text-muted mono">Press RUN to build a synthetic race (calibration takes a few seconds).</div>
      </Panel>
    );
  }
  const track = init.track;
  const ego = init.ego;
  const le = (() => {
    const arr = laps[world];
    let found = arr[0];
    for (const x of arr) {
      const r = egoRecord(x, ego);
      if (r && r.lapStart_s <= t) found = x;
    }
    return found;
  })();
  const egoRec = le ? egoRecord(le, ego) : undefined;
  const caution = !!le?.caution.active;
  const wetness = le?.env.wetness ?? 0;
  const lap = egoRec?.lap ?? 0;

  const poses: { no: number; pose: CarPose }[] = [];
  const retired: CarLapRecord[] = [];
  for (const [no, list] of Object.entries(recs[world])) {
    const pose = carPose(list, t, map);
    if (pose) poses.push({ no: Number(no), pose });
    else {
      const last = list[list.length - 1];
      if (last && !last.running && !last.classified && last.lapStart_s <= t) retired.push(last);
    }
  }
  const ghostPoses: { w: StrategyId; pose: CarPose }[] = [];
  for (const w of WORLDS) {
    if (w === world || !ghosts[w]) continue;
    const p = recs[w][ego] ? carPose(recs[w][ego], t, map) : null;
    if (p) ghostPoses.push({ w, pose: p });
  }
  // debris markers from injections (shown for ~10 laps)
  const debris = events.filter((e) => e.ev.type === 'injected' && e.ev.injection.kind === 'debris' && lap - e.step <= 10 && e.step <= lap).map((e) => (e.ev.type === 'injected' ? e.ev.injection.params?.segmentId ?? 'S08' : 'S08'));
  const segMid = (id: string) => {
    const s = track.segments.find((g) => g.id === id);
    return s ? map.at((s.start_m + s.end_m) / 2) : { x: 0, y: 0 };
  };
  const status = caution ? 'CAUTION · FIELD BUNCHED' : wetness > 0.15 ? `RAIN · WETNESS ${wetness.toFixed(2)}` : 'GREEN FLAG';
  const hoverRec = hover ? recordAt(recs[world][hover.no] ?? [], t) : null;
  const belief = hover?.no === ego ? hoverRec?.ego?.belief : null;
  const box = map.lane(track.pitLane.box_u_m);
  const line = map.lane(track.pitLane.timingLine_u_m);
  const sf = track.startFinish;

  return (
    <Panel title="Race map" right={chips}>
      <div className="relative w-full" style={{ aspectRatio: '1000 / 620' }}>
        <svg viewBox="0 0 1000 620" className="absolute inset-0 w-full h-full" role="img" aria-label={`Daytona road course map, lap ${lap}, ${status.toLowerCase()}`}>
          <path d={map.centerPath()} fill="none" stroke={caution ? 'var(--caution)' : 'var(--asphalt-edge)'} strokeOpacity={caution ? 0.55 : 1} strokeWidth={caution ? 34 : 30} strokeLinejoin="round" />
          <path d={map.centerPath()} fill="none" stroke="var(--asphalt)" strokeWidth={28} strokeLinejoin="round" />
          {wetness > 0.02 && <path d={map.centerPath()} fill="none" stroke="var(--wet)" strokeOpacity={Math.min(0.6, wetness * 0.6)} strokeWidth={28} strokeLinejoin="round" />}
          {track.sectors.map((sc, i) => (
            <path key={sc.id} d={map.centerPath(sc.from_m, sc.to_m, 8)} fill="none" stroke={SECTOR_COLORS[i]} strokeOpacity={0.85} strokeWidth={3} />
          ))}
          <path d={TrackMapper.path(track.pitLane.polyline)} fill="none" stroke="#9aa1ab" strokeDasharray="6 5" strokeWidth={2} />
          <text x={(line.x + box.x) / 2} y={(line.y + box.y) / 2 + 18} fill="var(--muted)" fontSize={10} fontFamily="Barlow Condensed" letterSpacing="0.1em">
            PIT ROAD
          </text>
          <circle cx={box.x} cy={box.y} r={3} fill="#fff" />
          <circle cx={line.x} cy={line.y} r={2} fill="var(--muted)" />
          <g transform={`translate(${sf.point[0]},${sf.point[1]}) rotate(${(sf.heading * 180) / Math.PI + 90})`}>
            <rect x={-1.5} y={-18} width={3} height={36} fill="#fff" />
          </g>
          <text x={sf.point[0]} y={sf.point[1] + 34} fill="#fff" fontSize={10} textAnchor="middle" fontFamily="Barlow Condensed" letterSpacing="0.1em">
            START / FINISH
          </text>
          {(['S01', 'S10', 'S11'] as const).map((id) => {
            const seg = track.segments.find((g) => g.id === id);
            const p = segMid(id);
            return seg ? (
              <text key={id} x={p.x} y={p.y - 22} fill="var(--muted)" fontSize={11} textAnchor="middle" fontFamily="JetBrains Mono">
                {seg.banking_deg.value}°
              </text>
            ) : null;
          })}
          {debris.map((id, i) => {
            const p = segMid(id);
            return (
              <g key={`${id}${i}`}>
                <polygon points={`${p.x},${p.y - 10} ${p.x + 9},${p.y + 6} ${p.x - 9},${p.y + 6}`} fill="var(--caution)" />
                <text x={p.x} y={p.y + 4} fontSize={9} textAnchor="middle" fill="#0e1013" fontWeight={700}>
                  !
                </text>
              </g>
            );
          })}
          <text x={500} y={300} textAnchor="middle" fontFamily="Barlow Condensed" fontWeight={700} fontSize={56} fill="var(--text)" opacity={0.92}>
            LAP {lap}
          </text>
          <text x={500} y={326} textAnchor="middle" fontFamily="Barlow Condensed" fontSize={14} letterSpacing="0.14em" fill={caution ? 'var(--caution)' : wetness > 0.15 ? 'var(--wet)' : 'var(--good)'}>
            {status}
          </text>
          {ghostPoses.map(({ w, pose }) => (
            <circle key={w} cx={pose.x} cy={pose.y} r={12} fill="none" stroke={WORLD_COLOR[w]} strokeWidth={2.5}>
              <title>{`our car in ${w}`}</title>
            </circle>
          ))}
          {poses
            .sort((a, b) => (a.no === ego ? 1 : b.no === ego ? -1 : 0))
            .map(({ no, pose }) => {
              const isEgo = no === ego;
              return (
                <g
                  key={no}
                  transform={`translate(${pose.x},${pose.y})`}
                  onMouseEnter={() => setHover({ no, x: pose.x, y: pose.y })}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: 'pointer' }}
                  data-testid={isEgo ? 'ego-car' : undefined}
                >
                  {isEgo && <circle className="pulse" r={12} fill="none" stroke="var(--opt)" strokeWidth={2} />}
                  <circle r={12} fill={isEgo ? 'var(--opt)' : '#2B3038'} stroke={selected === no ? '#fff' : isEgo ? 'var(--opt)' : '#6B7380'} strokeWidth={selected === no ? 2.5 : 1.5} />
                  <text textAnchor="middle" dy={4} fontSize={11} fontFamily="JetBrains Mono" fontWeight={isEgo ? 700 : 500} fill={isEgo ? '#0e1013' : '#fff'}>
                    {no}
                  </text>
                </g>
              );
            })}
        </svg>
        {hover && hoverRec && (
          <div className="absolute panel pointer-events-none mono text-[11px] leading-5 !p-2 z-10" style={{ left: `${(hover.x / 1000) * 100}%`, top: `${(hover.y / 620) * 100}%`, transform: 'translate(14px, 14px)', minWidth: 190 }}>
            <div className="panel-title !text-text">
              #{hover.no} · P{hoverRec.position} {hover.no === ego ? '· our car' : ''}
            </div>
            <div>gap {hoverRec.lapsDown > 0 ? `+${hoverRec.lapsDown} lap` : `+${fmt(hoverRec.gapLeader_s, 1)} s`} · last {lapTimeStr(hoverRec.lapTime_s)}</div>
            <div>
              {hoverRec.compound} · {hoverRec.tyreAgeLaps} laps · stops {hoverRec.stops}
            </div>
            {belief ? (
              <div>
                wear {fmt(belief.W.mean * 100, 0)}% ± {fmt(belief.W.sd * 100, 0)} · fuel {fmt(belief.fuel.mean, 1)} ± {fmt(belief.fuel.sd, 1)} kg
              </div>
            ) : (
              <div className="text-muted">wear, fuel: hidden</div>
            )}
            {hover.no === ego && hoverRec.ego?.plan?.stops[0] && <div>plan: pit lap {hoverRec.ego.plan.stops[0].lap}</div>}
            {hoverRec.pit && <div className="text-caution">in pit lane</div>}
          </div>
        )}
      </div>
      <div className="flex justify-between gap-3 flex-wrap text-muted text-[11px]">
        <span>S1 lime · S2 blue · S3 orange · Schematic layout, lengths scaled to 5.73 km. Hover a car for state. Ghosts show the same car under each strategy. Rivals follow fixed synthetic policies.</span>
        {retired.length > 0 && <span className="mono text-bad">Retired: {retired.map((r) => `#${r.no} (${r.dnf?.cause ?? 'dnf'})`).join(', ')}</span>}
      </div>
    </Panel>
  );
}
