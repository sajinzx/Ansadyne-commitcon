import { describe, expect, it } from 'vitest';
import type { StreamMessage } from '@pitwall/shared';
import fixture from './fixtures/stream.json';
import { useRace } from '../src/store/raceStore';
import { auditEntries, cautionBands, positionSeries, stints } from '../src/lib/derive';

const msgs = fixture as unknown as StreamMessage[];

describe('race store replay', () => {
  it('replays a recorded stream into per-world series, stints and audit entries', () => {
    useRace.getState().reset(null);
    // feed in two batches, then the whole stream again: duplicates must be ignored
    useRace.getState().ingestMany(msgs.slice(0, 40));
    useRace.getState().ingestMany(msgs.slice(40));
    useRace.getState().ingestMany(msgs);
    const s = useRace.getState();
    expect(s.lastSeq).toBe(msgs[msgs.length - 1].seq);
    expect(s.init?.ego).toBe(12);
    expect(s.laps.OPT.length).toBe(14);
    const ego = 12;
    const series = positionSeries(s.laps.OPT, ego);
    expect(series.map((p) => p.lap)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(series.every((p) => p.pos >= 1 && p.pos <= 10)).toBe(true);
    // the caution injected at step 4 covers lap 5 onwards in every world
    const bands = cautionBands(s.laps.B1, ego);
    expect(bands[0].from).toBe(5);
    const bars = stints(s.laps.OPT, ego, null, 34);
    expect(bars[0].from).toBe(1);
    expect(bars.filter((b) => !b.planned).reduce((n, b) => n + (b.to - b.from + 1), 0)).toBe(14);
    const audit = auditEntries(s.decisions, s.events, 'OPT', ego, 'dev-914');
    expect(audit[audit.length - 1].text).toContain('run start');
    expect(audit.some((a) => a.text.includes('injected caution'))).toBe(true);
    expect(audit.filter((a) => a.kind === 'decision').length).toBe(s.decisions.length);
    expect(s.available_s).toBeGreaterThan(13 * 100);
  });
});
