// Selectors for "what is shown now": the latest records/decisions not later than the display clock.
import type { Decision, LapEvent, StrategyId } from '@pitwall/shared';
import { useRace } from '../../store/raceStore';
import { useUi } from '../../store/uiStore';
import { egoRecord } from '../../lib/derive';

export function useShownLaps(world: StrategyId): LapEvent[] {
  const laps = useRace((s) => s.laps[world]);
  const ego = useRace((s) => s.init?.ego ?? 12);
  const t = useUi((s) => s.displayTime);
  return laps.filter((le) => {
    const r = egoRecord(le, ego);
    return !!r && r.lapStart_s + r.lapTime_s <= t + 1e-6;
  });
}

/** The lap our car is on in `world` at the display time (0 before the first crossing). */
export function useDisplayedLap(world: StrategyId): number {
  const shown = useShownLaps(world);
  const ego = useRace((s) => s.init?.ego ?? 12);
  const last = shown[shown.length - 1];
  return last ? (egoRecord(last, ego)?.lap ?? 0) : 0;
}

export function useShownDecisions(): Decision[] {
  const decisions = useRace((s) => s.decisions);
  const lap = useDisplayedLap('OPT');
  return decisions.filter((d) => d.lap <= lap);
}
