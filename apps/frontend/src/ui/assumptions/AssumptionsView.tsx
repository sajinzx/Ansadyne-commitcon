import { useEffect, useMemo, useState } from 'react';
import type { Configs } from '@pitwall/shared';
import { Panel } from '../layout/Panel';
import { ProvenanceBadge } from '../layout/Badge';
import { api, type SensitiveParam } from '../../api/client';
import { useBench } from '../../store/benchStore';
import { useRace } from '../../store/raceStore';
import { fmt, sign } from '../../lib/format';

interface Row {
  group: string;
  name: string;
  value: string;
  unit: string;
  range: string;
  prov: string;
  module: string;
  path: string;
}

const MODULE: Record<string, string> = { track: 'M02', car: 'M03/M04', race: 'M05–M07' };

function collect(cfg: Configs): Row[] {
  const rows: Row[] = [];
  const walk = (o: unknown, path: string, group: string) => {
    if (!o || typeof o !== 'object') return;
    const p = o as { value?: unknown; provenance?: string; unit?: string; low?: number; high?: number };
    if (p.provenance && p.value !== undefined && typeof p.value !== 'object') {
      rows.push({
        group,
        name: path.split('.').slice(1).join('.'),
        value: String(p.value),
        unit: p.unit ?? '',
        range: p.low !== undefined ? `${p.low} – ${p.high}` : '',
        prov: p.provenance,
        module: MODULE[group] ?? '',
        path,
      });
      return;
    }
    if (Array.isArray(o)) {
      o.forEach((v, i) => walk(v, `${path}.${(v as { id?: string })?.id ?? i}`, group));
      return;
    }
    for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`, group);
  };
  for (const g of ['track', 'car', 'race'] as const) walk(cfg[g], g, g);
  return rows;
}

function Tornado({ path }: { path: string }) {
  const t = useBench((s) => s.sensitivity[path]);
  const r = t?.status?.result;
  if (!t) return null;
  if (!r) return <span className="mono text-[11px] text-muted">{t.status?.state ?? 'queued'}…</span>;
  const ext = Math.max(0.5, Math.abs(r.low.meanD), Math.abs(r.high.meanD));
  const w = (v: number) => `${(Math.abs(v) / ext) * 50}%`;
  return (
    <div className="flex flex-col gap-0.5 w-56">
      {[r.low, r.high].map((x, i) => (
        <div key={i} className="relative h-3 bg-panel2 rounded">
          <div className="absolute top-0 h-3" style={{ left: x.meanD < 0 ? `calc(50% - ${w(x.meanD)})` : '50%', width: w(x.meanD), background: x.meanD < 0 ? 'var(--opt)' : 'var(--bad)' }} />
          <span className="absolute -top-0.5 left-1 mono text-[9px]">
            {i ? 'high' : 'low'} {fmt(x.value, 3)} · D {sign(x.meanD)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function AssumptionsView() {
  const [cfg, setCfg] = useState<Configs | null>(null);
  const [params, setParams] = useState<SensitiveParam[]>([]);
  const startSensitivity = useBench((s) => s.startSensitivity);
  const diag = useRace((s) => s.init?.diagnostics);
  useEffect(() => {
    api.defaults().then(setCfg).catch(() => undefined);
    api.sensitiveParams().then(setParams).catch(() => undefined);
  }, []);
  const rows = useMemo(() => (cfg ? collect(cfg) : []), [cfg]);
  const sens = new Set(params.map((p) => p.path));
  return (
    <div className="grid gap-3 p-3 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px]">
      <Panel title="Every parameter">
        <div className="overflow-x-auto max-h-[75vh]">
          <table className="data min-w-[860px]">
            <thead>
              <tr>
                <th>Group</th><th className="!text-left">Name</th><th>Value</th><th>Unit</th><th>Range</th><th>Provenance</th><th>Module</th><th>Sensitivity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.path}>
                  <td>{r.group}</td>
                  <td className="!text-left">{r.name}</td>
                  <td>{r.value}</td>
                  <td>{r.unit}</td>
                  <td>{r.range || (sens.has(r.path) ? '±20% (default)' : '—')}</td>
                  <td><ProvenanceBadge p={r.prov} /></td>
                  <td>{r.module}</td>
                  <td>
                    {sens.has(r.path) ? (
                      <div className="flex items-center gap-2 justify-end">
                        <Tornado path={r.path} />
                        <button className="btn !py-0" onClick={() => void startSensitivity(r.path, 20)} title="20 dev seeds at low and high">
                          Sensitivity
                        </button>
                      </div>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <div className="flex flex-col gap-3">
        <Panel title="Emergent diagnostics · illustrative">
          {diag ? (
            <table className="data">
              <tbody>
                <tr><td>μ peak (calibrated)</td><td>{diag.mu_peak.toFixed(4)}</td></tr>
                <tr><td>Reference lap</td><td>{diag.lapRef_s.toFixed(2)} s</td></tr>
                <tr><td>Sectors</td><td>{diag.sectorTimes_s.map((s) => s.toFixed(2)).join(' / ')}</td></tr>
                <tr><td>Top speed</td><td>{diag.topSpeed_kph.toFixed(0)} km/h ({diag.topSpeedSegment})</td></tr>
                <tr><td>c_f</td><td>{diag.c_f_s_per_kg.toFixed(4)} s/kg</td></tr>
                <tr><td>dT/dS</td><td>{diag.dT_dS.toFixed(1)}</td></tr>
                <tr><td>τ(5613) / τ(884)</td><td>{diag.tau5613.toFixed(4)} / {diag.tau884.toFixed(4)}</td></tr>
                <tr><td>Pit stretch</td><td>{diag.tStretchRef_s.toFixed(2)} s</td></tr>
              </tbody>
            </table>
          ) : (
            <span className="text-muted mono">Start a run to see the calibration diagnostics.</span>
          )}
        </Panel>
        <Panel title="Limitations">
          <ul className="list-disc pl-5 text-[12px] flex flex-col gap-1">
            <li>Schematic track: segment lengths reconcile to 5,730 m, but curvature, banking and grip are illustrative.</li>
            <li>One class-level synthetic GT3 car; no real team or car data.</li>
            <li>Caution and incident hazards are uncalibrated; results are relative, not predictions.</li>
            <li>Pit rules (closed lane, service order) are unverified simplifications.</li>
            <li>Rivals follow fixed synthetic policies and do not react to our strategy.</li>
            <li>Every race is simulated data; results compare strategies on paired scenarios only.</li>
            <li>The dashboard is advisory: it never controls a real car or team.</li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}
