// Headless benchmark from the command line: families × seeds, three paired worlds per seed.
//   pnpm bench --families F1,F2,F3,F5,F6,F7,F10 --seeds 200 --hours 1 --split val --jobs 2 --out docs/bench/val-1h.json
// Each family runs in its own child process (up to --jobs at once); results are summarised with the engine's
// statistics (paired t and bootstrap CIs, Holm-adjusted p across families, win/tie/loss).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfigs, defaultRunConfig, FAMILIES } from '@pitwall/shared';
import type { Split } from '@pitwall/shared';
import { benchContext, runSeed, seedsFor } from '../src/bench/runner';
import { summarize, type SeedRecord } from '../src/bench/stats';

const args = Object.fromEntries(
  process.argv.slice(2).reduce<[string, string][]>((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : acc), []),
);
const families = (args.families ?? 'F1,F2,F3,F5,F6,F7,F10').split(',');
const seeds = Number(args.seeds ?? 20);
const hours = Number(args.hours ?? 1) as 1 | 3 | 6;
const split = (args.split ?? 'dev') as Split;
const jobs = Number(args.jobs ?? 2);
const offset = Number(args.offset ?? 0);
const trackId = args.track ?? 'daytona';
const self = fileURLToPath(import.meta.url);

if (args.child) {
  // child: one family, writes its seed records to --child
  const configs = defaultConfigs();
  const ctx = benchContext(configs, { ...defaultRunConfig(), durationHours: hours, trackId });
  const fam = families[0];
  const recs: SeedRecord[] = [];
  for (const seed of seedsFor(split, fam, seeds, offset)) {
    recs.push(runSeed(ctx, fam, seed, { durationHours: hours, trackId }));
    if (recs.length % 10 === 0) process.stderr.write(`${fam} ${recs.length}/${seeds}\n`);
  }
  writeFileSync(args.child, JSON.stringify(recs));
  process.exit(0);
}

const tmp = resolve(dirname(self), '../../../.bench-tmp');
mkdirSync(tmp, { recursive: true });
const t0 = Date.now();
const queue = [...families];
const recsBy: Record<string, SeedRecord[]> = {};
async function worker(): Promise<void> {
  for (let fam = queue.shift(); fam; fam = queue.shift()) {
    const out = resolve(tmp, `${trackId}-${fam}-${split}-${hours}h-${seeds}.json`);
    await new Promise<void>((ok, fail) => {
      const p = spawn(process.execPath, [...process.execArgv, self, '--families', fam, '--seeds', String(seeds), '--hours', String(hours), '--split', split, '--offset', String(offset), '--track', trackId, '--child', out], { stdio: ['ignore', 'inherit', 'inherit'] });
      p.on('exit', (c) => (c === 0 ? ok() : fail(new Error(`${fam} exited ${c}`))));
    });
    recsBy[fam] = JSON.parse(readFileSync(out, 'utf8'));
  }
}
await Promise.all(Array.from({ length: jobs }, worker));
const byFamily = families.map((f) => ({ family: f, index: Math.max(0, FAMILIES.indexOf(f as (typeof FAMILIES)[number])), recs: recsBy[f] }));
const res = summarize(byFamily);
const f2 = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);
console.log(`\n${trackId} · ${split} · ${hours} h · ${seeds} seeds/family · ${((Date.now() - t0) / 60000).toFixed(1)} min`);
console.log('family | B0 | B1 | OPT | OPT−B1 [95% CI] | Holm p | OPT vs B1 W/T/L | OPT−B0 | stops B1/OPT | DNF B1/OPT');
for (const fr of res) {
  const d = fr.diffs['OPT-B1'];
  const w = fr.winTieLoss['OPT-B1'];
  console.log(
    `${fr.family} | ${fr.meanPos.B0.toFixed(2)} | ${fr.meanPos.B1.toFixed(2)} | ${fr.meanPos.OPT.toFixed(2)} | ${f2(d.mean)} [${f2(d.ciT95[0])}, ${f2(d.ciT95[1])}] | ${d.holmAdjustedP.toFixed(3)} | ${w.join('/')} | ${f2(fr.diffs['OPT-B0'].mean)} | ${fr.meanStops.B1.toFixed(2)}/${fr.meanStops.OPT.toFixed(2)} | ${(1 - fr.pFinish.B1).toFixed(3)}/${(1 - fr.pFinish.OPT).toFixed(3)}`,
  );
}
if (args.out) {
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(
    resolve(args.out),
    JSON.stringify({
      split,
      hours,
      seeds,
      families,
      results: res,
      records: byFamily.map((b) => ({
          family: b.family,
          // per-seed outcomes; decision latencies are summarised in the results, not stored per seed
          recs: b.recs.map((r) => ({ seed: r.seed, worlds: Object.fromEntries(Object.entries(r.worlds).map(([k, w]) => [k, { finalPos: w.finalPos, laps: w.laps, stops: w.stops, dnf: w.dnf, decisions: w.decisions }])) })),
        })),
      }),
    );
}
