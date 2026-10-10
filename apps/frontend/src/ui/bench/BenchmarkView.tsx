import { useEffect, useState } from 'react';
import type { BenchResult, FamilyResult, Split } from '@pitwall/shared';
import { FAMILIES, SPLIT_RANGES } from '@pitwall/shared';
import { scaleLinear } from 'd3-scale';
import { Panel } from '../layout/Panel';
import { Badge } from '../layout/Badge';
import { useBench } from '../../store/benchStore';
import { api, STANDALONE } from '../../api/client';
import { fmt, sign } from '../../lib/format';

const FAMILY_LABEL: Record<string, string> = {
  F1: 'Calm dry', F2: 'Early caution', F3: 'Mid caution', F4: 'Late caution', F5: 'Random cautions', F6: 'Rain onset',
  F7: 'High wear', F8: 'Fuel stress', F9: 'Model mismatch', F10: 'Worst timing (paired)', 'F10-adv': 'Worst timing per world (unpaired)',
};

function ciColor(lo: number, hi: number) {
  return hi < 0 ? 'var(--opt)' : lo > 0 ? 'var(--bad)' : 'var(--muted)';
}

function ResultsTable({ fams }: { fams: FamilyResult[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="data min-w-[980px]" data-testid="bench-table">
        <thead>
          <tr>
            <th>Family</th><th>n</th><th>ΔP OPT−B1 [boot 95%]</th><th>ΔP OPT−B0 [CI]</th><th>W/T/L vs B1</th><th>P(finish) B0/B1/OPT</th><th>P(win) OPT</th><th>CVaR₀.₉₅ OPT</th><th>Stops OPT</th><th>p95 ms</th>
          </tr>
        </thead>
        <tbody>
          {fams.map((f) => {
            const a = f.diffs['OPT-B1'];
            const b = f.diffs['OPT-B0'];
            const [w, t, l] = f.winTieLoss['OPT-B1'];
            return (
              <tr key={f.family}>
                <td className="!font-sans">
                  {f.family} · {FAMILY_LABEL[f.family]} {!f.paired && <Badge color="var(--caution)">unpaired</Badge>} {f.claimOptBeatsB1 && <Badge color="var(--opt)">claim</Badge>}
                </td>
                <td>{f.n}</td>
                <td style={{ color: ciColor(a.ciBoot95[0], a.ciBoot95[1]) }} title={`t 95%: ${fmt(a.ciT95[0], 2)} … ${fmt(a.ciT95[1], 2)} · Holm p ${fmt(a.holmAdjustedP, 3)}`}>
                  {sign(a.mean)} [{fmt(a.ciBoot95[0], 2)}, {fmt(a.ciBoot95[1], 2)}]
                </td>
                <td style={{ color: ciColor(b.ciBoot95[0], b.ciBoot95[1]) }}>
                  {sign(b.mean)} [{fmt(b.ciBoot95[0], 2)}, {fmt(b.ciBoot95[1], 2)}]
                </td>
                <td>
                  {((w / f.n) * 100).toFixed(0)}/{((t / f.n) * 100).toFixed(0)}/{((l / f.n) * 100).toFixed(0)}%
                </td>
                <td>
                  {(f.pFinish.B0 * 100).toFixed(0)}/{(f.pFinish.B1 * 100).toFixed(0)}/{(f.pFinish.OPT * 100).toFixed(0)}%
                </td>
                <td>{(f.pWin.OPT * 100).toFixed(0)}%</td>
                <td>{fmt(f.cvar95.OPT, 2)}</td>
                <td>{fmt(f.meanStops.OPT, 2)}</td>
                <td>{f.decisionMsP95.toFixed(0)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ForestPlot({ fams }: { fams: FamilyResult[] }) {
  const W = 700;
  const rowH = 26;
  const H = fams.length * rowH + 30;
  const all = fams.flatMap((f) => f.diffs['OPT-B1'].ciBoot95).filter(Number.isFinite);
  const ext = Math.max(0.5, ...all.map(Math.abs));
  const x = scaleLinear().domain([-ext, ext]).range([150, W - 20]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="forest plot of the mean position difference OPT minus B1 per family">
      <line x1={x(0)} x2={x(0)} y1={6} y2={H - 20} stroke="var(--line-2)" />
      {fams.map((f, i) => {
        const d = f.diffs['OPT-B1'];
        const y = 16 + i * rowH;
        const c = ciColor(d.ciBoot95[0], d.ciBoot95[1]);
        return (
          <g key={f.family}>
            <text x={0} y={y + 4} fontSize={11} fill="var(--text)" fontFamily="JetBrains Mono">
              {f.family}
            </text>
            <line x1={x(d.ciBoot95[0])} x2={x(d.ciBoot95[1])} y1={y} y2={y} stroke={c} strokeWidth={2} />
            <circle cx={x(d.mean)} cy={y} r={4.5} fill={c} />
          </g>
        );
      })}
      {x.ticks(5).map((v) => (
        <text key={v} x={x(v)} y={H - 4} fontSize={10} textAnchor="middle" fill="var(--muted)" fontFamily="JetBrains Mono">
          {v}
        </text>
      ))}
      <text x={x(-ext) + 2} y={H - 16} fontSize={9} fill="var(--opt)">← OPT better</text>
    </svg>
  );
}

function ExperimentCard({ id, title, variants }: { id: string; title: string; variants: string[] }) {
  const tracked = useBench((s) => s.experiments[id]);
  const start = useBench((s) => s.startExperiment);
  const st = tracked?.status;
  const r = st?.result as BenchResult | undefined;
  const extra = r?.extra as { variants?: { label: string; ranking: string[]; clipFraction: number; invalid?: string; families: FamilyResult[] }[]; rankFirstShare?: Record<string, number> } | undefined;
  return (
    <div className="rounded-lg border border-line bg-panel2 p-3 flex flex-col gap-2 min-w-0">
      <div className="flex justify-between gap-2">
        <span className="panel-title !text-text">{title}</span>
        <button className="btn" disabled={st?.state === 'running'} onClick={() => void start(id, ['F5'], 10)}>
          {st?.state === 'running' ? `${st.progress.done}/${st.progress.total}` : 'Run (F5 · 10 seeds)'}
        </button>
      </div>
      <span className="text-muted text-[11px]">{variants.join(' · ')}</span>
      {extra?.variants?.map((v) => (
        <div key={v.label} className="mono text-[11px] flex justify-between gap-2">
          <span>{v.label}</span>
          <span>
            {v.ranking.join(' > ')} · ΔP {sign(v.families[0]?.diffs['OPT-B1'].mean ?? 0)}
            {id === 'gbm' && ` · clip ${(v.clipFraction * 100).toFixed(2)}%`} {v.invalid && <Badge color="var(--bad)">invalid</Badge>}
          </span>
        </div>
      ))}
      {st?.state === 'error' && <span className="text-bad mono text-[11px]">{st.error}</span>}
    </div>
  );
}

export function BenchmarkView() {
  const bench = useBench((s) => s.bench);
  const startBench = useBench((s) => s.startBench);
  const [families, setFamilies] = useState<string[]>(['F1', 'F2', 'F3', 'F5', 'F6', 'F10']);
  const [seeds, setSeeds] = useState(20);
  const [split, setSplit] = useState<Split>('dev');
  const [rounds, setRounds] = useState('50,100,200');
  const [experiments, setExperiments] = useState<{ id: string; title: string; variants: string[] }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.experiments().then(setExperiments).catch(() => undefined);
  }, []);
  const st = bench?.status;
  const result = st?.result;
  const cap = SPLIT_RANGES[split][1] - SPLIT_RANGES[split][0] + 1;
  return (
    <div className="grid gap-3 p-3 grid-cols-1 xl:grid-cols-[340px_minmax(0,1fr)]">
      <Panel title="Benchmark configuration">
        <div className="flex flex-wrap gap-1">
          {FAMILIES.map((f) => (
            <button key={f} className={`btn ${families.includes(f) ? 'btn-active' : ''}`} aria-pressed={families.includes(f)} onClick={() => setFamilies(families.includes(f) ? families.filter((x) => x !== f) : [...families, f])} title={FAMILY_LABEL[f]}>
              {f}
            </button>
          ))}
        </div>
        <label className="flex justify-between items-center text-[12px] text-muted">
          Seeds per family (max {Math.min(cap, split === 'test' ? 10000 : cap)})
          <input className="field" type="number" min={1} max={cap} value={seeds} onChange={(e) => setSeeds(Number(e.target.value))} />
        </label>
        <label className="flex justify-between items-center text-[12px] text-muted">
          Split
          <select className="field" value={split} onChange={(e) => setSplit(e.target.value as Split)}>
            <option value="dev">dev</option>
            <option value="val">val</option>
            <option value="test">test (frozen settings)</option>
          </select>
        </label>
        <label className="flex justify-between items-center text-[12px] text-muted">
          Planner rounds
          <input className="field !w-32" value={rounds} onChange={(e) => setRounds(e.target.value)} />
        </label>
        <button
          className="btn btn-run"
          disabled={st?.state === 'running' || !families.length}
          onClick={() => {
            setErr(null);
            startBench({ families, seedsPerFamily: seeds, split, rounds: rounds.split(',').map(Number).filter(Boolean) }).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
          }}
        >
          Run benchmark
        </button>
        {st && (
          <div className="mono text-[12px]" role="status">
            {st.state} · {st.progress.done}/{st.progress.total}
            {st.etaMs ? ` · ETA ${(st.etaMs / 1000).toFixed(0)} s` : ''}
          </div>
        )}
        {err && <div className="text-bad mono text-[12px]">{err}</div>}
        <p className="text-muted text-[12px]">Performance is reported, not required. Settings are tuned on dev only; val/test runs record the settings hash. Benchmark races run headless with the planner inline{STANDALONE ? ' — in this web build they run in your browser as 1-hour races on Daytona' : ''}.</p>
        {bench && result && (
          <div className="flex gap-2">
            <a className="btn" href={api.exportUrl(bench.jobId, 'csv')}>
              Export CSV
            </a>
            <a className="btn" href={api.exportUrl(bench.jobId, 'json')}>
              Export JSON
            </a>
          </div>
        )}
      </Panel>
      <div className="flex flex-col gap-3 min-w-0">
        <Panel title="Results by family" right={result ? <span className="mono text-[11px] text-muted">settings {result.settingsHash} · rounds {result.rounds.join('/')} · {(result.runtimeMs / 1000).toFixed(0)} s</span> : undefined}>
          {result ? <ResultsTable fams={result.families} /> : <span className="text-muted mono">No benchmark yet. Lime = CI excludes 0 in OPT's favour; red = against; grey = inconclusive.</span>}
        </Panel>
        {result && (
          <Panel title="Forest plot · mean ΔP (OPT − B1) with bootstrap 95% CI">
            <ForestPlot fams={result.families} />
          </Panel>
        )}
        <Panel title="Experiments">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {experiments.map((e) => (
              <ExperimentCard key={e.id} {...e} />
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
