import { useEffect, useState, type ReactNode } from 'react';
import type { RunConfig, TrackInfo } from '@pitwall/shared';
import { api } from '../../api/client';
import { Panel } from '../layout/Panel';
import { Badge, ProvenanceBadge } from '../layout/Badge';
import { useRace } from '../../store/raceStore';
import { updateLive, useSession } from '../../store/session';

const DEFAULT_MATRIX = [
  [0.996, 0.004, 0.0],
  [0.03, 0.94, 0.03],
  [0.0, 0.04, 0.96],
];

function Row({ label, prov, children, error }: { label: string; prov?: string; children: ReactNode; error?: string }) {
  return (
    <div className="flex flex-col">
      <label className="flex items-center justify-between gap-2 min-h-[26px]">
        <span className="text-[12px] text-muted">{label}</span>
        <span className="flex items-center gap-1.5">
          {children}
          {prov && <ProvenanceBadge p={prov} />}
        </span>
      </label>
      {error && <span className="text-bad text-[11px] text-right">{error}</span>}
    </div>
  );
}

function Num({ value, onChange, disabled, step = 'any', min, max, onCommit, label }: { value: number; onChange?(v: number): void; disabled?: boolean; step?: string | number; min?: number; max?: number; onCommit?(v: number): void; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="field"
      type="number"
      aria-label={label}
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      value={draft ?? String(value)}
      onChange={(e) => {
        setDraft(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value !== '' && Number.isFinite(v)) onChange?.(v);
      }}
      onBlur={() => {
        if (draft !== null && onCommit) onCommit(Number(draft));
        setDraft(null);
      }}
    />
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="panel-title !text-faint mt-1">{title}</h3>
      {children}
    </div>
  );
}

