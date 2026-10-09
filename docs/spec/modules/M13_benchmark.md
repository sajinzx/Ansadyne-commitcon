# M13 — Benchmark, experiments and sensitivity

| | |
|---|---|
| **Owns** | `packages/engine/src/bench/runner.ts`, `bench/families.ts`, `bench/stats.ts`, `bench/sensitivity.ts`, `bench/experiments.ts` |
| **Depends on** | M01–M12 |
| **Used by** | backend `/bench`, `/experiments`, `/sensitivity` jobs; frontend Benchmark and Assumptions tabs |
| **Gate** | 6 (full), 5 (smoke) |
| **Audit fixes** | P0-5 / R8 (performance is a result), B10 (splits), B17 (practical test suites), B19 (F10 pairing), B22 (planner inline), C11 (seed caps), 3.3 (hazard sensitivity) |

## 13.1 Scenario families

| Family | Overrides | Pairing |
|---|---|---|
| F1 Calm dry | weather fixed to dry; background caution × 0.5 | paired |
| F2 / F3 / F4 Early / mid / late caution | forced caution at the first step whose `W_lo` passes 15% / 50% / 85% of the race duration **in the B1 world**; applied at that same step in all worlds | paired |
| F5 Random cautions | defaults | paired |
| F6 Rain onset | regime forced damp → wet at tick `round((0.3 + 0.4·familyU[0])·J)` | paired |
| F7 High wear | `kBase × 1.5`, track temperature + 8 °C | paired |
| F8 Fuel stress | `qBase × 1.04`, gauge noise × 2 | paired |
| F9 Model mismatch | persistent-coefficient spreads × 3 (M04 §4.1); planner priors unchanged | paired |
| F10 Worst timing | caution forced one lap after **B1's** first stop, applied at that step in all worlds | paired |
| F10-adv (separate) | caution forced one lap after each world's own first stop | **unpaired**; reported without paired CIs |

## 13.2 Splits and seed caps

Seeds follow `00_PROJECT_RULES.md` R9: dev 1–4,999; val 5,000–9,999; test 1,000,000–1,999,999. Seeds per family are capped at the split size (dev and val: up to 4,999 / 5,000; test: up to 10,000). Settings (B1 thresholds, triggers, planner rounds, candidates) are tuned on dev only and frozen before a val or test run; the run record stores the settings hash.

## 13.3 Procedure

- For each seed and family, run the three worlds headless (no `LapEvent` streaming). Bench workers = `max(1, hardwareConcurrency − 1)`; each runs the planner **inline** and single-threaded, with rounds `[50, 100, 200]` (stated in the report).
- Per world record: final class position, laps, DNF and cause, stops, P(win) indicator, decision count, decision `elapsedMs` (p50, p95).
- Results are keyed by `(code version, settings hash, family, seed)` and reproducible (R2).

## 13.4 Statistics (`stats.ts`)

- Paired differences per seed: `D = P(OPT) − P(B1)`, plus OPT − B0 and B1 − B0.
- Mean D with a **95% percentile bootstrap CI** (2,000 resamples, RNG `stream(0, 11, 9001, familyIndex)` so reports are reproducible) and a paired t-interval; report both.
- Win / tie / loss rates with Wilson 95% intervals; P(finish) per strategy with McNemar's test for paired finish/DNF; P(win), P(top 3); CVaR₀.₉₅ of position; mean stops; p95 decision time.
- Multiple comparisons: Holm–Bonferroni across families for each strategy pair.
- **Claim rule**: say OPT beats B1 in a family only if the Holm-adjusted CI excludes 0 in OPT's favour. Families where it does not are shown in the same table. No benchmark outcome is ever a pass/fail test (R8).

## 13.5 Experiments (`experiments.ts`)

| # | Experiment | Output |
|---|---|---|
| 1 | GBM vs exp-OU multipliers | strategy ranking under each; GBM clip fraction; marked invalid if clips > 1% |
| 2 | Grip volatility σ_X ∈ {0.006, 0.012, 0.024} | ranking stability |
| 3 | Grip–wear correlation ρ_XY ∈ {0, −0.4, −0.8} | ranking stability |
| 4 | Honesty test: OPT with an **oracle belief** (truth injected into the belief; bench-only flag `oracleBelief`, rejected by the live API) vs normal OPT | value of perfect information; the reported OPT result is always the non-oracle one |
| 5 | Seed-set stability: one family on 5 disjoint dev seed sets | how often each strategy ranks first |
| 6 | Hazard sensitivity: background caution and incident rates × {0.5, 1, 2} | ranking stability (hazards are uncalibrated) |

## 13.6 Sensitivity (`sensitivity.ts`)

For any `ASSUMED`, `ILLUSTRATIVE` or `UNCALIBRATED` numeric parameter with `low`/`high`: run 100 dev seeds at low and at high, report mean D (OPT − B1) at each, and draw a tornado chart (frontend). Parameters without a range get ±20%.

## 13.7 Tests

1. A 20-seed F5 run with rounds `[50, 100]` produces the full table with CIs; rerunning gives byte-identical results (fast suite, < 60 s).
2. Split ranges never overlap; the default interactive seed (914) is in dev; requesting a test-split run with unfrozen settings returns an error.
3. F2–F4 and F10 forced cautions occur at the same step in all three worlds.
4. The `oracleBelief` flag is accepted only by bench jobs.
