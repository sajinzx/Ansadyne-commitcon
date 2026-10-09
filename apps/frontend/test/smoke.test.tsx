import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { StreamMessage } from '@pitwall/shared';
import { PROVENANCE_TAGS, defaultConfigs } from '@pitwall/shared';
import fixture from './fixtures/stream.json';
import { App } from '../src/App';
import { useRace } from '../src/store/raceStore';
import { useUi } from '../src/store/uiStore';
import { ProvenanceBadge } from '../src/ui/layout/Badge';

const msgs = fixture as unknown as StreamMessage[];
const init = (msgs[0].payload as { init: { track: unknown } }).init;

beforeAll(() => {
  const responses: Record<string, unknown> = {
    '/config/defaults': defaultConfigs(),
    '/track': init.track,
    '/experiments': [{ id: 'gbm', title: 'GBM vs exp-OU multipliers', variants: ['exp-OU', 'GBM'] }],
    '/sensitivity/params': [],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url).pathname.replace('/api/v1', '');
      const body = path === '/track/preview' ? { segments: [], speedProfile: { s: [], v: [] }, lapTime_s: 107, sectorTimes_s: [29, 47, 31], diagnostics: (msgs[0].payload as { init: { diagnostics: unknown } }).init.diagnostics } : responses[path];
      return new Response(JSON.stringify(body ?? {}), { status: 200 });
    }),
  );
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (h: number) => clearTimeout(h));
});
afterEach(cleanup);

describe('dashboard smoke', () => {
  it('renders every tab with mocked data; SIMULATED DATA is always visible', async () => {
    useRace.getState().reset(null);
    useRace.getState().ingestMany(msgs);
    useUi.getState().setDisplayTime(14 * 107);
    render(<App />);
    expect(screen.getByText('SIMULATED DATA')).toBeTruthy();
    expect(screen.getByText('Race map')).toBeTruthy();
    expect(screen.getByTestId('position-chart')).toBeTruthy();
    expect(screen.getByTestId('decision-table')).toBeTruthy();
    expect(screen.getByTestId('ego-car')).toBeTruthy();
    for (const tab of ['Track', 'Benchmark', 'Assumptions']) {
      await act(async () => {
        fireEvent.click(screen.getByRole('tab', { name: tab }));
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(screen.getByText('SIMULATED DATA')).toBeTruthy();
    }
    expect(screen.getByText('Limitations')).toBeTruthy();
  });

  it('renders provenance badges for all six tags', () => {
    render(
      <div>
        {PROVENANCE_TAGS.map((p) => (
          <ProvenanceBadge key={p} p={p} />
        ))}
      </div>,
    );
    for (const p of PROVENANCE_TAGS) expect(screen.getByText(p)).toBeTruthy();
    expect(PROVENANCE_TAGS.length).toBe(6);
  });
});
