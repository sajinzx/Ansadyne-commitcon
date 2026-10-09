# 01 — Architecture

## 1.1 Overview

PITWALL is a **TypeScript monorepo** with a strict frontend/backend split:

- **Backend** (`apps/backend`): a Node.js service that owns every simulation. It runs races, the planner, benchmarks and the track preview, and exposes them over REST + WebSocket on `localhost`.
- **Engine** (`packages/engine`): pure TypeScript library with all models (M01–M13). No I/O, no DOM, no Node APIs. Used only by the backend (and by tests).
- **Shared** (`packages/shared`): types, Zod schemas and the default config JSON files. Used by all three.
- **Frontend** (`apps/frontend`): React dashboard. It never simulates; it renders what the backend streams and sends user commands.

```
┌──────────────────────── apps/frontend (React, Vite) ────────────────────────┐
│ TopBar · RACE tab · TRACK tab · BENCHMARK tab · ASSUMPTIONS tab             │
│ Zustand stores ← api client (fetch) + stream client (WebSocket)             │
└──────────────▲───────────────────────────────────────────────┬──────────────┘
               │ WS: lap / decision / projection / event       │ REST: runs, control,
               │                                               │ inject, fork, bench, track
┌──────────────┴──────────────── apps/backend (Fastify) ───────▼──────────────┐
│ HTTP + WS gateway · RunManager · JobManager · SurrogateCache · EventStore    │
│        │ worker_threads                                                      │
│        ├─ race worker (one per run): 3 paired worlds, estimator, triggers    │
│        ├─ planner pool (shared): deterministic plan() jobs                   │
│        └─ bench pool: headless races, planner inline                         │
└──────────────────────────────── uses packages/engine ───────────────────────┘
```

## 1.2 Pinned technology stack

| Concern | Choice (pinned major.minor) | Notes |
|---|---|---|
| Runtime | Node.js **20.x LTS** (`.nvmrc` = `20`) | Determinism is guaranteed per pinned runtime |
| Package manager | pnpm **9.x**, workspaces | Commit `pnpm-lock.yaml` |
| Language | TypeScript **5.5**, `strict: true`, `noUncheckedIndexedAccess: true` | |
| Shared schemas | Zod **3.23** | Runtime validation of configs and API payloads |
| Backend HTTP | Fastify **4.28** + `@fastify/websocket` **10.x** + `@fastify/cors` **9.x** | |
| Backend workers | Node `worker_threads` with a small in-house pool (`apps/backend/src/workers/pool.ts`) | No pool library needed |
| Frontend build | Vite **5.4** + `@vitejs/plugin-react` **4.x** | |
| UI | React **18.3**, React DOM **18.3** | |
| Styling | Tailwind CSS **3.4** + PostCSS **8** + Autoprefixer **10** (`tailwind.config.ts`) | Not Tailwind 4 |
| Client state | Zustand **4.5** | |
| Charts and map | Hand-built SVG with `d3-scale`, `d3-shape`, `d3-array` (**v3/v3/v3**) | No chart library |
| Fonts | `@fontsource/barlow-condensed`, `@fontsource/inter`, `@fontsource/jetbrains-mono` (self-hosted) | No Google Fonts link |
| Tests | Vitest **2.0** (all packages), `@testing-library/react` **16** (frontend smoke), Playwright **1.46** (one end-to-end test) | |
| Lint / format | ESLint 9 flat config + `typescript-eslint` 8, Prettier 3 | Includes the integrity and `Math.random` rules |

Scaffold commands (versions pinned so an agent cannot drift to newer majors):

```bash
mkdir pitwall && cd pitwall && pnpm init
# workspace: pnpm-workspace.yaml → packages: ["apps/*", "packages/*"]
pnpm create vite@5 apps/frontend --template react-ts
pnpm --filter frontend add react@18.3 react-dom@18.3 zustand@4.5 d3-scale@4 d3-shape@3 d3-array@3 \
  @fontsource/barlow-condensed @fontsource/inter @fontsource/jetbrains-mono
pnpm --filter frontend add -D tailwindcss@3.4 postcss@8 autoprefixer@10 @types/d3-scale @types/d3-shape @types/d3-array
pnpm --filter backend add fastify@4.28 @fastify/websocket@10 @fastify/cors@9 zod@3.23
pnpm -w add -D typescript@5.5 vitest@2.0 eslint@9 typescript-eslint@8 prettier@3 tsx@4
```

Root scripts: `pnpm dev` (backend on :8787 + frontend on :5173 concurrently), `pnpm test` (all Vitest suites), `pnpm test:slow` (long determinism/legality suites), `pnpm build`, `pnpm lint`.

## 1.3 Repository layout