export function WorldBuilder() {
  const s = useSession();
  const state = useRace((st) => st.state);
  const live = state !== 'none' && state !== 'finished';
  const locked = state !== 'none';
  const c = s.config;
  const o = c.overrides;
  const car = o.car ?? {};
  const pr = o.processes ?? {};
  const pl = o.planner ?? {};
  const fe = s.fieldErrors;
  const [liveErr, setLiveErr] = useState<string | null>(null);
  const setCar = (patch: NonNullable<RunConfig['overrides']['car']>) => s.setOverrides({ car: { ...car, ...patch } });
  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  useEffect(() => {
    api.tracks().then(setTracks).catch(() => setTracks([]));
  }, []);
  // per-lap defaults grow with lap length (shared/configs applyTrack); show what this circuit will use
  const ratio = (tracks.find((t) => t.id === (c.trackId ?? 'daytona'))?.lapLength_m ?? 5730) / 5730;
  const r4 = (v: number) => Number(v.toPrecision(4));
  const setProc = (patch: NonNullable<RunConfig['overrides']['processes']>) => s.setOverrides({ processes: { ...pr, ...patch } });
  const setPlanner = (patch: NonNullable<RunConfig['overrides']['planner']>) => s.setOverrides({ planner: { ...pl, ...patch } });
  const kappa = pr.kappaX ?? 0.08;
  const pDamp = o.weatherMatrix?.[0]?.[1] ?? DEFAULT_MATRIX[0][1];
  const pushLive = async (kind: 'risk' | 'planner', body: Record<string, unknown>) => {
    if (!live) return;
    setLiveErr(await updateLive(kind, body));
  };
  const lock = locked ? <span title="locked while a race exists — RESET RACE to change">🔒</span> : null;

  return (
    <Panel title="World builder" right={<><Badge color="var(--opt)">SYNTHETIC</Badge><span className="badge text-faint cursor-not-allowed" title="Needs historical timing data; not included">REPLAY</span></>} className="row-span-2">
      <Section title="Race">
        <TrackPicker tracks={tracks} locked={locked} lock={lock} error={fe.trackId} />
        <Row label="Race length" error={fe.durationHours}>
          {lock}
          <select className="field" aria-label="Race length" disabled={locked} value={c.durationHours} onChange={(e) => s.setConfig({ durationHours: Number(e.target.value) as 1 | 3 | 6 })}>
            <option value={1}>1 h</option>
            <option value={3}>3 h</option>
            <option value={6}>6 h</option>
          </select>
        </Row>
        <Row label="Start clock" error={fe.startClock}>
          <input className="field" aria-label="Start clock" disabled={locked} value={c.startClock} onChange={(e) => s.setConfig({ startClock: e.target.value })} />
        </Row>
        <Row label="Cars">
          <span className="mono">10</span>
        </Row>
        <Row label="Our grid slot" error={fe.egoGridSlot}>
          <Num label="Our grid slot" value={c.egoGridSlot} min={1} max={10} step={1} disabled={locked} onChange={(v) => s.setConfig({ egoGridSlot: v })} />
        </Row>
      </Section>
      <Section title="Car">
        <Row label="Fuel capacity kg" prov="ASSUMED" error={fe['overrides.car.capacity_kg'] ?? fe['overrides.car']}>
          <Num label="Fuel capacity" value={car.capacity_kg ?? 82} disabled={locked} onChange={(v) => setCar({ capacity_kg: v })} />
        </Row>
        <Row label="Base burn kg/lap" prov="ASSUMED" error={fe['overrides.car.qBase_kg_per_lap']}>
          <Num label="Base burn" value={car.qBase_kg_per_lap ?? r4(2.65 * ratio)} disabled={locked} onChange={(v) => setCar({ qBase_kg_per_lap: v })} />
        </Row>
        <Row label="Wear k /lap" prov="ASSUMED" error={fe['overrides.car.kBaseDry_per_lap']}>
          <Num label="Wear rate" value={car.kBaseDry_per_lap ?? r4(0.011 * ratio)} disabled={locked} onChange={(v) => setCar({ kBaseDry_per_lap: v })} />
        </Row>
        <Row label="Pit-lane length m" prov="ILLUSTRATIVE" error={fe['overrides.car.laneLength_m']}>
          <Num label="Pit lane length" value={car.laneLength_m ?? 400} disabled={locked} onChange={(v) => setCar({ laneLength_m: v })} />
        </Row>
        <Row label="Service mode" prov="UNVERIFIED">
          <select className="field" aria-label="Service mode" disabled={locked} value={car.serviceMode ?? 'sequential'} onChange={(e) => setCar({ serviceMode: e.target.value as 'sequential' | 'parallel' })}>
            <option value="sequential">sequential</option>
            <option value="parallel">parallel</option>
          </select>
        </Row>
      </Section>
      <Section title="Random processes">
        <Row label="σ grip" prov="ASSUMED" error={fe['overrides.processes.sigmaX']}>
          <Num label="sigma grip" value={pr.sigmaX ?? 0.012} disabled={locked} onChange={(v) => setProc({ sigmaX: v })} />
        </Row>
        <Row label={`κ grip (half-life ${(Math.log(2) / kappa).toFixed(1)} laps)`} prov="ASSUMED">
          <Num label="kappa grip" value={kappa} disabled={locked} onChange={(v) => setProc({ kappaX: v })} />
        </Row>
        <Row label="ρ grip–wear" prov="ASSUMED" error={fe['overrides.processes.rhoXY']}>
          <Num label="rho grip wear" value={pr.rhoXY ?? -0.4} disabled={locked} onChange={(v) => setProc({ rhoXY: v })} />
        </Row>
        <Row label="Multiplier model">
          <select className="field" aria-label="Multiplier model" disabled={locked} value={c.multiplierModel} onChange={(e) => s.setConfig({ multiplierModel: e.target.value as 'expOU' | 'gbm' })}>
            <option value="expOU">exp-OU</option>
            <option value="gbm">GBM (experiment)</option>
          </select>
        </Row>
        <Row label="Caution hazard /lap" prov="FITTED">
          <Num label="caution hazard" value={o.race?.background_per_lap ?? r4(0.0135 * ratio)} disabled={locked} onChange={(v) => s.setOverrides({ race: { background_per_lap: v } })} />
        </Row>
        <Row label="P(dry→damp) /tick" prov="ILLUSTRATIVE" error={fe['overrides.weatherMatrix']}>
          <Num
            label="P dry to damp"
            value={pDamp}
            disabled={locked}
            onChange={(v) => {
              const m = DEFAULT_MATRIX.map((r) => [...r]);
              m[0] = [1 - v - m[0][2], v, m[0][2]];
              s.setOverrides({ weatherMatrix: m });
            }}
          />
        </Row>
      </Section>
      <Section title="Planner (live)">
        <Row label="Paths">
          <select
            className="field"
            aria-label="Planner paths"
            value={pl.paths ?? 400}
            onChange={(e) => {
              const v = Number(e.target.value) as 100 | 200 | 400 | 800;
              setPlanner({ paths: v });
              void pushLive('planner', { paths: v });
            }}
          >
            {[100, 200, 400, 800].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Horizon laps">
          <Num label="Horizon laps" value={pl.horizonLaps ?? 40} step={1} onChange={(v) => setPlanner({ horizonLaps: v })} onCommit={(v) => void pushLive('planner', { horizonLaps: v })} />
        </Row>
        <Row label="P(fail) limit">
          <Num label="P fail limit" value={pl.pFailLimit ?? 0.01} onChange={(v) => setPlanner({ pFailLimit: v })} onCommit={(v) => void pushLive('risk', { pFailLimit: v })} />
        </Row>
        <Row label="CVaR α">
          <Num label="CVaR alpha" value={pl.cvarAlpha ?? 0.95} onChange={(v) => setPlanner({ cvarAlpha: v })} onCommit={(v) => void pushLive('risk', { cvarAlpha: v })} />
        </Row>
        <Row label="λ risk (0 = expected position only)">
          <Num label="lambda risk" value={pl.lambdaRisk ?? 0} onChange={(v) => setPlanner({ lambdaRisk: v })} onCommit={(v) => void pushLive('risk', { lambdaRisk: v })} />
        </Row>
        <Row label="Trigger z / cooldown">
          <Num label="trigger z" value={pl.gripZ ?? 2} onChange={(v) => setPlanner({ gripZ: v })} onCommit={(v) => void pushLive('planner', { gripZ: v })} />
          <Num label="trigger cooldown" value={pl.gripCooldown ?? 5} step={1} onChange={(v) => setPlanner({ gripCooldown: v })} onCommit={(v) => void pushLive('planner', { gripCooldown: v })} />
        </Row>
        <Row label="Pause for planner">
          <input
            type="checkbox"
            aria-label="Pause for planner"
            checked={pl.pauseForPlanner ?? true}
            onChange={(e) => {
              setPlanner({ pauseForPlanner: e.target.checked });
              void pushLive('planner', { pauseForPlanner: e.target.checked });
            }}
          />
        </Row>
        {pl.pauseForPlanner === false && <span className="text-caution text-[11px]">non-deterministic: decisions apply when they return</span>}
        {liveErr && <span className="text-bad text-[11px]">{liveErr}</span>}
      </Section>
    </Panel>
  );
}

/** Circuit picker: the race is built on the chosen track (locked once a race exists). */
function TrackPicker({ tracks, locked, lock, error }: { tracks: TrackInfo[]; locked: boolean; lock: ReactNode; error?: string }) {
  const s = useSession();
  const id = s.config.trackId ?? 'daytona';
  const t = tracks.find((x) => x.id === id);
  return (
    <div className="flex flex-col gap-0.5">
      <Row label="Track" error={error}>
        {lock}
        <select className="field !w-[190px]" aria-label="Track" data-testid="track-select" disabled={locked} value={id} onChange={(e) => s.setConfig({ trackId: e.target.value })}>
          {(tracks.length ? tracks : [{ id: 'daytona', name: 'Daytona International Speedway — Road Course' } as TrackInfo]).map((x) => (
            <option key={x.id} value={x.id}>
              {x.name.replace(/ — Road Course$/, ' Road Course')}
            </option>
          ))}
        </select>
      </Row>
      {t && (
        <span className="mono text-[10.5px] text-muted text-right">
          {(t.lapLength_m / 1000).toFixed(2)} km · {t.corners} corner sections · ref lap {Math.floor(t.lapRef_s / 60)}:{(t.lapRef_s % 60).toFixed(1).padStart(4, '0')} · schematic
        </span>
      )}
    </div>
  );
}
