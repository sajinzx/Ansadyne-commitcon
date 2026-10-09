import { Panel } from '../layout/Panel';
import { WORLD_COLOR } from '../layout/Badge';
import { useRace } from '../../store/raceStore';
import { useUi } from '../../store/uiStore';
import { egoRecord, stints } from '../../lib/derive';

export function StintTimeline() {
  const init = useRace((s) => s.init);
  const laps = useRace((s) => s.laps);
  const t = useUi((s) => s.displayTime);
  const ego = init?.ego ?? 12;
  const expected = init?.expectedLaps ?? 100;
  const W = 1000;
  const x = (lap: number) => 44 + ((lap - 1) / Math.max(1, expected)) * (W - 120);
  return (
    <Panel title="Stint timeline" right={<span className="panel-title !text-faint">SOLID = DONE · OUTLINE = PLAN</span>}>
      <svg viewBox={`0 0 ${W} 110`} width="100%" role="img" aria-label="stints done and planned per strategy">
        {(['OPT', 'B1', 'B0'] as const).map((w, row) => {
          const shown = laps[w].filter((le) => {
            const r = egoRecord(le, ego);
            return r && r.lapStart_s + r.lapTime_s <= t + 1e-6;
          });
          const last = shown[shown.length - 1];
          const plan = last ? egoRecord(last, ego)?.ego?.plan : w === 'B0' || w === 'OPT' ? init?.b0Plan : null;
          const bars = stints(shown, ego, plan, expected);
          const stops = last ? egoRecord(last, ego)?.stops ?? 0 : 0;
          const yy = 8 + row * 34;
          return (
            <g key={w}>
              <text x={0} y={yy + 15} fontSize={12} fill={WORLD_COLOR[w]} fontFamily="Barlow Condensed" fontWeight={600}>
                {w}
              </text>
              {bars.map((b, i) => {
                const x0 = x(b.from);
                const x1 = x(b.to + 1);
                const wd = Math.max(2, x1 - x0 - 2);
                return (
                  <g key={i}>
                    <rect x={x0} y={yy} width={wd} height={22} rx={3} fill={b.planned ? 'none' : WORLD_COLOR[w]} fillOpacity={b.done ? 0.9 : 0.55} stroke={WORLD_COLOR[w]} strokeDasharray={b.planned ? '4 3' : undefined} />
                    {wd > 26 && (
                      <text x={x0 + wd / 2} y={yy + 15} fontSize={11} textAnchor="middle" fill={b.planned ? WORLD_COLOR[w] : '#0e1013'} fontFamily="JetBrains Mono">
                        {b.planned ? 'plan' : b.to - b.from + 1}
                        {b.compound === 'wet' ? ' W' : ''}
                      </text>
                    )}
                  </g>
                );
              })}
              <text x={W} y={yy + 15} fontSize={11} textAnchor="end" fill="var(--muted)" fontFamily="JetBrains Mono">
                {stops} stops
              </text>
            </g>
          );
        })}
      </svg>
    </Panel>
  );
}
