import { Panel } from '../layout/Panel';
import { useRace } from '../../store/raceStore';
import { useSession } from '../../store/session';
import { SPLIT_RANGES, type Split } from '@pitwall/shared';

const STREAMS = ['weather s0', 'caution s1', 'grip s2', 'wear s3', 'fuel s4', 'pit s5', 'failure s6', 'traffic s7'];

export function Seeds() {
  const s = useSession();
  const state = useRace((st) => st.state);
  const locked = state !== 'none';
  const { split, masterSeed } = s.config;
  const setSplit = (sp: Split) => s.setConfig({ split: sp, masterSeed: sp === 'dev' ? 914 : SPLIT_RANGES[sp][0] });
  return (
    <Panel title="Seeds">
      <div className="flex items-baseline justify-between">
        <span className="mono text-[18px] text-opt" data-testid="seed-label">
          {split} · {masterSeed}
        </span>
        <button
          className="btn"
          disabled={locked}
          onClick={() => {
            const [lo, hi] = SPLIT_RANGES[split];
            s.setConfig({ masterSeed: masterSeed >= hi ? lo : masterSeed + 1 });
          }}
          title={locked ? 'RESET RACE to change the seed' : 'next seed in the same split'}
        >
          Reroll
        </button>
      </div>
      <div className="flex gap-1" role="radiogroup" aria-label="split">
        {(['dev', 'val', 'test'] as Split[]).map((sp) => (
          <button key={sp} className={`btn ${split === sp ? 'btn-active' : ''}`} disabled={locked || sp === 'test'} title={sp === 'test' ? 'frozen settings required' : undefined} onClick={() => setSplit(sp)} aria-checked={split === sp} role="radio">
            {sp}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        {STREAMS.map((x) => (
          <span key={x} className="badge text-muted">
            {x}
          </span>
        ))}
      </div>
      <p className="text-muted text-[12px]">Paired scenarios: every strategy replays the same streams.</p>
    </Panel>
  );
}
