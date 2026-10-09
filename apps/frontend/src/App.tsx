import { useEffect } from 'react';
import { TopBar } from './ui/layout/TopBar';
import { RaceView } from './ui/race/RaceView';
import { TrackView } from './ui/track/TrackView';
import { BenchmarkView } from './ui/bench/BenchmarkView';
import { AssumptionsView } from './ui/assumptions/AssumptionsView';
import { useUi } from './store/uiStore';
import { inject, pause, run, startClock, stepLap } from './store/session';

export function App() {
  const tab = useUi((s) => s.tab);
  useEffect(() => startClock(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return;
      const ui = useUi.getState();
      if (e.key === ' ') {
        e.preventDefault();
        void (ui.playing ? pause() : run());
      } else if (['1', '2', '3', '4'].includes(e.key)) ui.setSpeed(([1, 5, 20, 60] as const)[Number(e.key) - 1]);
      else if (e.key === 's' || e.key === 'S') void stepLap();
      else if (e.key === 'c' || e.key === 'C') void inject('caution');
      else if (e.key === 'r' || e.key === 'R') void inject('rain');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="min-h-screen">
      <TopBar />
      <main>
        {tab === 'race' && <RaceView />}
        {tab === 'track' && <TrackView />}
        {tab === 'bench' && <BenchmarkView />}
        {tab === 'assumptions' && <AssumptionsView />}
      </main>
    </div>
  );
}
