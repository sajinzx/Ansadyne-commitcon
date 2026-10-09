// Markov weather: the three-state chain with its live transition probabilities, the current state, the
// regime forecast, and controls to force a state or edit the matrix (applied in all worlds from the next tick).
import { useEffect, useState } from 'react';
import { Panel } from '../layout/Panel';
import { Badge, ProvenanceBadge } from '../layout/Badge';
import { useRace } from '../../store/raceStore';
import { useUi } from '../../store/uiStore';
import { inject, useSession } from '../../store/session';
import { useShownLaps } from './useDisplayed';

export const DEFAULT_MATRIX = [
  [0.996, 0.004, 0.0],
  [0.03, 0.94, 0.03],
  [0.0, 0.04, 0.96],
];
const STATES = ['dry', 'damp', 'wet'] as const;
const COLOR = { dry: '#8B929C', damp: '#6F9FD8', wet: 'var(--wet)' } as const;
const pct = (p: number) => (p >= 0.1 ? `${(p * 100).toFixed(0)}%` : p >= 0.001 ? `${(p * 100).toFixed(1)}%` : p > 0 ? '<0.1%' : '0');

function ChainDiagram({ P, current }: { P: number[][]; current: number }) {
  const xs = [70, 200, 330];
  const y = 70;
  const arrow = (from: number, to: number, up: boolean) => {
    const p = P[from][to];
    if (p <= 0) return null;
    const x1 = xs[from] + (to > from ? 26 : -26);
    const x2 = xs[to] + (to > from ? -26 : 26);
    const dy = up ? -16 : 16;
    const mid = (x1 + x2) / 2;
    return (
      <g key={`${from}${to}`}>
        <path d={`M${x1},${y + dy / 2} Q${mid},${y + dy * 2.4} ${x2},${y + dy / 2}`} fill="none" stroke="var(--line-2)" strokeWidth={1.5} markerEnd="url(#wx-arrow)" />
        <text x={mid} y={y + dy * 2.4 + (up ? -3 : 11)} textAnchor="middle" fontSize={10.5} fontFamily="JetBrains Mono" fill="var(--muted)">
          {pct(p)}
        </text>
      </g>
    );
  };
  return (
    <svg viewBox="0 0 400 150" width="100%" role="img" aria-label="three-state Markov weather chain with transition probabilities per tick">
      <defs>
        <marker id="wx-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="var(--line-2)" />
        </marker>
      </defs>
      {arrow(0, 1, true)}
      {arrow(1, 2, true)}
      {arrow(1, 0, false)}
      {arrow(2, 1, false)}
      {arrow(0, 2, true)}
      {arrow(2, 0, false)}
      {STATES.map((s, i) => (
        <g key={s}>
          <circle cx={xs[i]} cy={y} r={24} fill={i === current ? COLOR[s] : 'var(--panel-2)'} stroke={COLOR[s]} strokeWidth={2} />
          <text x={xs[i]} y={y + 4} textAnchor="middle" fontSize={11} fontWeight={700} fontFamily="Barlow Condensed" fill={i === current ? '#0e1013' : 'var(--text)'}>
            {s.toUpperCase()}
          </text>
          <text x={xs[i]} y={y + 50} textAnchor="middle" fontSize={10} fontFamily="JetBrains Mono" fill="var(--faint)">
            stay {pct(P[i][i])}
          </text>
        </g>
      ))}
    </svg>
  );
}

function ForecastBars({ f }: { f: { in5: number[]; in10: number[]; in20: number[] } }) {
  const rows: [string, number[]][] = [
    ['next 5 ticks', f.in5],
    ['next 10', f.in10],
    ['next 20', f.in20],
  ];
  return (
    <div className="flex flex-col gap-1">
      {rows.map(([label, v]) => (
        <div key={label} className="flex items-center gap-2">
          <span className="mono text-[11px] text-muted w-20 shrink-0">{label}</span>
          <div className="flex h-3.5 flex-1 rounded overflow-hidden" role="img" aria-label={`${label}: dry ${pct(v[0])}, damp ${pct(v[1])}, wet ${pct(v[2])}`}>
            {STATES.map((s, i) => (
              <span key={s} style={{ width: `${v[i] * 100}%`, background: COLOR[s] }} title={`${s} ${pct(v[i])}`} />
            ))}
          </div>
          <span className="mono text-[10.5px] w-28 text-right">
            wet {pct(v[2])} · damp {pct(v[1])}
          </span>
        </div>
      ))}
    </div>
  );
}