```
pitwall/
  package.json  pnpm-workspace.yaml  tsconfig.base.json  eslint.config.js  .nvmrc
  packages/
    shared/
      src/types.ts            # all shared TS types (shared/SHARED_TYPES.md)
      src/schemas.ts          # Zod schemas for configs and API payloads
      src/provenance.ts
      config/
        track.daytona.json    # M02
        car.gt3.json          # M03
        race.default.json     # M04–M06
        field.json            # M09
        planner.default.json  # M12
    engine/
      src/rng/                # M01  rng.ts streams.ts predraw.ts
      src/track/              # M02  geometry.ts surface.ts
      src/vehicle/            # M03  qss.ts surrogate.ts calibrate.ts ; M04 tyre.ts fuel.ts
      src/stochastic/         # M01/M04  ou.ts
      src/world/              # M05 weather.ts ; M06 hazards.ts caution.ts
      src/sim/                # M07 pit.ts ; M08 world.ts step.ts race.ts observer.ts classify.ts
      src/strategy/           # M09 rivals.ts ; M10 b0.ts b1.ts ; M12 opt.ts
      src/estimator/          # M11 ekf.ts
      src/planner/            # M12 plan.ts triggers.ts sampleWorld.ts rollout.ts score.ts commit.ts
      src/bench/              # M13 runner.ts stats.ts families.ts sensitivity.ts
      test/                   # one test file per module + determinism/legality/integrity suites
    (no other packages)
  apps/
    backend/
      src/server.ts  src/routes/*.ts  src/ws.ts
      src/runs/RunManager.ts  src/runs/raceWorker.ts
      src/planner/plannerWorker.ts  src/bench/benchWorker.ts  src/workers/pool.ts
      src/cache/SurrogateCache.ts  src/store/EventStore.ts  src/jobs/JobManager.ts
      test/api.test.ts  test/stream.test.ts
    frontend/
      index.html  src/main.tsx  src/App.tsx  src/theme.css
      src/api/client.ts  src/api/stream.ts
      src/store/raceStore.ts  src/store/uiStore.ts  src/store/benchStore.ts
      src/ui/layout/*  src/ui/race/*  src/ui/track/*  src/ui/bench/*  src/ui/assumptions/*  src/ui/common/*
      e2e/race.spec.ts
```

## 1.4 Dependency rules (enforced by ESLint)

| Package / folder | May import | Must not import |
|---|---|---|
| `packages/shared` | nothing (except Zod) | engine, apps |
| `packages/engine/src/**` | `shared`, other engine folders as below | Node APIs, DOM, apps |
| `engine/src/planner/**`, `engine/src/strategy/**` | `shared`, `rng`, `track`, `vehicle`, `stochastic`, `estimator`, `sim/pit.ts` (pure timing functions), `sim/observerTypes.ts` | `sim/world.ts`, `sim/race.ts`, `sim/step.ts`, any `WorldTruth` type |
| `apps/backend` | `shared`, `engine` | `apps/frontend` |
| `apps/frontend` | `shared` (types and schemas only) | `engine`, `apps/backend` |

Additional lint rules: `no-restricted-globals` for `Math.random`; `no-restricted-syntax` for `Date.now()` and `performance.now()` inside `packages/engine` except in `planner/timing.ts` (reporting only).

## 1.5 Runtime topology and data flow

1. Frontend loads defaults (`GET /api/v1/config/defaults`) and the track (`GET /api/v1/track`).
2. User presses RUN → `POST /api/v1/runs` → backend validates the `RunConfig`, gets the surrogate table from `SurrogateCache` (built once per surface layout), computes the B0 plan, spawns a **race worker** and returns `RunInfo` with init data (geometry, τ curve, B0 plan, diagnostics).
3. Frontend opens `WS /api/v1/runs/{id}/stream`. The race worker simulates laps for the three worlds and stays at most **3 laps ahead** of the client's reported display time.
4. When an OPT trigger fires, the race worker builds a `PlanJob` (observation, history, belief, current plan, model bundle, seed) and sends it to the **planner pool**. With `pauseForPlanner = true` (default and required for determinism) the race worker waits for the result before computing the next lap.
5. Every lap the worker emits `LapEvent`s (one per world), plus `Decision`, `Projection` and `RaceEvent` messages. The gateway forwards them over WebSocket and appends them to the `EventStore`.
6. Commands (pause, speed, inject, risk, fork) go over REST and are applied by the worker at the next uncomputed lap, identically in all worlds; each is logged with its lap so the run can be replayed exactly.

## 1.6 Discrete-time with event timing

The engine steps **one lap per car per step** (lap-synchronous). Events that occur inside a lap (caution start, incident, fuel exhaustion, pit entry/exit, timing-line crossing inside the pit lane) are placed at a race time or lap distance and applied to the fraction of the lap they cover. Environment (weather, temperatures) is indexed by a **clock grid** of environment ticks (`M05`), so it is identical in all worlds regardless of who leads.

## 1.7 Performance targets (benchmarks, not correctness gates)

| Measure | Target on a 4-core laptop |
|---|---|
| Surrogate table build (one surface layout) | ≤ 2 s (cached) |
| Headless 3 h race, 3 worlds, B1 in the OPT slot | ≤ 2 s |
| One OPT decision at default settings (400 paths, 10 candidates, 40-lap horizon) | p95 ≤ 1.5 s |
| WebSocket event-to-render lag at 20× | p95 ≤ 250 ms |

Missing a target is reported, not a test failure.
