# 00 — Project rules (non-negotiable)

These rules override anything else in the specification. Every module, test and UI element must respect them.

## R1. Scope

- **One track**: Daytona International Speedway road course, 5,730 m, 11 segments (`modules/M02_track_model.md`). No other tracks.
- **Ten cars**: our car **#12** plus nine rivals in the same class (GT3 / IMSA GTD-type). Rivals are synthetic and use the same physics.
- **Race length**: configurable synthetic race of **1 h, 3 h (default) or 6 h**, time-certain. It is not the Rolex 24; the UI always shows "Synthetic 3 h race" (or the chosen length).
- **Advisory only**: recommendations are shown, never presented as validated race decisions.

## R2. Determinism contract

1. Same `RunConfig` + same `masterSeed` + same injection list (kind, lap) ⇒ identical event stream, **bit for bit**, on the same backend runtime (Node.js version pinned in `01_ARCHITECTURE.md`).
2. All randomness comes from the seeded generator in `modules/M01_rng_streams.md`. `Math.random()` is banned (lint rule).
3. Every world-side random value is an **array lookup** into pre-drawn streams indexed by (car, lap, stop or environment tick). Drawing on demand from a world stream is a bug.
4. The planner is deterministic: its work budget is counted in **rounds and paths**, never in milliseconds. Wall-clock time is measured and reported only (`modules/M12_planner_opt.md` §12.8).
5. Results never depend on worker-pool size, CPU speed or scheduling order: work is partitioned by candidate and reduced in a fixed order.

## R3. Truth versus observation (integrity rule)

- The simulator holds the hidden **truth** (`WorldTruth`). Strategies and the planner see only **observations** (`Observation`, `ObsHistory`) and their own **belief** (`Belief`).
- `packages/engine/src/planner/**` and `packages/engine/src/strategy/**` must not import `WorldTruth`, `sim/race.ts` or `sim/world.ts`. Enforced with ESLint `no-restricted-imports`.
- Planner rollouts are built only by `sampleWorld(obs, history, belief, model, rng)` (`M12` §12.4). The engine's world is never cloned into the planner.
- A **truth-perturbation test** proves it: changing hidden truth (rival fuel ±20 kg, true wear coefficient +20%) while keeping observations identical must leave every decision unchanged.
- Truth may be sent to the **frontend** for display in synthetic mode only, clearly labelled "truth (hidden from strategy)".

## R4. Paired worlds

The race runs three worlds — `B0`, `B1`, `OPT` — differing only in our car's strategy. They share all pre-drawn exogenous streams, rival parameters and rival policies. Injected events apply to all three worlds at the same lap or tick. Differences between worlds are caused by strategy, not by luck.

## R5. Randomness at the causes

Grip, wear rate, fuel burn, weather and events are random; lap time is computed from them. The only direct lap-time noise is a small residual ε. Do not add independent noise to derived quantities (speed, lap time, mass).

## R6. Provenance and honesty labels

Every parameter carries exactly one `Provenance` tag:

| Tag | Meaning | Badge |
|---|---|---|
| `REPORTED` | From public specifications, not re-verified (lap length, S01/S10/S11 banking) | green outline |
| `ILLUSTRATIVE` | Derived from a drawn schematic or a plausible example value | grey outline |
| `ASSUMED` | Modelling assumption with a stated range | amber outline |
| `UNCALIBRATED` | Placeholder with no data behind it (hazard rates, incident zone levels) | red outline |
| `UNVERIFIED` | A race rule that must be checked against current regulations | purple outline |
| `FITTED` | Estimated from data (not used until real data exists) | lime outline |

Free text goes in `note`, never inside the tag. The header always shows a `SIMULATED DATA` badge. Never present a value as measured Audi, IMSA or manufacturer data. Emergent physics outputs (lap times, speeds, fuel sensitivity) are shown as **illustrative model outputs**, not calibrated results.

## R7. Objective

- **Primary objective**: minimise our car's **expected class finishing position** at the flag.
- Optional risk penalty: `score = E[P] + λ_risk·CVaR_α(P)` with **λ_risk = 0 by default**.
- Constraint: failure probability (`fail` = DNF from running dry, incident retirement or mechanical retirement) — see `M12` §12.6 for the feasibility rule and fallback.
- Always report separately: mean and median position, P(win), P(top 3), P10–P90, CVaR₀.₉₅, P(fail).

## R8. Performance is a result, not a requirement

No test asserts that OPT beats B0 or B1. Tests assert determinism, rule legality, the integrity rule and statistical correctness. Strategy performance is reported with paired confidence intervals, including families where OPT does not win (`M13`).

## R9. Seeds and splits

| Split | Master seeds | Use |
|---|---|---|
| `dev` | 1 – 4,999 | interactive runs, tuning B1 thresholds, triggers, planner settings |
| `val` | 5,000 – 9,999 | model selection |
| `test` | 1,000,000 – 1,999,999 | reported results only; run once after freezing settings |

Default interactive run: **dev seed 914**. The UI shows the split next to the seed. A test asserts the ranges never overlap and that the default seed is in `dev`.

## R10. Offline

No network calls at runtime other than frontend ↔ backend on the local machine. Fonts are self-hosted (`@fontsource/*`). No external APIs, data sources or CDNs.

## R11. No invented facts

No real team names, no real-sounding data sources, no performance claims about real manufacturers. Rival cars are labelled by generic GT3 model type with the note "class-level synthetic model".
