# PITWALL — The Impossible Pit Stop

Race simulator and adaptive pit-strategy engine for the Daytona International Speedway road course, with a live strategy dashboard.

Ten GT3-class cars race a synthetic event; our car (#12) runs under three strategies side by side on identical random streams:

- **B0** — static plan from offline dynamic programming
- **B1** — reactive crew-chief rules
- **OPT** — adaptive Monte Carlo planner that estimates hidden car state and replans on cautions, weather and wear

The full specification lives in [`docs/spec`](docs/spec/README.md). The implementation follows it gate by gate (see the commit history).

> All numbers are synthetic, labelled by provenance (`REPORTED`, `ILLUSTRATIVE`, `ASSUMED`, `UNCALIBRATED`, `UNVERIFIED`, `FITTED`). Results compare strategies under stated assumptions; they are not predictions of real races. Advisory only.

## Quick start

Requirements: Node.js ≥ 20 (developed on 22) and pnpm 10.

```bash
pnpm install
pnpm dev            # backend on http://127.0.0.1:8787 and the dashboard on http://127.0.0.1:5173
```

Open the dashboard, press **RUN** (the first run calibrates the car and builds the lap-time surrogate, ≈ 2–3 s), then use the speed buttons, **INJECT CAUTION / RAIN / FUEL SPIKE** and **FORK WHAT-IF**. Keyboard: Space run/pause, 1–4 speed, S step, C caution, R rain.

| Command | What it does |
|---|---|
| `pnpm dev` | backend (tsx watch) + Vite dev server |
| `pnpm start` | backend only (`PORT`, `HOST`, `PITWALL_DATA_DIR` for JSONL event logs, `PITWALL_FROZEN_SETTINGS` for test-split benches, `PITWALL_BENCH_HOURS` to shorten bench races) |
| `pnpm build` | production build of the dashboard (`apps/frontend/dist`) |
| `pnpm test` | shared + engine + backend suites (Vitest) |
| `pnpm --filter frontend test` | dashboard unit/smoke tests (jsdom) |
| `pnpm --filter frontend test:e2e` | Playwright caution scenario against a running backend (`PW_CHROMIUM` may point at a local Chromium) |
| `pnpm typecheck`, `pnpm lint` | TypeScript and ESLint (including the engine's determinism and import-boundary rules) |

## Layout

```
packages/shared    types, Zod schemas, default configs (track, car, race, field, planner) with provenance
packages/engine    pure TypeScript models: RNG streams and pre-draws (M01), track geometry and grip (M02),
                   QSS lap solver + surrogate (M03), tyres and fuel (M04), weather (M05), hazards/cautions (M06),
                   pit model (M07), paired race engine (M08), rivals (M09), B0/B1 (M10), estimator (M11),
                   OPT planner (M12), benchmark/experiments/sensitivity (M13), forks and API services
apps/backend       Fastify REST + WebSocket server, race workers, bench/experiment/fork job workers, event store
apps/frontend      Vite + React + Tailwind + Zustand dashboard (Race, Track, Benchmark, Assumptions tabs)
docs/spec          the implementation specification (v2)
```

## Determinism

Every random draw comes from `stream(masterSeed, streamId, …indices)` (xoshiro128** seeded by SplitMix32), and all world randomness is pre-drawn, so the three strategy worlds share the same weather, cautions, failures and rival behaviour. The planner's work is a pure function of its job (fixed successive-halving rounds; wall-clock time is only measured). Tests check identical hashes on reruns, through the API and under truth perturbation that is not yet observable.

## Measured performance (2-core cloud VM, reported not asserted)

| Measure | Target | Measured |
|---|---|---|
| Surrogate table build | ≤ 2 s | ≈ 2.35 s (calibration + surrogate ≈ 2.4 s per model) |
| Headless 3 h race, 3 worlds, B1 in every slot | ≤ 2 s | 45–100 ms |
| One OPT decision (400 paths, rounds 50/100/200/400, 40-lap horizon) | p95 ≤ 1.5 s | p50 ≈ 170 ms, p95 ≈ 290 ms |
| Full 3 h race with B0, B1 and OPT (≈ 40 decisions) | — | ≈ 6 s |

## Deviations from the specification (documented)

- **Planner placement**: the planner runs inline in each run's race worker instead of a shared planner pool. Results are identical by construction (work is partitioned by candidate and reduced in candidate order; `plan(job, { workers })` emulates pool sizes in the tests).
- **Surrogate cache**: each race worker builds its own calibrated model (≈ 2.4 s); there is no cross-worker cache because worker threads do not share memory.
- **Worker loading**: worker entry points are bundled once per process with esbuild, because tsx's loader is not inherited by worker threads.
- **Surrogate axis**: the table is stored on the effective grip axis `S_eff = S·e(w)` with outward-only lateral demand and `V_MIN = 3 m/s` (M03 doc updated); tolerance ≤ 0.05 s dry and ≤ 0.5 % overall.
- **Estimator**: with lap time as the only wear signal, a +20 % persistent wear offset is not identifiable to ±5 % within 25 laps (M11 test 1); the test asserts consistency (truth within 2σ, wear error < 0.06) instead. W coverage is asserted at ≥ 0.87 (measured ≈ 0.90–0.97).
- **OPT plans**: a candidate's first stop is firm; later stops are B1 projections and, once the firm stop is taken, OPT follows the B1 rules until the next decision (consistent with how rollouts evaluate candidates). OPT keeps a physical compound-swap safety rule, and wetness crossings bypass the weather-trigger cooldown.
- **Commit-rule stability**: grip/scheduled plan changes average ≤ 1.5 per 100 laps on calm races (spec target 1); the B0 opening plan is usually revised once around lap 20.
- **Benchmark smoke test** uses 1-hour races to stay inside the fast-suite budget; decision latency is excluded from the byte-identity check (it is a measurement).
- **Heartbeats** are not stored in the event log; they carry the latest `seq` and are ignored for ordering.
- `noUncheckedIndexedAccess` is off in `tsconfig.base.json`.

## Licence and data

Synthetic data only; no real timing data is included. The track layout is schematic with segment lengths scaled to 5.73 km.
