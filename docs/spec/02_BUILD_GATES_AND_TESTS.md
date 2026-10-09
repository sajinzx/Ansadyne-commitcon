# 02 — Build gates and acceptance tests

Build in six gates. **Do not start a gate until every exit test of the previous gate passes.** Each gate adds one layer of complexity, so errors are found where they are introduced. (This replaces v1's 12-step order and its performance gate.)

| Gate | Builds | Modules | Exit criterion |
|---|---|---|---|
| 1 | Monorepo, shared schemas, RNG, track model, track view | `01_ARCHITECTURE`, `shared`, M01 §1.1–1.2, M02, backend `/track` + `/track/preview` (grip only), frontend TRACK tab (map, inspector, surface controls) | Track renders with segments, pit lane, timing line, sectors, zones; distances reconcile; grip check passes |
| 2 | Deterministic single-car lap and pit stop (no randomness) | M03, M04 (noise off), M07, M08 single-car mode | Lap times, pit entry/line/box/exit timing, fuel and tyre updates match hand calculations |
| 3 | Multi-car race, rivals, B1 | M08 multi-car + classification, M09, M10 §10.2 (B1), headless runner | Ten cars race to the flag with legal actions, correct positions, gaps and classification |
| 4 | Weather, incidents, cautions, stochastic terms | M01 §1.3–1.5, M04 (noise on), M05, M06, three paired worlds (B1 in all slots) | Determinism, pairing and legality suites pass |
| 5 | Strategy: B0, estimator, OPT planner, bench smoke | M10 §10.3 (B0), M11, M12, M13 smoke | Planner determinism, integrity, fallback and commit tests pass; a bench smoke table is produced |
| 6 | Full backend, full dashboard, benchmark, experiments | `backend/BACKEND.md`, `frontend/FRONTEND.md`, M13 full | API, stream, UI and e2e tests pass; reports generated |

## Gate exit tests

### Gate 1
- G1.1 Lint: `Math.random` banned; integrity import rule configured; `pnpm build` works offline (fonts self-hosted).
- G1.2 RNG (M01 tests 1).
- G1.3 Geometry and grip (M02 tests 1–4): lengths sum to 5,730 m, radii present only where an apex window exists, banked windows equal segment lengths, S01 grip 1.011, lane stations ordered.
- G1.4 Config schemas reject an unknown provenance tag and out-of-range values (`shared` §S.2).
- G1.5 Frontend smoke: TRACK tab renders the map and inspector from a mocked `/track`.

### Gate 2
- G2.1 QSS (M03 tests 1–4, 6): calibrated lap 107.00 ± 0.01 s, `mu_peak` ∈ [1.33, 1.44], `a_long ≥ 0` property, wet-banking monotone, exact grip factorisation.
- G2.2 Surrogate (M03 test 5, 7).
- G2.3 Tyre and fuel (M04 tests 1–6) with noise off.
- G2.4 Pit (M07 tests 1, 2, 4): 84.5 s full stop; in-lap + out-lap identity to 1e-9; fuel-at-box DNF; full fill = capacity.
- G2.5 Single-car 10-lap race with one stop reproduces hand-computed lap times (M08 test 6).

### Gate 3
- G3.1 Holding/overtaking rule and position/gap computation unit tests.
- G3.2 Race end and classification (M08 test 4).
- G3.3 Field and rivals (M09 tests 1–4).
- G3.4 B1 rules unit tests (each rule fires on a constructed observation).
- G3.5 Legality smoke: 50 seeds, 0 illegal actions, 0 overfills, 0 set overdraws.

### Gate 4
- G4.1 Pre-draw manifest, sizes, overflow error, exp-OU/GBM statistics, correlation (M01 tests 2–7).
- G4.2 Weather (M05 tests 1–4).
- G4.3 Hazards and cautions (M06 tests 1–6), including "no computed lap contains a later-declared `t_c`" and the reworded bunching test.
- G4.4 Pit edge cases (M07 tests 3, 5, 6).
- G4.5 **Determinism** (M08 test 1): 50 seeds with B1 in all three slots → identical stream hashes on rerun.
- G4.6 **Pairing** (M08 test 2, M01 test 7).
- G4.7 **Legality** (`pnpm test:slow`, M08 test 3): 1,000 seeds × 3 worlds.

### Gate 5
- G5.1 B0 DP vs brute force with continuous fuel (M10 tests 1–2).
- G5.2 Estimator (M11 tests 1–6), including the persistent-offset and traffic-bias tests.
- G5.3 Planner (M12 tests 1–6): determinism across pool sizes and a 10× slowdown; plan execution; fallback; `stay`/`b1_action` always present; commit-rule stability.
- G5.4 **Integrity** (M08 test 5): truth perturbation leaves decisions identical; serialised `PlanJob`s contain no truth fields.
- G5.5 Full-OPT determinism: 5 seeds, all three strategies, identical hashes on rerun.
- G5.6 Bench smoke (M13 test 1): 20-seed F5 table with CIs, byte-identical on rerun.

### Gate 6
- G6.1 Backend (BACKEND tests 1–7).
- G6.2 Frontend (FRONTEND tests 1–5), including the Playwright caution scenario.
- G6.3 Bench (M13 tests 2–4); a dev-split report for all families is generated.
- G6.4 Performance targets (`01_ARCHITECTURE.md` §1.7) are measured and shown in the bench report — reported, not asserted.

## Test-suite budgets

| Suite | Command | Budget |
|---|---|---|
| Fast (all unit + gate tests except slow) | `pnpm test` | ≤ 5 min on a 4-core laptop |
| Slow (1,000-seed legality, 50-seed determinism) | `pnpm test:slow` | ≤ 30 min; run before merging a gate |
| e2e | `pnpm test:e2e` | ≤ 3 min |

## Acceptance checklist before calling the model reliable

- [ ] Track segment lengths reconcile to 5,730 m, with every estimate labelled.
- [ ] Pit route distances, speeds, service, timing-line crossing and lap counting use the one model in M07.
- [ ] Every pit action executes once, at the documented state transition.
- [ ] UI and solver use the same surface-grip function (exact by construction, tested).
- [ ] Fuel, wear, punctures, cautions and pit-lane closures have defined transition rules (M04, M06, M07).
- [ ] Random scenarios reproduce from recorded seeds and injection lists.
- [ ] The planner returns identical decisions for identical inputs across restarts, pool sizes and machine speeds.
- [ ] Planner information is restricted to observations available at decision time (integrity test + lint).
- [ ] Benchmarks report paired results with uncertainty; no test requires a winner.
- [ ] Synthetic assumptions and uncalibrated outputs are visibly labelled.
- [ ] Each subsystem has a deterministic test before its stochastic version is introduced (gate order).
