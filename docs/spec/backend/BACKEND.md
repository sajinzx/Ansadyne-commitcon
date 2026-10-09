# Backend module — `apps/backend`

| | |
|---|---|
| **Role** | Owns every simulation. Runs races (three paired worlds), the planner pool, benchmarks, experiments, sensitivity and the track preview. Serves REST + WebSocket on `localhost:8787`. |
| **Depends on** | `packages/engine`, `packages/shared` |
| **Never** | serves the frontend's static files in dev (Vite does), calls external networks, or exposes truth outside the documented display fields |
| **Stack** | Node.js 20, Fastify 4.28, `@fastify/websocket` 10, `@fastify/cors` 9, Zod 3.23, `worker_threads` |
| **Gate** | 6 (full); a minimal headless runner is used from gate 3 |

## B.1 Internal components

| Component | File | Responsibility |
|---|---|---|
| Server | `src/server.ts` | Fastify setup, CORS (`http://localhost:5173`), Zod validation hook, RFC 7807 error handler, graceful shutdown |
| Routes | `src/routes/*.ts` | REST endpoints (§B.3) |
| WS gateway | `src/ws.ts` | Stream endpoint (§B.4): subscribe, replay from `fromSeq`, pacing messages |
| RunManager | `src/runs/RunManager.ts` | Create/lookup/delete runs; at most **3 active runs**; owns one race worker per run; command queue per run |
| Race worker | `src/runs/raceWorker.ts` | Runs the engine (`sim/race.ts`): three worlds in lockstep, estimator, triggers, OPT; sends `PlanJob`s to the planner pool; applies commands at the next uncomputed step; emits messages |
| Planner pool | `src/planner/plannerWorker.ts`, `src/workers/pool.ts` | `max(1, hardwareConcurrency − 2)` workers shared by all runs; executes `plan(job)` partitioned by candidate (M12 §12.8); results reduced in candidate order |
| Bench pool | `src/bench/benchWorker.ts` | `max(1, hardwareConcurrency − 1)` workers; headless races; planner inline (no nested pools) |
| JobManager | `src/jobs/JobManager.ts` | Long jobs (bench, experiments, sensitivity, forks): queue, progress, cancel, results |
| SurrogateCache | `src/cache/SurrogateCache.ts` | Builds and shares surrogate tables keyed by `hash(track, overrides, car, mu_peak)`; LRU of 8 tables |
| EventStore | `src/store/EventStore.ts` | Append-only in-memory log per run (and optional JSONL file in `./data/runs/{runId}.jsonl`); serves `GET /events` and WS replay |

## B.2 Run lifecycle

```
POST /runs ─▶ validate RunConfig ─▶ predraw (M01) ─▶ surrogate (cache) ─▶ calibrate μ_peak (cached per car config)
          ─▶ B0 DP plan ─▶ spawn race worker ─▶ state "created" (RunInfo with init payload)
control:start ─▶ "running": worker computes steps, staying ≤ 3 laps ahead of the client's display time
pause ─▶ "paused" (worker stops after the current step)       step ─▶ compute exactly one step
flag ─▶ "finished" (RunSummary stored)                       error ─▶ "error" (ProblemDetails in RunInfo)
DELETE /runs/{id} ─▶ worker terminated, store kept for 10 min
```

- **Pacing**: each WS client sends `{ type: "display", raceTime_s }` at most 10×/s. The worker computes while `lastComputedTime < max(displayTime over clients) + 3·lapRef`, or freely when no client is connected and the run was started headless (`?headless=true`).
- **pauseForPlanner** (default true): the worker waits for a decision before computing the next step. If set false (live risk setting), decisions are applied on the first step after they return; the run is then flagged `nonDeterministic: true`.
- **Commands** (inject, risk, planner settings, speed) are queued and applied at the first uncomputed step in all worlds; each is recorded in `repro.injections` or the settings log with its step.

## B.3 REST API (`/api/v1`, JSON, Zod-validated)

