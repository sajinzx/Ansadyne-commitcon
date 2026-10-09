import { useState } from 'react';
import type { Decision } from '@pitwall/shared';
import { Panel } from '../layout/Panel';
import { Modal } from '../layout/Modal';
import { DecisionDetail } from './DecisionPanel';
import { useRace } from '../../store/raceStore';
import { useUi } from '../../store/uiStore';
import { api } from '../../api/client';
import { auditEntries } from '../../lib/derive';
import { sign } from '../../lib/format';
import { useDisplayedLap, useShownDecisions } from './useDisplayed';

export function AuditLog() {
  const decisions = useShownDecisions();
  const events = useRace((s) => s.events);
  const info = useRace((s) => s.info);
  const ego = useRace((s) => s.init?.ego ?? 12);
  const world = useUi((s) => s.world);
  const lap = useDisplayedLap('OPT');
  const [open, setOpen] = useState<Decision | null>(null);
  const entries = auditEntries(decisions, events.filter((e) => e.step < lap), world, ego, info?.seedLabel ?? '—');
  return (
    <Panel title="Audit log">
      <ul className="flex flex-col gap-1 max-h-[260px] overflow-auto pr-1" data-testid="audit-log">
        {entries.map((e) => (
          <li key={e.key}>
            <button
              className="w-full text-left mono text-[12px] flex gap-3 hover:bg-panel2 rounded px-1 disabled:cursor-default"
              disabled={!e.decisionId}
              onClick={async () => {
                if (!e.decisionId || !info) return;
                setOpen(await api.decision(info.runId, e.decisionId).catch(() => decisions.find((d) => d.id === e.decisionId) ?? null));
              }}
            >
              <span className="text-muted w-14 shrink-0">Lap {e.lap}</span>
              <span className="flex-1">{e.text}</span>
              {e.delta !== undefined && <span style={{ color: e.delta < 0 ? 'var(--good)' : e.delta > 0 ? 'var(--bad)' : 'var(--muted)' }}>Δ {sign(e.delta, 1)}</span>}
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <Modal title={`Decision ${open.id} · lap ${open.lap}`} onClose={() => setOpen(null)} wide>
          <DecisionDetail d={open} />
        </Modal>
      )}
    </Panel>
  );
}
