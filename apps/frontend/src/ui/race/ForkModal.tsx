import { useState } from 'react';
import type { Plan, StrategyId } from '@pitwall/shared';
import { Modal } from '../layout/Modal';
import { useRace } from '../../store/raceStore';
import { fork } from '../../store/session';

export function ForkModal({ onClose }: { onClose(): void }) {
  const info = useRace((s) => s.info);
  const step = info?.step ?? 0;
  const [world, setWorld] = useState<StrategyId>('OPT');
  const [fromStep, setFromStep] = useState(Math.max(0, step - 5));
  const [kind, setKind] = useState<'now' | 'in' | 'none'>('now');
  const [n, setN] = useState(3);
  const [tyres, setTyres] = useState<'dry' | 'wet' | 'none'>('dry');
  const minStep = Math.max(0, step - 200);
  const submit = () => {
    const lap = kind === 'now' ? fromStep + 1 : fromStep + n;
    const plan: Plan = {
      stops: kind === 'none' ? [] : [{ lap, refuel: 'helper', tyres }],
      mode: null,
      source: 'what-if',
      committedLap: fromStep,
    };
    const tyreText = tyres === 'none' ? 'fuel only' : `${tyres} tyres`;
    const label = kind === 'none' ? `${world} no stop from lap ${fromStep}` : `${world} pit lap ${lap}, ${tyreText}`;
    void fork({ world, fromStep, forcedPlan: plan }, label);
    onClose();
  };
  return (
    <Modal title="Fork what-if" onClose={onClose}>
      <div className="flex flex-col gap-3 mono">
        <label className="flex justify-between items-center">
          World
          <select className="field !w-28" value={world} onChange={(e) => setWorld(e.target.value as StrategyId)}>
            <option>OPT</option>
            <option>B1</option>
            <option>B0</option>
          </select>
        </label>
        <label className="flex justify-between items-center">
          From lap (last 200 steps)
          <input className="field" type="number" min={minStep} max={step} value={fromStep} onChange={(e) => setFromStep(Math.max(minStep, Math.min(step, Number(e.target.value))))} />
        </label>
        <fieldset className="flex flex-col gap-1">
          <legend className="panel-title mb-1">Plan from there</legend>
          <label>
            <input type="radio" checked={kind === 'now'} onChange={() => setKind('now')} /> pit now
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={kind === 'in'} onChange={() => setKind('in')} /> pit in
            <input className="field !w-14" type="number" min={1} max={30} value={n} onChange={(e) => setN(Number(e.target.value))} /> laps
          </label>
          <label>
            <input type="radio" checked={kind === 'none'} onChange={() => setKind('none')} /> no stop (engine still forces fuel stops)
          </label>
        </fieldset>
        <label className="flex justify-between items-center">
          Tyres at that stop
          <select className="field !w-36" value={tyres} onChange={(e) => setTyres(e.target.value as 'dry' | 'wet' | 'none')} disabled={kind === 'none'}>
            <option value="dry">DRY slicks</option>
            <option value="wet">WET tyres</option>
            <option value="none">keep current (fuel only)</option>
          </select>
        </label>
        <p className="text-muted text-[12px] font-sans">The fork replays the same seed and injections to the chosen lap, then this world follows the plan to the flag. The result appears as a dashed line on the position chart.</p>
        <div className="flex justify-end gap-2">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-run" onClick={submit}>
            Run fork
          </button>
        </div>
      </div>
    </Modal>
  );
}
