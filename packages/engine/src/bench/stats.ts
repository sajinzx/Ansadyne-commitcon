// M13 §13.4 — per-family statistics over seeds; deterministic (bootstrap RNG from stream(0, 11, 9001, family)).
import type { DiffKey, FamilyResult, StrategyId } from '@pitwall/shared';
import { STRATEGIES } from '@pitwall/shared';
import { hash32 } from '../rng/rng';
import { bootstrapMeanCI, cvar, holm, mean, normalCdf, pairedCI, pairedPValue, quantile, sd, tQuantile, wilson } from '../stats';

export interface WorldRecord {
  finalPos: number;
  laps: number;
  stops: number;
  dnf: string | null;
  decisions: number;
  decisionMs: number[];
}

export interface SeedRecord {
  family: string;
  seed: number;
  worlds: Record<StrategyId, WorldRecord>;
  clipFraction: number;
}

const PAIRS: [DiffKey, StrategyId, StrategyId][] = [
  ['OPT-B1', 'OPT', 'B1'],
  ['OPT-B0', 'OPT', 'B0'],
  ['B1-B0', 'B1', 'B0'],
];

/** Exact two-sided McNemar p-value from the discordant counts. */
export function mcnemar(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let p = 0;
  let term = Math.pow(0.5, n); // C(n,0)/2^n
  for (let i = 0; i <= k; i++) {
    p += term;
    term = (term * (n - i)) / (i + 1);
  }
  return Math.min(1, 2 * p);
}

/** Welch interval and two-sided p for an unpaired difference of means (F10-adv). */
function welch(a: number[], b: number[], level: number): { mean: number; lo: number; hi: number; p: number } {
  const ma = mean(a);
  const mb = mean(b);
  const va = sd(a) ** 2 / a.length;
  const vb = sd(b) ** 2 / b.length;
  const se = Math.sqrt(va + vb);
  const nu = (va + vb) ** 2 / ((va * va) / Math.max(1, a.length - 1) + (vb * vb) / Math.max(1, b.length - 1) || 1);
  const t = tQuantile(1 - (1 - level) / 2, Math.max(1, nu));
  const d = ma - mb;
  const p = se > 0 ? 2 * (1 - normalCdf(Math.abs(d / se))) : d === 0 ? 1 : 0;
  return { mean: d, lo: d - t * se, hi: d + t * se, p };
}

/** Summaries for one family (Holm adjustment is applied across families by `summarize`). */
export function summarizeFamily(family: string, familyIndex: number, recs: SeedRecord[]): FamilyResult & { _p: Record<DiffKey, number> } {
  const paired = family !== 'F10-adv';
  const n = recs.length;
  const pos = (id: StrategyId) => recs.map((r) => r.worlds[id].finalPos);
  const fin = (id: StrategyId) => recs.map((r) => (r.worlds[id].dnf ? 0 : 1));
  const diffs = {} as FamilyResult['diffs'];
  const pRaw = {} as Record<DiffKey, number>;
  PAIRS.forEach(([key, a, b], pi) => {
    const pa = pos(a);
    const pb = pos(b);
    if (paired) {
      const d = pa.map((v, i) => v - pb[i]);
      const t = pairedCI(pa, pb, n, 0.95);
      const boot = bootstrapMeanCI(d, hash32(0, 11, 9001, familyIndex, pi));
      pRaw[key] = pairedPValue(d);
      diffs[key] = { mean: t.mean, ciBoot95: boot, ciT95: [t.lo, t.hi], holmAdjustedP: pRaw[key] };
    } else {
      const w = welch(pa, pb, 0.95);
      pRaw[key] = w.p;
      diffs[key] = { mean: w.mean, ciBoot95: [w.lo, w.hi], ciT95: [w.lo, w.hi], holmAdjustedP: w.p };
    }
  });
  const wtl = (a: StrategyId, b: StrategyId): [number, number, number] => {
    const pa = pos(a);
    const pb = pos(b);
    let w = 0;
    let t = 0;
    let l = 0;
    pa.forEach((v, i) => (v < pb[i] ? w++ : v === pb[i] ? t++ : l++));
    return [w, t, l];
  };
  const wt1 = wtl('OPT', 'B1');
  const wt0 = wtl('OPT', 'B0');
  const mc = (a: StrategyId, b: StrategyId) => {
    const fa = fin(a);
    const fb = fin(b);
    let x = 0;
    let y = 0;
    fa.forEach((v, i) => {
      if (v === 1 && fb[i] === 0) x++;
      if (v === 0 && fb[i] === 1) y++;
    });
    return mcnemar(x, y);
  };
  const per = <T>(f: (id: StrategyId) => T) => Object.fromEntries(STRATEGIES.map((id) => [id, f(id)])) as Record<StrategyId, T>;
  const optMs = recs.flatMap((r) => r.worlds.OPT.decisionMs);
  return {
    family,
    n,
    paired,
    diffs,
    winTieLoss: { 'OPT-B1': wt1, 'OPT-B0': wt0 },
    winTieLossCI: {
      'OPT-B1': [wilson(wt1[0], n), wilson(wt1[1], n), wilson(wt1[2], n)],
      'OPT-B0': [wilson(wt0[0], n), wilson(wt0[1], n), wilson(wt0[2], n)],
    },
    mcnemarP: { 'OPT-B1': mc('OPT', 'B1'), 'OPT-B0': mc('OPT', 'B0') },
    pFinish: per((id) => mean(fin(id))),
    pWin: per((id) => mean(pos(id).map((p, i) => (p === 1 && fin(id)[i] ? 1 : 0)))),
    pTop3: per((id) => mean(pos(id).map((p, i) => (p <= 3 && fin(id)[i] ? 1 : 0)))),
    cvar95: per((id) => cvar(pos(id), 0.95)),
    meanStops: per((id) => mean(recs.map((r) => r.worlds[id].stops))),
    meanPos: per((id) => mean(pos(id))),
    decisionMsP95: optMs.length ? quantile(optMs, 0.95) : 0,
    _p: pRaw,
  };
}

/** Summaries for all families with Holm–Bonferroni across families per strategy pair and the claim rule. */
export function summarize(byFamily: { family: string; index: number; recs: SeedRecord[] }[]): FamilyResult[] {
  const rows = byFamily.map((f) => summarizeFamily(f.family, f.index, f.recs));
  for (const [key] of PAIRS) {
    const adj = holm(rows.map((r) => r._p[key]));
    rows.forEach((r, i) => (r.diffs[key].holmAdjustedP = adj[i]));
  }
  return rows.map(({ _p, ...r }) => {
    const d = r.diffs['OPT-B1'];
    // claim only if the Holm-adjusted test is significant in OPT's favour (negative D = better position)
    return { ...r, claimOptBeatsB1: r.paired && d.mean < 0 && d.holmAdjustedP < 0.05 && d.ciBoot95[1] < 0 };
  });
}
