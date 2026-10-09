import { useEffect, useMemo, useState } from 'react';
import type { SegmentOverride, TrackGeometryPayload } from '@pitwall/shared';
import type { ColourBy } from '../../store/trackStore';
import { scaleLinear } from 'd3-scale';
import { line } from 'd3-shape';
import { Panel } from '../layout/Panel';
import { ProvenanceBadge } from '../layout/Badge';
import { api, type TrackPreview } from '../../api/client';
import { TrackMapper } from '../../lib/geometry';
import { useRace } from '../../store/raceStore';
import { inject } from '../../store/session';
import { useUi } from '../../store/uiStore';
import { raceOverrides, useTrack } from '../../store/trackStore';
import { useShownLaps } from '../race/useDisplayed';
import { egoRecord } from '../../lib/derive';
import { fmt } from '../../lib/format';
const TYPE_COLOR: Record<string, string> = { straight: '#5BB8FF', banked: '#D7FF3F', corner: '#FF8C42', chicane: '#FF5A5A', bus_stop: '#FF5A5A', kink: '#B48CFF' };

function gripColor(g: number): string {
  const t = Math.max(0, Math.min(1, (g - 0.5) / 0.6));
  const r = Math.round(255 * (1 - t) + 62 * t);
  const gg = Math.round(90 * (1 - t) + 213 * t);
  const b = Math.round(90 * (1 - t) + 152 * t);
  return `rgb(${r},${gg},${b})`;
}

