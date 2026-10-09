import { useState } from 'react';
import { useRace } from '../../store/raceStore';
import { useUi, type Tab } from '../../store/uiStore';
import { createRun, inject, pause, run, stepLap, useSession } from '../../store/session';
import { api } from '../../api/client';
import { clockAt, hms } from '../../lib/format';
import { egoRecord } from '../../lib/derive';
import { ForkModal } from '../race/ForkModal';

const TABS: { id: Tab; label: string }[] = [
  { id: 'race', label: 'Race' },
  { id: 'track', label: 'Track' },
  { id: 'bench', label: 'Benchmark' },
  { id: 'assumptions', label: 'Assumptions' },
];

export function TopBar() {
  const info = useRace((s) => s.info);
  const init = useRace((s) => s.init);
  const state = useRace((s) => s.state);
  const laps = useRace((s) => s.laps);
  const ui = useUi();
  const session = useSession();
  const [forkOpen, setForkOpen] = useState(false);
  const cfg = info?.config ?? session.config;
  const duration = cfg.durationHours * 3600;
  const t = Math.min(ui.displayTime, duration);
  const world = laps[ui.world];
  const ego = init?.ego ?? 12;
  // the lap and flag shown are those of the displayed world at the display time
  const current = world.filter((le) => {
    const r = egoRecord(le, ego);
    return r && r.lapStart_s <= ui.displayTime;
  });
  const le = current[current.length - 1];
  const rec = le ? egoRecord(le, ego) : undefined;
  const lap = rec ? rec.lap : 0;
  const caution = le?.caution.active;
  const wet = (le?.env.wetness ?? 0) > 0.3;
  const hasRun = !!info;
  const reproTitle = info
    ? `code ${info.repro.codeVersion} · config ${info.repro.configHash} · master seed ${info.repro.masterSeed} · split ${info.config.split}\ninjections: ${info.repro.injections.map((i) => `${i.kind}@${i.step}`).join(', ') || 'none'}`
    : 'no run yet';

  const speedBtn = (s: 1 | 5 | 20 | 60) => (
    <button
      key={s}
      className={`btn ${ui.speed === s ? 'btn-active' : ''}`}
      aria-pressed={ui.speed === s}
      onClick={() => {
        ui.setSpeed(s);
        if (info) void api.speed(info.runId, s).catch(() => undefined);
      }}
    >
      {s}x
    </button>
  );

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/95 backdrop-blur px-4 py-2 flex flex-col gap-2">
      <div className="flex items-center gap-4 flex-wrap">
        <span className="big-num text-[26px] tracking-[0.18em] text-opt" aria-label="PITWALL">
          PITWALL
        </span>
        <span className="mono text-muted cursor-help" title={reproTitle}>
          synthetic · seed {info?.seedLabel ?? `${cfg.split}-${cfg.masterSeed}`} · Synthetic {cfg.durationHours} h race
        </span>
        <Stat k="Lap" v={`${lap} / ~${init?.expectedLaps ?? Math.round(duration / 107)}`} />
        <Stat k="Clock" v={clockAt(cfg.startClock, t)} />
        <Stat k="Elapsed" v={hms(t)} />
        <Stat k="Remaining" v={hms(duration - t)} />
        <span
          className="badge"
          data-testid="flag-chip"
          style={caution ? { background: 'var(--caution)', color: '#0e1013', borderColor: 'var(--caution)' } : wet ? { color: 'var(--wet)' } : { color: 'var(--good)' }}
        >
          {caution ? `CAUTION · LAP ${lap}` : wet ? 'RAIN' : 'GREEN'}
        </span>
        <span className="badge" style={{ color: 'var(--caution)' }}>
          SIMULATED DATA
        </span>
        <div className="flex items-center gap-1.5 ml-auto flex-wrap">
          <button className="btn btn-run" onClick={() => void run()} disabled={session.creating || state === 'finished' || (ui.playing && hasRun)}>
            {session.creating ? 'Building…' : 'Run'}
          </button>
          <button className="btn" onClick={() => void pause()} disabled={!ui.playing}>
            Pause
          </button>
          {([1, 5, 20, 60] as const).map(speedBtn)}
          <button className="btn" onClick={() => void stepLap()} disabled={!hasRun || state === 'finished'}>
            Step lap
          </button>
          <button className="btn" onClick={() => void inject('caution')} disabled={!hasRun || state === 'finished'}>
            Inject caution
          </button>
        </div>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <button className="btn" onClick={() => void inject('rain')} disabled={!hasRun || state === 'finished'}>
          Inject rain
        </button>
        <button className="btn" onClick={() => void inject('fuelSpike')} disabled={!hasRun || state === 'finished'}>
          Fuel spike
        </button>
        <button className="btn" onClick={() => setForkOpen(true)} disabled={!hasRun || (info?.step ?? 0) < 2}>
          Fork what-if
        </button>
        <button className="btn" onClick={() => void createRun()} disabled={session.creating} title="Discard this run and build a new one from the World Builder settings">
          Reset race
        </button>
        <nav className="flex gap-1 ml-4" role="tablist" aria-label="Views">
          {TABS.map((tb) => (
            <button key={tb.id} role="tab" aria-selected={ui.tab === tb.id} className={`btn ${ui.tab === tb.id ? 'btn-active' : ''}`} onClick={() => ui.setTab(tb.id)}>
              {tb.label}
            </button>
          ))}
        </nav>
        {ui.toast && (
          <span className="mono text-caution ml-auto" role="status">
            {ui.toast}
          </span>
        )}
        {session.error && (
          <span className="mono text-bad ml-auto" role="alert">
            {session.error}
          </span>
        )}
      </div>
      {forkOpen && <ForkModal onClose={() => setForkOpen(false)} />}
    </header>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="panel-title">{k}</span>
      <span className="mono text-[13px]">{v}</span>
    </span>
  );
}
