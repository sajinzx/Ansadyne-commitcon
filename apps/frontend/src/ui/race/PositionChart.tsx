import { scaleLinear } from 'd3-scale';
import { line } from 'd3-shape';
import { Panel } from '../layout/Panel';
import { Badge, WORLD_COLOR } from '../layout/Badge';
import { useRace } from '../../store/raceStore';
import { useUi } from '../../store/uiStore';
import { cautionBands, egoRecord, positionSeries } from '../../lib/derive';

const W = 1000;
const H = 260;
const M = { l: 34, r: 12, t: 12, b: 22 };

export function PositionChart() {
  const init = useRace((s) => s.init);
  const laps = useRace((s) => s.laps);
  const forks = useRace((s) => s.forks);
  const t = useUi((s) => s.displayTime);
  const ego = init?.ego ?? 12;
  const expected = init?.expectedLaps ?? 100;
  // only laps already shown on the display clock
  const shown = (w: 'OPT' | 'B1' | 'B0') => laps[w].filter((le) => {
    const r = egoRecord(le, ego);
    return r && r.lapStart_s + r.lapTime_s <= t + 1e-6;
  });
  const series = { OPT: positionSeries(shown('OPT'), ego), B1: positionSeries(shown('B1'), ego), B0: positionSeries(shown('B0'), ego) };
  const bands = cautionBands(shown('B1'), ego);
  const x = scaleLinear().domain([0, Math.max(10, expected + 2)]).range([M.l, W - M.r]);
  const y = scaleLinear().domain([1, 10]).range([M.t, H - M.b]);
  const ln = line<{ lap: number; pos: number }>().x((d) => x(d.lap)).y((d) => y(d.pos));
  const cursor = series.OPT[series.OPT.length - 1]?.lap ?? 0;
  return (
    <Panel title="Position vs lap" right={<Badge color="var(--opt)">PAIRED SCENARIO</Badge>}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="class position of our car by lap in each strategy world" data-testid="position-chart">
        {bands.map((b) => (
          <g key={b.from} data-testid="caution-band">
            <rect x={x(b.from - 1)} y={M.t} width={Math.max(2, x(b.to) - x(b.from - 1))} height={H - M.t - M.b} fill="var(--caution)" opacity={0.12} />
            <text x={x(b.from - 1) + 3} y={M.t + 10} fontSize={9} fill="var(--caution)" fontFamily="Barlow Condensed" letterSpacing="0.1em">
              CAUTION
            </text>
          </g>
        ))}
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((p) => (
          <g key={p}>
            <line x1={M.l} x2={W - M.r} y1={y(p)} y2={y(p)} stroke="var(--line)" />
            <text x={M.l - 6} y={y(p) + 3} fontSize={10} textAnchor="end" fill="var(--muted)" fontFamily="JetBrains Mono">
              P{p}
            </text>
          </g>
        ))}
        {x.ticks(10).map((l) => (
          <text key={l} x={x(l)} y={H - 6} fontSize={10} textAnchor="middle" fill="var(--muted)" fontFamily="JetBrains Mono">
            {l}
          </text>
        ))}
        {forks.map((f, i) => (
          <path key={i} d={ln(f.positionTrace.map((p, j) => ({ lap: f.fromStep + 1 + j, pos: p }))) ?? ''} fill="none" stroke={WORLD_COLOR[f.world]} strokeDasharray="5 4" strokeWidth={1.5} opacity={0.9}>
            <title>{`${f.label} → P${f.finalPos} (parent P${f.parentFinalPos})`}</title>
          </path>
        ))}
        {(['B0', 'B1', 'OPT'] as const).map((w) => (
          <g key={w}>
            <path d={ln(series[w]) ?? ''} fill="none" stroke={WORLD_COLOR[w]} strokeWidth={w === 'OPT' ? 2.5 : 1.75} strokeLinejoin="round" />
            {series[w]
              .filter((p) => p.pit)
              .map((p) => (
                <circle key={p.lap} cx={x(p.lap)} cy={y(p.pos)} r={3.5} fill={p.forced ? 'var(--bg)' : WORLD_COLOR[w]} stroke={WORLD_COLOR[w]} strokeWidth={1.5} />
              ))}
          </g>
        ))}
        {cursor > 0 && <line x1={x(cursor)} x2={x(cursor)} y1={M.t} y2={H - M.b} stroke="var(--muted)" strokeDasharray="2 3" />}
      </svg>
    </Panel>
  );
}