export function TrackView() {
  const [track, setTrack] = useState<TrackGeometryPayload | null>(useRace.getState().init?.track ?? null);
  const t = useTrack();
  const { wetness, temp, rubber, overrides, segId, colourBy, marker, wetAll, tempOffset, applied } = t;
  const setWetness = (v: number) => t.set({ wetness: v });
  const setTemp = (v: number) => t.set({ temp: v });
  const setRubber = (v: number) => t.set({ rubber: v });
  const setSegId = (v: string) => t.set({ segId: v });
  const setMarker = (v: number) => t.set({ marker: v });
  const [preview, setPreview] = useState<TrackPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const runState = useRace((s) => s.state);
  const live = runState !== 'none' && runState !== 'finished';
  const world = useUi((s) => s.world);
  const shown = useShownLaps(world);
  const ego = useRace((s) => s.init?.ego ?? 12);
  const lastLap = shown[shown.length - 1];
  const env = lastLap?.env;
  const nowLap = lastLap ? (egoRecord(lastLap, ego)?.lap ?? 0) : 0;

  useEffect(() => {
    if (!track) api.track().then(setTrack).catch((e) => setErr(String(e)));
  }, [track]);
  useEffect(() => {
    const h = setTimeout(() => {
      api
        .preview({ wetness, trackTemp_C: temp + tempOffset, rubber, overrides: track ? raceOverrides(track.segments.map((g) => g.id), overrides, wetAll) : overrides })
        .then((p) => {
          setPreview(p);
          setErr(null);
        })
        .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    }, 150);
    return () => clearTimeout(h);
  }, [wetness, temp, rubber, overrides, wetAll, tempOffset, track]);
  const map = useMemo(() => (track ? new TrackMapper(track) : null), [track]);
  if (!track || !map) return <div className="p-6 mono text-muted">{err ?? 'Loading track…'}</div>;

  const seg = track.segments.find((s) => s.id === segId)!;
  const segPrev = preview?.segments.find((s) => s.id === segId);
  const ov = overrides.find((o) => o.segmentId === segId) ?? { segmentId: segId };
  const setOv = (patch: Partial<SegmentOverride>) => {
    const next = { ...ov, ...patch };
    const clean = !next.debris && !next.wetnessOffset;
    t.set({ overrides: [...overrides.filter((o) => o.segmentId !== segId), ...(clean ? [] : [next])] });
  };
  // preview: the race set-up's offsets are added on top of the sliders, so the numbers show what the cars will feel
  const previewOverrides = raceOverrides(track.segments.map((s) => s.id), overrides, wetAll);
  const applyToRace = () => {
    const ovs = raceOverrides(track.segments.map((s) => s.id), overrides, wetAll);
    void inject('surface', { overrides: ovs, trackTempOffset_C: tempOffset }, `track set-up: ${ovs.length} segment(s), ${tempOffset >= 0 ? '+' : ''}${tempOffset} °C`);
    t.set({ applied: { overrides: ovs, trackTempOffset_C: tempOffset, wetAll, atLap: nowLap } });
  };
  const resetRace = () => {
    void inject('surface', { overrides: [], trackTempOffset_C: 0 }, 'track set-up reset to original');
    t.set({ applied: null });
  };
  const useLive = () => env && t.set({ wetness: Number(env.wetness.toFixed(2)), temp: Math.round(env.trackTemp_C) });
  const engineSurface = env?.surface;
  const engineActive = !!engineSurface && (engineSurface.overrides.length > 0 || engineSurface.trackTempOffset_C !== 0);
  const colourOf = (id: string) => {
    const p = preview?.segments.find((s) => s.id === id);
    if (colourBy === 'type') return TYPE_COLOR[track.segments.find((s) => s.id === id)!.type] ?? '#888';
    if (colourBy === 'wetness') return `rgba(59,125,216,${0.25 + 0.75 * (p?.wetness ?? 0)})`;
    return gripColor(p?.effectiveGrip ?? 1);
  };
  const markerSeg = track.segments.find((s) => marker >= s.start_m && marker < s.end_m);
  const markerSector = track.sectors.find((s) => marker >= s.from_m && marker < s.to_m);
  const markerPt = map.at(marker);
  const sp = preview?.speedProfile;
  const W = 1000;
  const H = 220;
  const xs = scaleLinear().domain([0, track.lapLength_m]).range([40, W - 10]);
  const ys = scaleLinear().domain([0, Math.max(300, ...(sp?.v ?? [0]))]).range([H - 20, 10]);
  const vline = sp ? line<number>().x((_, i) => xs(sp.s[i])).y((v) => ys(v))(sp.v) : '';
  const d = preview?.diagnostics;

  return (
    <div className="grid gap-3 p-3 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="flex flex-col gap-3 min-w-0">
        <Panel
          title="Circuit overview"
          right={
            <label className="mono text-[12px] flex items-center gap-2">
              Colour by
              <select className="field !w-36" value={colourBy} onChange={(e) => t.set({ colourBy: e.target.value as ColourBy })}>
                <option value="grip">Effective grip</option>
                <option value="type">Segment type</option>
                <option value="wetness">Wetness</option>
              </select>
            </label>
          }
        >
          <svg viewBox="0 0 1000 620" width="100%" role="img" aria-label="track segments coloured by the selected property">
            <path d={map.centerPath()} fill="none" stroke="var(--asphalt-edge)" strokeWidth={30} strokeLinejoin="round" />
            {track.segments.map((s) => (
              <path
                key={s.id}
                d={map.centerPath(s.start_m, s.end_m, 6)}
                fill="none"
                stroke={colourOf(s.id)}
                strokeWidth={s.id === segId ? 26 : 20}
                strokeOpacity={s.id === segId ? 1 : 0.85}
                onClick={() => setSegId(s.id)}
                style={{ cursor: 'pointer' }}
              >
                <title>{`${s.id} ${s.name}`}</title>
              </path>
            ))}
            {track.incidentZones.map((z) => (
              <g key={z.id}>
                <path d={TrackMapper.path(z.polyline)} fill="none" stroke="var(--b0)" strokeDasharray="5 4" strokeWidth={2} />
                {z.polyline[0] && (
                  <text x={z.polyline[0][0]} y={z.polyline[0][1] - 18} fontSize={10} fill="var(--b0)" fontFamily="Barlow Condensed">
                    {z.id} · L{z.level}
                  </text>
                )}
              </g>
            ))}
            {track.sectors.map((s) => (
              <circle key={s.id} cx={s.boundary[0]} cy={s.boundary[1]} r={4} fill="#fff" />
            ))}
            <path d={TrackMapper.path(track.pitLane.polyline)} fill="none" stroke="#9aa1ab" strokeDasharray="6 5" strokeWidth={2} />
            {previewOverrides
              .filter((o) => o.debris)
              .map((o) => {
                const s = track.segments.find((g) => g.id === o.segmentId)!;
                const p = map.at((s.start_m + s.end_m) / 2);
                return <polygon key={o.segmentId} points={`${p.x},${p.y - 10} ${p.x + 9},${p.y + 6} ${p.x - 9},${p.y + 6}`} fill="var(--caution)" />;
              })}
            <circle cx={markerPt.x} cy={markerPt.y} r={9} fill="var(--opt)" stroke="#0e1013" strokeWidth={2} />
          </svg>
          <input type="range" min={0} max={track.lapLength_m - 1} value={marker} onChange={(e) => setMarker(Number(e.target.value))} aria-label="car marker lap distance" />
          <div className="mono text-[12px]">
            Lap {((marker / track.lapLength_m) * 100).toFixed(1)}% · segment {markerSeg?.id} {markerSeg?.name} · sector {markerSector?.id}
            {track.incidentZones.length ? '' : ''}
          </div>
        </Panel>
        <Panel title="Speed profile · illustrative model output">
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="speed versus lap distance">
            {track.segments.map((s, i) => (
              <rect key={s.id} x={xs(s.start_m)} y={10} width={xs(s.end_m) - xs(s.start_m)} height={H - 30} fill={i % 2 ? 'var(--panel-2)' : 'transparent'} />
            ))}
            {track.segments.map((s) => (
              <text key={s.id} x={(xs(s.start_m) + xs(s.end_m)) / 2} y={H - 4} fontSize={9} textAnchor="middle" fill="var(--muted)" fontFamily="JetBrains Mono">
                {s.id}
              </text>
            ))}
            {ys.ticks(5).map((v) => (
              <text key={v} x={34} y={ys(v) + 3} fontSize={9} textAnchor="end" fill="var(--muted)" fontFamily="JetBrains Mono">
                {v}
              </text>
            ))}
            <path d={vline ?? ''} fill="none" stroke="var(--opt)" strokeWidth={1.75} />
          </svg>
        </Panel>
      </div>
      <div className="flex flex-col gap-3 min-w-0">
        <Panel title="Surface conditions">
          <Slider label="Wetness (global)" value={wetness} min={0} max={1} step={0.01} onChange={setWetness} />
          <Slider label="Track temperature °C (global)" value={temp} min={10} max={60} step={1} onChange={setTemp} />
          <Slider label="Rubber (global)" value={rubber} min={0} max={0.06} step={0.002} onChange={setRubber} />
          <h3 className="panel-title !text-faint">Segment {segId} · per-segment wetness offset and debris only</h3>
          <Slider label="Wetness offset" value={ov.wetnessOffset ?? 0} min={-1} max={1} step={0.05} onChange={(v) => setOv({ wetnessOffset: v })} />
          <label className="flex items-center gap-2 mono text-[12px]">
            <input type="checkbox" checked={!!ov.debris} onChange={(e) => setOv({ debris: e.target.checked })} /> Debris on {segId}
          </label>
          <div className="grid grid-cols-3 gap-2 items-end">
            <div>
              <div className="panel-title">Standing water</div>
              <div className="mono">{fmt(segPrev?.standingWater_mm ?? 0, 1)} mm</div>
            </div>
            <div>
              <div className="panel-title">Hazard</div>
              <div className="mono">{segPrev?.hazard ?? '—'}</div>
            </div>
            <div className="text-right">
              <div className="panel-title">Effective grip</div>
              <div className="big-num text-[40px] text-b0" data-testid="effective-grip">
                {fmt(segPrev?.effectiveGrip ?? null, 3)}
              </div>
            </div>
          </div>
          {err && <div className="text-bad mono text-[11px]">{err}</div>}
        </Panel>
        <Panel
          title="Race set-up · stays until you reset"
          right={
            engineActive ? (
              <span className="mono text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--opt)', color: '#0e1013' }} data-testid="surface-active">
                ACTIVE IN RACE
              </span>
            ) : applied ? (
              <span className="mono text-[11px]" style={{ color: 'var(--caution)' }} title="the engine runs ahead of the display clock; the set-up shows once the display reaches the lap it was applied on">
                SENT · reaches the display shortly
              </span>
            ) : (
              <span className="mono text-[11px] text-muted">original track</span>
            )
          }
        >
          <p className="text-[12px] text-muted">
            Segment wetness offsets and debris (above) plus these two offsets are sent to the race and stay in force in all three worlds, through rain and cautions, until you press reset or apply something else.
          </p>
          <Slider label="Wetness offset on every segment" value={wetAll} min={-0.5} max={0.5} step={0.05} onChange={(v) => t.set({ wetAll: v })} />
          <Slider label="Track temperature offset °C" value={tempOffset} min={-15} max={15} step={1} onChange={(v) => t.set({ tempOffset: v })} />
          <div className="flex gap-2 flex-wrap">
            <button className="btn btn-run" disabled={!live} onClick={applyToRace} data-testid="apply-surface">
              Apply to race
            </button>
            <button className="btn" disabled={!live || (!engineActive && !applied)} onClick={resetRace}>
              Reset to original
            </button>
            <button className="btn" onClick={() => t.resetDraft()}>
              Clear draft
            </button>
            <button className="btn" disabled={!env} onClick={useLive} title="copy the race's current wetness and track temperature into the preview sliders">
              Preview live conditions
            </button>
          </div>
          {!live && <div className="mono text-[11px] text-muted">Start a race to apply a set-up.</div>}
          {engineSurface && engineActive && (
            <div className="mono text-[11.5px] flex flex-col gap-0.5">
              <span>
                In force{applied ? ` since lap ${applied.atLap}` : ''}: {engineSurface.overrides.filter((o) => o.wetnessOffset).length} segment(s) wetter/drier · debris{' '}
                {engineSurface.overrides.filter((o) => o.debris).map((o) => o.segmentId).join(', ') || 'none'} · temp {engineSurface.trackTempOffset_C >= 0 ? '+' : ''}
                {engineSurface.trackTempOffset_C} °C
              </span>
              <span className="text-muted">live race: wetness {env!.wetness.toFixed(2)} · track {env!.trackTemp_C.toFixed(1)} °C</span>
            </div>
          )}
        </Panel>
        <Panel title={`Segment inspector · ${seg.id}`}>
          <select className="field !w-full !text-left" value={segId} onChange={(e) => setSegId(e.target.value)} aria-label="segment">
            {track.segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} · {s.name}
              </option>
            ))}
          </select>
          <table className="data">
            <tbody>
              <tr><td>Segment</td><td className="!font-sans">{seg.name}</td><td /></tr>
              <tr><td>Type</td><td>{seg.type}</td><td /></tr>
              <tr><td>Length</td><td>{seg.length_m.toFixed(0)} m</td><td /></tr>
              <tr><td>Lap distance</td><td>{seg.start_m.toFixed(0)}–{seg.end_m.toFixed(0)} m</td><td /></tr>
              <tr><td>Elevation</td><td>{seg.elevation_m.value} m</td><td><ProvenanceBadge p={seg.elevation_m.provenance} /></td></tr>
              <tr><td>Banking</td><td>{seg.banking_deg.value}°</td><td><ProvenanceBadge p={seg.banking_deg.provenance} /></td></tr>
              <tr><td>Corner radius (solver)</td><td>{seg.cornerRadius_m ? `${seg.cornerRadius_m.value} m` : '—'}</td><td>{seg.cornerRadius_m && <ProvenanceBadge p={seg.cornerRadius_m.provenance} />}</td></tr>
              <tr><td>Drawn min. radius (display)</td><td>{seg.drawnMinRadius_m.toFixed(0)} m</td><td /></tr>
              <tr><td>Dry grip</td><td>{seg.dryGrip.value}</td><td><ProvenanceBadge p={seg.dryGrip.provenance} /></td></tr>
              <tr><td>Wet grip</td><td>{seg.wetGrip.value}</td><td><ProvenanceBadge p={seg.wetGrip.provenance} /></td></tr>
            </tbody>
          </table>
        </Panel>
        <Panel title="Diagnostics · illustrative model outputs">
          <table className="data">
            <tbody>
              <tr><td>Lap time (these conditions)</td><td>{fmt(preview?.lapTime_s ?? null, 2)} s</td></tr>
              <tr><td>Sector times</td><td>{preview ? preview.sectorTimes_s.map((x) => x.toFixed(2)).join(' / ') : '—'}</td></tr>
              <tr><td>Reference lap / μ peak</td><td>{d ? `${d.lapRef_s.toFixed(2)} s / ${d.mu_peak.toFixed(4)}` : '—'}</td></tr>
              <tr><td>c_f (s per kg fuel)</td><td>{fmt(d?.c_f_s_per_kg ?? null, 4)}</td></tr>
              <tr><td>Top speed</td><td>{d ? `${d.topSpeed_kph.toFixed(0)} km/h @ ${d.topSpeedAt_m.toFixed(0)} m (${d.topSpeedSegment})` : '—'}</td></tr>
              <tr><td>S04 / S08 minimum</td><td>{d ? `${d.minSpeedS04_kph.toFixed(0)} / ${d.minSpeedS08_kph.toFixed(0)} km/h` : '—'}</td></tr>
              <tr><td>Pit: full / net green / net caution</td><td>{d ? `${d.pit.fullStop_s.toFixed(1)} / ${d.pit.netGreen_s.toFixed(1)} / ${d.pit.netCaution_s.toFixed(1)} s` : '—'}</td></tr>
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange(v: number): void }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="flex justify-between text-[12px] text-muted">
        {label}
        <span className="mono text-text">{value.toFixed(step < 0.01 ? 3 : 2)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