export function WeatherPanel() {
  const world = useUi((s) => s.world);
  const state = useRace((s) => s.state);
  const shown = useShownLaps(world);
  const env = shown[shown.length - 1]?.env;
  const session = useSession();
  const live = state !== 'none' && state !== 'finished';
  const P = env?.matrix ?? session.config.overrides.weatherMatrix ?? DEFAULT_MATRIX;
  const current = env ? STATES.indexOf(env.regime) : 0;
  const [draft, setDraft] = useState<string[][]>(P.map((r) => r.map((v) => String(v))));
  const [ticks, setTicks] = useState(15);
  const [err, setErr] = useState<string | null>(null);
  const key = JSON.stringify(P);
  useEffect(() => setDraft(P.map((r) => r.map((v) => String(v)))), [key]);

  const applyMatrix = (m: number[][]) => {
    const rows = m.map((r) => {
      const sum = r.reduce((a, b) => a + b, 0);
      return sum > 0 ? r.map((v) => v / sum) : r;
    });
    if (rows.some((r) => r.some((v) => !Number.isFinite(v) || v < 0))) {
      setErr('probabilities must be ≥ 0');
      return;
    }
    setErr(null);
    if (live) void inject('weatherMatrix', { matrix: rows }, 'new weather matrix');
    else session.setOverrides({ weatherMatrix: rows });
  };

  return (
    <Panel title="Weather · Markov chain" right={<><Badge color={COLOR[STATES[current]]}>{STATES[current]}</Badge><ProvenanceBadge p="ILLUSTRATIVE" /></>}>
      <ChainDiagram P={P} current={current} />
      {env?.forecast ? <ForecastBars f={env.forecast} /> : <span className="mono text-muted text-[11px]">Forecast appears once the race starts.</span>}
      {env && (
        <div className="grid grid-cols-3 gap-2 mono text-[11.5px]">
          <span>wetness {env.wetness.toFixed(2)}</span>
          <span>track {env.trackTemp_C.toFixed(1)} °C</span>
          <span>rain in 20: {pct(env.rainProb.in20)}</span>
        </div>
      )}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="panel-title !text-faint mr-1">Force</span>
        {STATES.map((s) => (
          <button key={s} className="btn" disabled={!live} onClick={() => void inject('weather', { regime: s, ticks }, `${s} for ${ticks} ticks`)} style={{ borderColor: COLOR[s] }}>
            {s === 'dry' ? 'Dry it up' : s === 'damp' ? 'Damp' : 'Rain'}
          </button>
        ))}
        <label className="mono text-[11px] text-muted flex items-center gap-1 ml-auto">
          for
          <input className="field !w-14" type="number" min={1} max={200} value={ticks} onChange={(e) => setTicks(Math.max(1, Math.min(200, Number(e.target.value) || 1)))} aria-label="ticks to force" />
          ticks
        </label>
      </div>
      <details>
        <summary className="panel-title cursor-pointer">Transition matrix (per tick = one reference lap)</summary>
        <table className="data mt-2">
          <thead>
            <tr>
              <th>from \ to</th>
              {STATES.map((s) => (
                <th key={s}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {STATES.map((from, i) => (
              <tr key={from}>
                <td>{from}</td>
                {STATES.map((to, j) => (
                  <td key={to}>
                    <input
                      className="field !w-20"
                      aria-label={`P(${from} to ${to})`}
                      value={draft[i]?.[j] ?? ''}
                      onChange={(e) => setDraft(draft.map((r, a) => r.map((v, b) => (a === i && b === j ? e.target.value : v))))}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex gap-2 mt-2 items-center">
          <button className="btn" onClick={() => applyMatrix(draft.map((r) => r.map(Number)))}>
            {live ? 'Apply to race' : 'Use for next race'}
          </button>
          <button className="btn" onClick={() => applyMatrix(DEFAULT_MATRIX)}>
            Reset to default
          </button>
          <span className="text-muted text-[11px]">rows are normalised to sum to 1</span>
        </div>
        {err && <div className="text-bad mono text-[11px]">{err}</div>}
      </details>
    </Panel>
  );
}
