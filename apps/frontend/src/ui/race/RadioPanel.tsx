// Team radio: live messages from the engine about our car in the displayed world, each with its evidence.
// Messages appear when the display clock reaches them, so they stay in sync with the map.
import { useEffect, useMemo, useState } from 'react';
import type { RadioMessage } from '@pitwall/shared';
import { Panel } from '../layout/Panel';
import { WORLD_COLOR } from '../layout/Badge';
import { useRace } from '../../store/raceStore';
import { useUi } from '../../store/uiStore';

const PRIORITY_COLOR = { action: 'var(--opt)', alert: 'var(--caution)', info: 'var(--b1)' } as const;
const KIND_ICON: Record<RadioMessage['kind'], string> = {
  pit: '🔧',
  decision: '🧠',
  weather: '🌧️',
  caution: '🟨',
  driver: '🧑‍✈️',
  tyres: '🛞',
  fuel: '⛽',
  penalty: '⚖️',
  incident: '⚠️',
};

export function useShownRadio(): RadioMessage[] {
  const radio = useRace((s) => s.radio);
  const world = useUi((s) => s.world);
  const t = useUi((s) => s.displayTime);
  return useMemo(() => radio.filter((m) => m.world === world && m.raceTime_s <= t + 1e-6), [radio, world, t]);
}

function Message({ m, open, big = false }: { m: RadioMessage; open: boolean; big?: boolean }) {
  return (
    <div className="rounded-lg border p-2.5 flex flex-col gap-1" style={{ borderColor: PRIORITY_COLOR[m.priority], background: big ? 'rgba(215,255,63,0.04)' : 'var(--panel-2)' }}>
      <div className="flex items-baseline gap-2">
        <span aria-hidden>{KIND_ICON[m.kind]}</span>
        <span className={`font-cond font-bold uppercase tracking-wider ${big ? 'text-[17px]' : 'text-[13px]'}`} style={{ color: PRIORITY_COLOR[m.priority] }}>
          {m.title}
        </span>
        <span className="mono text-[11px] text-muted ml-auto shrink-0">lap {m.lap}</span>
      </div>
      <div className={`mono ${big ? 'text-[13px]' : 'text-[12px]'}`}>{m.text}</div>
      {open && m.proof.length > 0 && (
        <ul className="mt-0.5 flex flex-col gap-0.5" aria-label="evidence">
          {m.proof.map((p, i) => (
            <li key={i} className="mono text-[11px] text-muted pl-3 relative before:content-['›'] before:absolute before:left-0 before:text-faint">
              {p}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RadioPanel() {
  const shown = useShownRadio();
  const world = useUi((s) => s.world);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const latest = shown[shown.length - 1];
  const key = latest ? `${latest.step}-${latest.title}` : '';
  useEffect(() => {
    if (!key) return;
    setFlash(true);
    const h = setTimeout(() => setFlash(false), 2500);
    return () => clearTimeout(h);
  }, [key]);
  const older = shown.slice(0, -1).reverse().slice(0, 30);
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: flash ? 'var(--opt)' : 'var(--line-2)', boxShadow: flash ? '0 0 10px var(--opt)' : 'none', transition: 'all 150ms' }} aria-hidden />
          Team radio · car #12 · <span style={{ color: WORLD_COLOR[world] }}>{world}</span>
        </span>
      }
    >
      <div data-testid="radio-latest" aria-live="polite">
        {latest ? <Message m={latest} open big /> : <span className="mono text-muted text-[12px]">Quiet on the radio. Messages appear here with the evidence behind each call.</span>}
      </div>
      {older.length > 0 && (
        <ul className="flex flex-col gap-1.5 max-h-[300px] overflow-auto pr-1">
          {older.map((m, i) => (
            <li key={`${m.step}-${m.title}-${i}`}>
              <button className="w-full text-left" onClick={() => setExpanded(expanded === i ? null : i)} aria-expanded={expanded === i}>
                <Message m={m} open={expanded === i} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
