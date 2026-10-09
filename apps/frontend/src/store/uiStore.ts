import { create } from 'zustand';
import type { StrategyId } from '@pitwall/shared';

export type Tab = 'race' | 'track' | 'bench' | 'assumptions';

interface UiState {
  tab: Tab;
  world: StrategyId;
  ghosts: Record<StrategyId, boolean>;
  speed: 1 | 5 | 20 | 60;
  playing: boolean;
  displayTime: number;
  selectedCar: number | null;
  hoverCar: number | null;
  toast: string | null;
  setTab(t: Tab): void;
  setWorld(w: StrategyId): void;
  toggleGhost(w: StrategyId): void;
  setSpeed(s: 1 | 5 | 20 | 60): void;
  setPlaying(p: boolean): void;
  setDisplayTime(t: number): void;
  selectCar(no: number | null): void;
  hover(no: number | null): void;
  notify(msg: string | null): void;
}

export const useUi = create<UiState>((set) => ({
  tab: 'race',
  world: 'OPT',
  ghosts: { B0: true, B1: true, OPT: true },
  speed: 20,
  playing: false,
  displayTime: 0,
  selectedCar: null,
  hoverCar: null,
  toast: null,
  setTab: (tab) => set({ tab }),
  setWorld: (world) => set({ world }),
  toggleGhost: (w) => set((s) => ({ ghosts: { ...s.ghosts, [w]: !s.ghosts[w] } })),
  setSpeed: (speed) => set({ speed }),
  setPlaying: (playing) => set({ playing }),
  setDisplayTime: (displayTime) => set({ displayTime }),
  selectCar: (selectedCar) => set({ selectedCar }),
  hover: (hoverCar) => set({ hoverCar }),
  notify: (toast) => {
    set({ toast });
    if (toast) setTimeout(() => useUi.getState().toast === toast && set({ toast: null }), 4000);
  },
}));
