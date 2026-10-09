import { Panel } from '../layout/Panel';
import { WORLD_COLOR } from '../layout/Badge';
import { useRace } from '../../store/raceStore';
import { useShownLaps } from './useDisplayed';
import { egoRecord } from '../../lib/derive';

const NAMES = { B0: 'B0 static', B1: 'B1 reactive', OPT: 'OPT dynamic' } as const;

function Card({ w }: { w: 'B0' | 'B1' | 'OPT' }) {
  const proj = useRace((s) => s.projections[w]);
  const summary = useRace((s) => s.summary);
  const ego = useRace((s) => s.init?.ego ?? 12);
  const shown = useShownLaps(w);
  const last = shown[shown.length - 1];
  const rec = last ? egoRecord(last, ego) : undefined;
  const finished = summary && rec && (rec.classified || !rec.running);
  const plan = rec?.ego?.plan;
  const next = plan?.stops[0]?.lap;
  return (
    <div className="rounded-lg border p-3 flex flex-col gap-1 min-w-0" style={{ borderColor: WORLD_COLOR[w] }}>
      <span className="panel-title" style={{ color: WORLD_COLOR[w] }}>
        {NAMES[w]}
      </span>
      <span className="big-num text-[44px]" style={{ color: WORLD_COLOR[w] }}>
        {finished ? `P${summary!.byStrategy[w].finalPos}` : proj ? `P${proj.meanPos.toFixed(1)}` : rec ? `P${rec.position}` : '—'}
      </span>
      <span className="mono text-muted">{finished ? (summary!.byStrategy[w].dnf ? `DNF · ${summary!.byStrategy[w].dnf}` : 'final') : proj ? `P${proj.p10.toFixed(0)}–${proj.p90.toFixed(0)} projected` : 'now'}</span>
      <span className="mono">
        {rec?.stops ?? 0} stops{plan ? ` of ~${(rec?.stops ?? 0) + plan.stops.length}` : ''}
      </span>
      <span className="mono text-muted">{finished ? `${summary!.byStrategy[w].laps} laps` : next ? (rec && next === rec.lap + 1 ? 'pit now' : `next stop lap ${next}`) : 'no stop planned'}</span>
    </div>
  );
}

export function Scoreboard() {
  return (
    <Panel title="Strategy scoreboard">
      <div className="grid grid-cols-3 gap-2">
        <Card w="B0" />
        <Card w="B1" />
        <Card w="OPT" />
      </div>
    </Panel>
  );
}