| Method + path | Body / query | Response | Notes |
|---|---|---|---|
| `GET /health` | — | `{ status: "ok", codeVersion, node: "20.x" }` | |
| `GET /config/defaults` | — | `{ track, car, race, field, planner }` with provenance | from `packages/shared/config` |
| `GET /track` | — | `TrackGeometryPayload` | smoothed geometry, lane stations, sectors, zones, segment table |
| `POST /track/preview` | `{ wetness, trackTemp_C, rubber, overrides: SegmentOverride[] }` | `{ segments: [{ id, effectiveGrip, node, standingWater_mm, hazard }], speedProfile: { s[], v[] }, lapTime_s, sectorTimes_s, diagnostics }` | uses the M02 grip function and a direct QSS solve |
| `POST /runs` | `RunConfig` | `201 RunInfo` (with `init`) | 422 on invalid config; 409 if 3 runs active |
| `GET /runs/{runId}` | — | `RunInfo` | |
| `POST /runs/{runId}/control` | `{ action: "start" \| "pause" \| "step" }` | `RunInfo` | |
| `POST /runs/{runId}/inject` | `{ kind, params? }` | `202 { appliesAtStep }` | caution, rain, fuelSpike, debris |
| `PUT /runs/{runId}/risk` | `{ lambdaRisk?, cvarAlpha?, pFailLimit? }` | `RunInfo` | applied from the next decision; logged |
| `PUT /runs/{runId}/planner` | `{ paths?, horizonLaps?, triggers?, pauseForPlanner? }` | `RunInfo` | |
| `POST /runs/{runId}/fork` | `ForkRequest` | `202 { jobId }` | headless run from a snapshot (≤ 200 steps back) |
| `GET /runs/{runId}/events` | `?fromSeq=&types=&limit=` | `{ events: StreamMessage[], nextSeq }` | |
| `GET /runs/{runId}/decisions/{decisionId}` | — | `Decision` | full table for the audit-log modal |
| `GET /runs/{runId}/summary` | — | `RunSummary` | 409 until finished |
| `GET /runs/{runId}/export` | `?format=json` | run record: config, repro, injections, decisions, final classification | |
| `DELETE /runs/{runId}` | — | `204` | |
| `POST /bench` | `BenchRequest` | `202 { jobId }` | 422 if `split = "test"` with unfrozen settings; `oracleBelief` allowed only here |
| `POST /experiments/{name}` | `{ seedsPerFamily, families }` | `202 { jobId }` | names from M13 §13.5 |
| `POST /sensitivity` | `{ param, seeds? }` | `202 { jobId }` | M13 §13.6 |
| `GET /jobs/{jobId}` | — | `{ state, progress: { done, total }, etaMs?, result?, error? }` | result = `BenchResult` / `ForkResult` / tornado data |
| `DELETE /jobs/{jobId}` | — | `204` | cancel |
| `GET /jobs/{jobId}/export` | `?format=csv\|json` | file | bench results with config, seeds and code version |

Errors: `application/problem+json` (`ProblemDetails`). Illegal live settings → 422 with the failing path; unknown run → 404; overloaded → 409/429.

## B.4 WebSocket stream — `WS /api/v1/runs/{runId}/stream?fromSeq=0`

Envelope (server → client), in strictly increasing `seq`:

```ts
interface StreamMessage { v: 1; runId: string; seq: number; type: StreamType; payload: unknown }
type StreamType = "run_meta" | "lap" | "decision" | "projection" | "event" | "warning" | "state" | "run_end" | "heartbeat";
```

| type | payload | when |
|---|---|---|
| `run_meta` | `RunInfo` | first message |
| `lap` | `LapEvent` (one per world per step) | every step |
| `decision` | `Decision` | each OPT decision (committed or kept) |
| `projection` | `Projection` for B0, B1, OPT | every 5 steps and after triggers (100-path projections from each world's own belief) |
| `event` | `RaceEvent` | as they occur |
| `warning` | `{ code, detail }` | surrogate out of range, planner over budget, refuel clamped |
| `state` | `{ state, step }` | lifecycle changes |
| `run_end` | `RunSummary` | at the flag |
| `heartbeat` | `{ serverTime }` | every 2 s |

Client → server: `{ type: "display", raceTime_s }` (pacing) and `{ type: "ping" }`. On reconnect the client passes the last rendered `seq`; the server replays from the EventStore without gaps or duplicates.

## B.5 Truth exposure

Truth leaves the backend only in `CarLapRecord.ego.truth` (our car only; every v2 run is synthetic), where the frontend labels it "truth (hidden from strategy)". Rivals' hidden state is never sent. Planner jobs never contain truth (M12 §12.4); a test inspects serialised `PlanJob`s for truth fields.

## B.6 Tests (`apps/backend/test`)

1. API contract: every route validates input and returns the documented shape (Zod round-trip; invalid inputs → 422 problem details).
2. Stream: ordered `seq` with no gaps; reconnect with `fromSeq` replays without duplicates; heartbeat every 2 s.
3. Determinism through the API: two runs with the same config, seed and injection list produce identical `lap` and `decision` payload hashes.
4. Pacing: with a client display time frozen, the worker stops ≤ 3 laps ahead.
5. Planner pool size 1 vs 3 vs 7 gives identical decisions (M12 test 1, end to end).
6. No truth in serialised `PlanJob`s; `oracleBelief` rejected outside `/bench`.
7. Concurrency: a 4th active run returns 409.
