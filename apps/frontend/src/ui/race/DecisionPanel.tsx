import { useState } from 'react';
import type { Decision } from '@pitwall/shared';
import { Panel } from '../layout/Panel';
import { TriggerBadge } from '../layout/Badge';
import { Histogram } from '../common/charts';
import { Modal } from '../layout/Modal';
import { useShownDecisions } from './useDisplayed';
import { candidateText } from '../../lib/derive';
import { fmt, sign } from '../../lib/format';

const HIST_LABELS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'DNF'];

function planText(d: Decision): string {
  const s = d.plan.stops[0];
  if (!s) return 'plan: no further stop';
  const svc = s.tyres === 'none' ? 'fuel only' : `fuel + 4 ${s.tyres} tyres`;
  return `plan: pit lap ${s.lap}, ${svc}${d.plan.mode ? ` · ${d.plan.mode.mode} until lap ${d.plan.mode.untilLap}` : ''}`;
}

export function DecisionTable({ d }: { d: Decision }) {
  return (
    <table className="data" data-testid="decision-table">
      <thead>
        <tr>
          <th>Candidate</th>
          <th>Mean</th>
          <th>P10–P90</th>
          <th>P(fail)</th>
          <th>Δ vs B1</th>
        </tr>
      </thead>
      <tbody>
        {d.candidates.map((c) => {
          const chosen = c.id === d.chosen;
          const better = c.deltaCI90[1] < 0;
          const worse = c.deltaCI90[0] > 0;
          return (
            <tr key={c.id} style={{ background: chosen ? 'rgba(215,255,63,0.08)' : undefined, boxShadow: chosen ? 'inset 3px 0 0 var(--opt)' : undefined, opacity: c.feasible || chosen ? 1 : 0.45 }}>
              <td className="!font-sans" title={c.label}>
                {!c.feasible && <span title="infeasible or eliminated">⚠ </span>}
                {candidateText(c.id)}
              </td>
              <td>{fmt(c.meanPos, 2)}</td>
              <td>
                {fmt(c.p10, 0)}–{fmt(c.p90, 0)}
              </td>
              <td title={`Wilson 95%: ${(c.pFailCI95[0] * 100).toFixed(1)}–${(c.pFailCI95[1] * 100).toFixed(1)}% · ${c.paths} paths`}>{(c.pFail * 100).toFixed(1)}%</td>
              <td style={{ color: better ? 'var(--good)' : worse ? 'var(--bad)' : undefined }} title={`paired 90% CI ${fmt(c.deltaCI90[0], 2)} … ${fmt(c.deltaCI90[1], 2)}`}>
                {c.id === 'b1_action' ? '—' : sign(c.deltaVsB1)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function DecisionDetail({ d }: { d: Decision }) {
  return (
    <div className="flex flex-col gap-3">
      <DecisionTable d={d} />
      <div className="mono text-[12px]">{d.committed ? `Committed lap ${d.lap} · ${planText(d)}` : (d.keptReason ?? 'Kept plan')}</div>
      <Histogram a={d.histChosen} b={d.histB1} labels={HIST_LABELS} />
      <div className="text-muted text-[11px] mono">
        Finishing position, OPT (lime) vs B1 (blue) · N {d.nPaths} · rounds {d.rounds.join('/')} · {d.elapsedMs.toFixed(0)} ms{d.overBudget ? ' (over budget)' : ''} · rank stability {(d.rankStability * 100).toFixed(0)}%
      </div>
      {d.reasons.length > 0 && (
        <ul className="list-disc pl-5 text-[12px]">
          {d.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DecisionPanel() {
  const decisions = useShownDecisions();
  const d = decisions[decisions.length - 1];
  const [open, setOpen] = useState(false);
  return (
    <Panel title="Decision" right={d ? <TriggerBadge trigger={d.trigger} /> : undefined}>
      {!d ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-4 rounded bg-panel2" />
          ))}
          <span className="mono text-muted">Waiting for the first trigger… (400 paths per decision)</span>
        </div>
      ) : (
        <>
          <div className="mono text-[12px] flex justify-between gap-2">
            <span style={{ color: d.committed ? 'var(--opt)' : 'var(--muted)' }}>{d.committed ? `Committed lap ${d.lap} · ${planText(d)}` : (d.keptReason ?? 'Kept plan — gain not significant')}</span>
            <button className="btn !py-0" onClick={() => setOpen(true)}>
              Details
            </button>
          </div>
          <DecisionTable d={d} />
          <Histogram a={d.histChosen} b={d.histB1} labels={HIST_LABELS} />
          <div className="text-muted text-[11px] mono">
            Finishing position, OPT vs B1 · N {d.nPaths} · rounds {d.rounds.join('/')} · {d.elapsedMs.toFixed(0)} ms · rank stability {(d.rankStability * 100).toFixed(0)}%
          </div>
        </>
      )}
      {open && d && (
        <Modal title={`Decision ${d.id} · lap ${d.lap}`} onClose={() => setOpen(false)} wide>
          <DecisionDetail d={d} />
        </Modal>
      )}
    </Panel>
  );
}
