import type { ReactNode } from 'react';
import { ProvenanceBadge } from '../layout/Badge';
import { Panel } from '../layout/Panel';
import { Sparkline } from '../common/charts';
import { useRace } from '../../store/raceStore';
import { useUi } from '../../store/uiStore';
import { useShownLaps } from './useDisplayed';
import { egoRecord } from '../../lib/derive';
import { fmt } from '../../lib/format';

function Card({ title, prov, model, children, line }: { title: string; prov: string; model: string; children: ReactNode; line: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel2 p-2.5 flex flex-col gap-1.5 min-w-0">
      <div className="flex justify-between items-center gap-1">
        <span className="panel-title !text-text">{title}</span>
        <ProvenanceBadge p={prov} />
      </div>
      <div className="mono text-[10.5px] bg-bg rounded px-1.5 py-1 text-muted truncate" title={model}>
        {model}
      </div>
      {children}
      <div className="mono text-[11px]">{line}</div>
    </div>
  );
}

export function ParameterCards() {
  const world = useUi((s) => s.world);
  const init = useRace((s) => s.init);
  const cfg = useRace((s) => s.info?.config);
  const shown = useShownLaps(world);
  const ego = init?.ego ?? 12;
  const recs = shown.map((le) => egoRecord(le, ego)).filter((r) => r?.ego?.belief);
  const series = (get: (b: NonNullable<NonNullable<(typeof recs)[number]>['ego']>) => [number, number, number | undefined]) => {
    const m: number[] = [];
    const lo: number[] = [];
    const hi: number[] = [];
    const tr: number[] = [];
    for (const r of recs) {
      const [mean, sd, truth] = get(r!.ego!);
      m.push(mean);
      lo.push(mean - 2 * sd);
      hi.push(mean + 2 * sd);
      tr.push(truth ?? NaN);
    }
    return { m, lo, hi, tr };
  };
  const X = series((e) => [e.belief.X.mean, e.belief.X.sd, e.truth?.X]);
  const Y = series((e) => [e.belief.Yeff.mean, e.belief.Yeff.sd, e.truth?.Yeff]);
  const Z = series((e) => [e.belief.Zeff.mean, e.belief.Zeff.sd, e.truth?.Zeff]);
  const last = shown[shown.length - 1];
  const env = last?.env;
  const wetHist = shown.map((le) => le.env.wetness);
  const regimes = shown.map((le) => le.env.regime);
  const cautionHist = shown.map((le) => (le.caution.active ? 1 : 0));
  const lastB = recs[recs.length - 1]?.ego?.belief;
  const pit = init?.diagnostics.pit;
  const hazard = cfg?.overrides.race?.background_per_lap ?? 0.004;
  const model = cfg?.multiplierModel === 'gbm' ? 'GBM' : 'exp-OU';
  return (
    <Panel title="Parameters">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
        <Card title="Grip X" prov="ASSUMED" model={`${model} · d ln X = κ(θ − ln X)dt + σ dW`} line={lastB ? `belief ${fmt(lastB.X.mean, 3)} ± ${fmt(lastB.X.sd, 3)}` : '—'}>
          <Sparkline mean={X.m} lo={X.lo} hi={X.hi} truth={X.tr} />
        </Card>
        <Card title="Wear rate Y" prov="ASSUMED" model={`${model} · Yeff = e^(b_Y + η) · ρ_XY = −0.4`} line={lastB ? `belief ${fmt(lastB.Yeff.mean, 3)} ± ${fmt(lastB.Yeff.sd, 3)}` : '—'}>
          <Sparkline mean={Y.m} lo={Y.lo} hi={Y.hi} truth={Y.tr} />
        </Card>
        <Card title="Fuel burn Z" prov="ASSUMED" model={`${model} · Zeff = e^(b_Z + ζ) · gauge σ 0.4 kg`} line={lastB ? `belief ${fmt(lastB.Zeff.mean, 3)} ± ${fmt(lastB.Zeff.sd, 3)}` : '—'}>
          <Sparkline mean={Z.m} lo={Z.lo} hi={Z.hi} truth={Z.tr} />
        </Card>
        <Card
          title="Weather"
          prov="ILLUSTRATIVE"
          model="Markov chain · per-tick P matrix"
          line={env ? `${env.regime} · rain in 20: ${(env.rainProb.in20 * 100).toFixed(1)}% · wetness ${env.wetness.toFixed(2)}` : '—'}
        >
          <Sparkline mean={wetHist} color="var(--wet)" />
          <div className="flex h-1.5 rounded overflow-hidden">
            {regimes.map((r, i) => (
              <span key={i} className="flex-1" style={{ background: r === 'dry' ? 'var(--line-2)' : r === 'damp' ? '#6f9fd8' : 'var(--wet)' }} />
            ))}
          </div>
        </Card>
        <Card title="Caution hazard" prov="UNCALIBRATED" model="h(weather, night) · uncalibrated" line={`${(hazard * 100).toFixed(1)}% per lap · now: ${last?.caution.active ? 'caution' : 'green'}`}>
          <Sparkline mean={cautionHist} color="var(--caution)" />
        </Card>
        <Card title="Pit stop" prov="ASSUMED" model="service = fuel/2 kg·s⁻¹ + 16 s tyres (sequential) · lognormal 9% + 3% slow" line={pit ? `full stop ${pit.fullStop_s.toFixed(1)} s · net green ${pit.netGreen_s.toFixed(1)} s · net caution ${pit.netCaution_s.toFixed(1)} s` : '—'}>
          <div className="h-[46px] grid place-items-center big-num text-[30px] text-muted">{pit ? `${pit.netGreen_s.toFixed(1)} s` : '—'}</div>
        </Card>
      </div>
    </Panel>
  );
}
