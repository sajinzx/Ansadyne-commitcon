import { Panel } from '../layout/Panel';
import { ProvenanceBadge, WORLD_COLOR } from '../layout/Badge';
import { Gauge } from '../common/charts';
import { useRace } from '../../store/raceStore';
import { useUi } from '../../store/uiStore';
import { useShownLaps } from './useDisplayed';
import { egoRecord } from '../../lib/derive';
import { fmt } from '../../lib/format';

export function FuelTyres() {
  const world = useUi((s) => s.world);
  const init = useRace((s) => s.init);
  const cfg = useRace((s) => s.info?.config);
  const shown = useShownLaps(world);
  const ego = init?.ego ?? 12;
  const last = shown[shown.length - 1];
  const rec = last ? egoRecord(last, ego) : undefined;
  const b = rec?.ego?.belief;
  const truth = rec?.ego?.truth;
  const cap = cfg?.overrides.car?.capacity_kg ?? 82;
  const qBase = cfg?.overrides.car?.qBase_kg_per_lap ?? 2.65;
  const burnB = b ? qBase * b.Zeff.mean : null;
  const burnT = truth ? qBase * truth.Zeff : null;
  return (
    <Panel title={<span>Fuel and tyres · <span style={{ color: WORLD_COLOR[world] }}>{world}</span></span>} right={<ProvenanceBadge p="ASSUMED" />}>
      <div className="flex items-center gap-4">
        <div className="flex flex-col items-center w-1/3 min-w-[120px]">
          <Gauge value={b?.fuel.mean ?? cap} max={cap} label="fuel belief gauge" />
          <span className="big-num text-[28px]">{fmt(b?.fuel.mean ?? null, 1)}</span>
          <span className="mono text-muted">kg of {cap.toFixed(1)}</span>
        </div>
        <table className="data flex-1">
          <tbody>
            <tr>
              <td>Burn (belief)</td>
              <td>{burnB ? `${burnB.toFixed(2)} kg/lap` : '—'}</td>
            </tr>
            <tr className="opacity-60" title="truth is hidden from every strategy; shown here for evaluation only">
              <td>🔒 Burn (truth, hidden from strategy)</td>
              <td>{burnT ? `${burnT.toFixed(2)} kg/lap` : '—'}</td>
            </tr>
            <tr>
              <td>Laps to empty</td>
              <td>{b && burnB ? fmt(b.fuel.mean / burnB, 1) : '—'}</td>
            </tr>
            <tr>
              <td>Tyre wear (belief)</td>
              <td>{b ? `${(b.W.mean * 100).toFixed(0)}% ± ${(b.W.sd * 100).toFixed(0)}` : '—'}</td>
            </tr>
            <tr className="opacity-60">
              <td>🔒 Tyre wear (truth)</td>
              <td>{truth ? `${(truth.wear * 100).toFixed(0)}%` : '—'}</td>
            </tr>
            <tr>
              <td>Tyre temp</td>
              <td>{truth ? `${truth.tyreTemp_C.toFixed(0)} °C` : '—'}</td>
            </tr>
            <tr>
              <td>Compound</td>
              <td>
                <span className="badge" style={{ color: rec?.compound === 'wet' ? 'var(--wet)' : 'var(--text)' }}>
                  {rec?.compound ?? 'dry'} · {rec?.tyreAgeLaps ?? 0} laps
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
