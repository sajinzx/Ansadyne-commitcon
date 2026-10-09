import { Panel } from '../layout/Panel';
import { WORLD_COLOR } from '../layout/Badge';
import { useRace } from '../../store/raceStore';
import { useUi } from '../../store/uiStore';
import { recordAt } from '../../lib/animation';
import { lapTimeStr } from '../../lib/format';
import type { CarLapRecord } from '@pitwall/shared';

export function RaceTable() {
  const world = useUi((s) => s.world);
  const t = useUi((s) => s.displayTime);
  const selected = useUi((s) => s.selectedCar);
  const select = useUi((s) => s.selectCar);
  const recs = useRace((s) => s.recs[world]);
  const ego = useRace((s) => s.init?.ego ?? 12);
  // last completed record per car at the display time (current lap record for "in pit" status)
  const rows: { rec: CarLapRecord; inPit: boolean }[] = [];
  for (const list of Object.values(recs)) {
    let done: CarLapRecord | undefined;
    for (const r of list) if (r.lapStart_s + r.lapTime_s <= t + 1e-6) done = r;
    const cur = recordAt(list, t);
    const base = done ?? list[0];
    if (base) rows.push({ rec: base, inPit: !!cur?.pit });
  }
  const running = rows.filter((r) => r.rec.running || r.rec.classified).sort((a, b) => a.rec.position - b.rec.position);
  const out = rows.filter((r) => !r.rec.running && !r.rec.classified);
  return (
    <Panel title={<span>Race table · <span style={{ color: WORLD_COLOR[world] }}>{world}</span></span>}>
      <table className="data nowrap">
        <thead>
          <tr>
            <th>Pos</th>
            <th>Car</th>
            <th>Gap</th>
            <th>Last</th>
            <th>Tyre</th>
            <th>Stops</th>
          </tr>
        </thead>
        <tbody>
          {[...running, ...out].map(({ rec, inPit }) => {
            const isEgo = rec.no === ego;
            const dnf = !rec.running && !rec.classified;
            return (
              <tr
                key={rec.no}
                onClick={() => select(selected === rec.no ? null : rec.no)}
                className="cursor-pointer"
                style={{ background: isEgo ? 'rgba(215,255,63,0.08)' : selected === rec.no ? 'var(--panel-2)' : undefined, opacity: dnf ? 0.45 : 1 }}
              >
                <td>{dnf ? 'DNF' : rec.position}</td>
                <td style={{ color: isEgo ? 'var(--opt)' : undefined }}>#{rec.no}</td>
                <td>{dnf ? rec.dnf?.cause ?? '' : rec.position === 1 ? 'leader' : rec.lapsDown > 0 ? `+${rec.lapsDown} LAP` : `+${rec.gapLeader_s.toFixed(1)}`}</td>
                <td>{inPit ? <span className="text-caution">pit</span> : lapTimeStr(rec.lapTime_s)}</td>
                <td>
                  <span className="badge" style={{ color: rec.compound === 'wet' ? 'var(--wet)' : 'var(--text)' }} title={rec.compound === 'wet' ? 'wet tyres' : 'dry slicks'}>
                    {rec.compound === 'wet' ? 'WET' : 'DRY'}
                  </span>{' '}
                  {rec.tyreAgeLaps}
                </td>
                <td>{rec.stops}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}
