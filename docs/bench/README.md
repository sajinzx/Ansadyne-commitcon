# Benchmark results

**Setup:** 1-hour races, validation split (seeds 5000+, never used while tuning), 200 seeds per family, the seven
key families. Three paired worlds per seed. Finishing positions are 1–10, lower is better. "OPT−B1" is the paired
mean difference with a 95% t-interval. p-values are Holm-adjusted across families.

Reproduce (about 9 minutes on 2 cores):

```bash
pnpm bench --families F1,F2,F3,F5,F6,F7,F10 --seeds 200 --hours 1 --split val --jobs 2 --out docs/bench/val-1h-200.json
```

## Current (this branch)

| Family | B0 | B1 | OPT | OPT−B1 [95% CI] | Holm p | OPT vs B1 win / tie / loss | P(win) B1 → OPT | stops B1 / OPT |
|---|---|---|---|---|---|---|---|---|
| F1 calm dry | 3.60 | 3.36 | **3.02** | −0.34 [−0.45, −0.23] | < 0.001 | 61 / 136 / 3 | 13% → 22% | 1.04 / 1.07 |
| F2 early caution | 4.61 | 3.31 | **2.78** | −0.54 [−0.68, −0.39] | < 0.001 | 86 / 108 / 6 | 21% → 33% | 1.13 / 1.16 |
| F3 mid caution | 3.26 | 3.15 | **2.81** | −0.34 [−0.45, −0.22] | < 0.001 | 57 / 136 / 7 | 20% → 32% | 1.10 / 1.17 |
| F5 random cautions | 3.84 | 3.49 | **3.15** | −0.34 [−0.47, −0.21] | < 0.001 | 58 / 138 / 4 | 13% → 22% | 1.12 / 1.17 |
| F6 rain onset | 3.85 | 3.55 | **3.26** | −0.29 [−0.40, −0.18] | < 0.001 | 51 / 144 / 5 | 11% → 19% | 1.40 / 1.45 |
| F7 high wear | 4.01 | 3.65 | **3.43** | −0.23 [−0.38, −0.07] | 0.008 | 50 / 137 / 13 | 12% → 20% | 1.15 / 1.21 |
| F10 worst timing | 3.62 | 3.38 | **3.25** | −0.13 [−0.24, −0.01] | 0.039 | 38 / 154 / 8 | 16% → 21% | 1.09 / 1.14 |

OPT finishes ahead of B1 in every family, and the difference is significant after the Holm correction in all seven.
It loses to B1 in 3–13 races out of 200 per family. DNF rates are the same in all worlds (0.5%: incidents are shared
by construction). A decision takes about 140 ms at p95.

Raw per-seed outcomes: [val-1h-200.json](val-1h-200.json).

## Before the fixes (commit 11afec3, same seeds)

| Family | B1 | OPT | OPT−B1 | win / tie / loss | stops B1 / OPT |
|---|---|---|---|---|---|
| F1 | 4.17 | 4.01 | −0.17 (n.s.) | 43 / 122 / 35 | 0.91 / 1.28 |
| F2 | 4.79 | 3.54 | −1.25 | 130 / 42 / 28 | 0.41 / 1.65 |
| F3 | 3.27 | 2.71 | −0.56 | 95 / 72 / 33 | 1.08 / 2.07 |
| F5 | 4.38 | 4.09 | −0.29 (n.s.) | 56 / 107 / 37 | 0.90 / 1.39 |
| F6 | 4.46 | 4.18 | −0.28 (n.s.) | 55 / 102 / 43 | 1.10 / 1.59 |
| F7 | 4.65 | 3.50 | −1.16 | 104 / 75 / 21 | 0.94 / 1.53 |
| F10 | 4.32 | 3.33 | −0.98 | 89 / 84 / 27 | 0.90 / 1.77 |

**Read this table with care.** The old margins look bigger, but they weren't earned. In the old code no crew planned
for the minimum drive time. When a 1-hour race needed no fuel stop, B0 and B1 often never pitted, so the Bronze
driver never drove and the car was classified behind every compliant finisher. OPT made 0.4–1.0 *extra* stops per
race, mostly wasted (see [../strategy-findings.md](../strategy-findings.md)), and sometimes picked up the driver
change by accident.

The fair comparison is OPT's own finishing position, because the rivals and the luck are the same in both versions:

| | F1 | F2 | F3 | F5 | F6 | F7 | F10 |
|---|---|---|---|---|---|---|---|
| OPT before | 4.01 | 3.54 | 2.71 | 4.09 | 4.18 | 3.50 | 3.33 |
| OPT now | **3.02** | **2.78** | 2.81 | **3.15** | **3.26** | **3.43** | **3.25** |
| OPT losses to B1 (of 200), before → now | 35 → 3 | 28 → 6 | 33 → 7 | 37 → 4 | 43 → 5 | 21 → 13 | 27 → 8 |

OPT is better in six of seven families, by up to one full place, and slightly worse in F3 (+0.10). Its races
against B1 went from coin-flip-ish to rarely losing. Raw data: [val-1h-200-before.json](val-1h-200-before.json).
