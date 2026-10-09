# PITWALL — Implementation Specification (v2, audited)

Daytona road-course race simulator and adaptive pit-strategy engine with a live strategy dashboard. Ten GT3-class cars, our car (#12) highlighted, three strategies (B0 static, B1 reactive, OPT adaptive) racing side by side on identical random streams.

**v2** replaces the single `implementation.md` (v1). It applies every correction from the three audits of v1 (`rectidoc.docx`, `rectidoc1.md`, `rectdoc2.md`) and splits the specification into independent module files. `03_AUDIT_RESOLUTION.md` maps each audit finding to the place where it is fixed.

## How to use this with a coding agent (Claude Code, Antigravity)

1. Give the agent the whole folder. Tell it: *"Build PITWALL exactly as specified. Start with `README.md`, `00_PROJECT_RULES.md` and `01_ARCHITECTURE.md`, then implement gate by gate following `02_BUILD_GATES_AND_TESTS.md`. For each module, read its file in `modules/` and implement only its contract."*
2. Build **one gate at a time**. Do not start a gate until every test of the previous gate passes.
3. When a module file and another file seem to disagree, the precedence order is: `00_PROJECT_RULES.md` → the module file that **owns** the topic (named in its header) → everything else.

## Files

| File | What it specifies |
|---|---|
| `00_PROJECT_RULES.md` | Non-negotiable rules: determinism, truth vs observation, provenance labels, objective, seeds and splits |
| `01_ARCHITECTURE.md` | Frontend/backend split, pinned stack, monorepo layout, dependency rules, runtime topology |
| `02_BUILD_GATES_AND_TESTS.md` | Six build gates, the modules each gate delivers, and all acceptance tests |
| `03_AUDIT_RESOLUTION.md` | Every audit finding → resolution → file/section |
| `shared/SHARED_TYPES.md` | Shared TypeScript types, Zod schemas, config files and provenance vocabulary |
| `backend/BACKEND.md` | Backend service: process model, REST API, WebSocket stream, run lifecycle, workers, injections, forks, benchmarks |
| `frontend/FRONTEND.md` | Frontend app: visual language, layout, every panel, animation, Track/Benchmark/Assumptions tabs, API client |
| `modules/M01_rng_streams.md` | Seeded RNG, stream ids, the complete pre-draw manifest, seed derivation |
| `modules/M02_track_model.md` | Daytona geometry, lookups, the single surface-grip function, track JSON |
| `modules/M03_vehicle_qss_surrogate.md` | Car parameters, banked-frame QSS lap solver, surrogate table, calibration |
| `modules/M04_tyre_fuel.md` | Grip scale, tyre temperature, wear, puncture, fuel and mass equations |
| `modules/M05_weather_environment.md` | Clock-indexed weather chain, wetness, temperatures, rubber, rain probability |
| `modules/M06_hazards_caution.md` | Incidents, failures, caution start window, queue, pit-closure, rejoin |
| `modules/M07_pit_stop.md` | Single pit route model, pit state machine, fuel at the box, in-lap/out-lap accounting |
| `modules/M08_race_engine.md` | Three paired worlds, the per-lap procedure, observer, race end and classification |
| `modules/M09_field_rivals.md` | The ten cars and rival policies |
| `modules/M10_baselines.md` | B0 (exact DP) and B1 (rules) |
| `modules/M11_estimator.md` | Augmented EKF belief state (runs in every world) |
| `modules/M12_planner_opt.md` | OPT: Plan type, triggers, `sampleWorld`, candidates, deterministic rollouts, scoring, feasibility, commit rule |
| `modules/M13_benchmark.md` | Scenario families, splits, paired statistics, experiments, sensitivity |

## Decisions taken in v2 (the audits asked for them)

| Question | Decision |
|---|---|
| Puncture: DNF risk or time penalty? | Time penalty plus a forced stop. **Not** a DNF. |
| F10 "caution after our first stop": paired or per world? | Paired: anchored to **B1's** first stop and applied identically in all worlds. A per-world adversarial variant is reported separately, without paired CIs. |
| Keep the 24 h option? | No. Durations 1 h, 3 h, 6 h. 24 h needs driver-stint rules and tyre logistics that are out of scope. |
| Wear-rate volatility σ_Y | Reduced to 0.03 (stationary sd of ln Y ≈ 0.095). Clip bounds widened to ±5 stationary sd. |
| Rain forecast information | Rain probability depends on the current regime only (known transition matrix). No hidden forecast signal. |
| Estimator in the B0/B1 worlds? | Yes. The estimator reads only observations, so it runs in every world and feeds that world's panels and projections. |
| Primary objective | Expected class finishing position. CVaR is an optional risk penalty, off by default (λ = 0). P(win), P(top 3), CVaR and P(fail) are reported separately. |
| Frontend/backend | Separate apps: a Node.js backend runs all simulation; a React frontend talks to it over REST + WebSocket. |

## Status

This is a specification for a **synthetic simulator**. Every number is labelled `REPORTED`, `ILLUSTRATIVE`, `ASSUMED`, `UNCALIBRATED`, `UNVERIFIED` or `FITTED`. Results are relative strategy comparisons under stated assumptions, not predictions of real Daytona races, and the system is advisory only.
