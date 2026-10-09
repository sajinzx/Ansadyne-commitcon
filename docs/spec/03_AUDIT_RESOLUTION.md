# 03 — Audit resolution (v1 → v2)

Every finding from the three audits of v1 `implementation.md`, and where v2 fixes it. Sources: **W** = `rectidoc.docx` (Daytona Digital Twin implementation audit), **R2** = `rectdoc2.md` (independent audit), **R1** = `rectidoc1.md` (forensic audit).

## Critical (P0 in W and R2; P1 in R1)

| Finding | Resolution in v2 | Where |
|---|---|---|
| W 2.1, R2 #1, R1 A01 — pit route mixes track and lane distance; out-lap never charged | One route model with separate track and lane legs; timing line at lane distance `u_line = 47 m`; `117/1001` removed; in-lap and out-lap formulas both charged; identity test | M07 §7.1, §7.3, test 2; M02 pit-lane JSON |
| W 2.2, R2 #2 — pit action applied twice or a lap off | Explicit state machine with decision, execution and state-update points; each change happens once | M07 §7.2; M08 §8.3 |
| R1 A02 — refuel before in-lap burn; under-fill | Fuel at the box computed first; refuel clamped against it; DNF if the car cannot reach the box | M07 §7.4; M04 §4.5 |
| R1 A03 — caution start inside an already-computed lap | Window rule: `t_c ≥ W_lo`; incident cautions start at `max(t_event + delay, max lapEnd)` | M06 §6.3, test 1–2 |
| W 2.3, R2 #6, R1 C04 — S11 window, finite radii on straights | S11 window = 787 m; `cornerRadius_m = null` on straights without an apex window; drawn radius kept for display only | M02 §2.2 |
| W 2.4, R2 #3 — UI grip ≠ solver grip | One grip function, factorised exactly (`grip_j = S_track·node_j`); per-segment temperature/rubber overrides removed; equality test to 1e-12 | M02 §2.4; M03 §3.3, test 6 |
| W 2.5, R2 #4 — benchmark requires OPT to win | Performance is a reported result; no threshold test; claim rule with Holm-adjusted CIs | `00_PROJECT_RULES` R8; M13 §13.4; gates |
| R2 #5, R1 A04 — wall-clock budget breaks determinism | Fixed rounds (50/100/200/400), work partitioned by candidate, `budgetMs` reported only; test across pool sizes and slowdown | R2 rule; M12 §12.8, test 1 |
| R1 A05 — `cloneWorld` lets the planner read truth | `sampleWorld(obs, history, belief, model, rng)`; lint ban on truth imports; truth-perturbation test | R3; `01_ARCHITECTURE` §1.4; M12 §12.4; M08 test 5 |
| R1 A06 — OPT plan undefined | `Plan` type, per-lap behaviour, `stay` = committed plan rolled out | M12 §12.2, §12.5 |
| R1 A07 — estimator cannot learn persistent coefficients | Augmented states `b_Y`, `b_Z` (near-constant) separate from the mean-reverting parts; bias test | M04 §4.1; M11 §11.1, test 1 |
| R1 A08 — banked corners: Step 1 vs Step 2 disagree | Banked-frame friction circle in Step 2; property test; reference values recomputed (μ_peak ≈ 1.385) | M03 §3.2, §3.5, tests 3–4 |
| R1 A09, R2 #8 — random variates missing from pre-draws | Complete pre-draw manifest (tyre-temperature noise, wetness-observation noise, caution offset, all outcome uniforms, family randomness) | M01 §1.3 |

## Major (P1/P2)

| Finding | Resolution | Where |
|---|---|---|
| R2 #7, R1 C03 — "1,129 m ≈ 84 s" note wrong | Corrected: 67.7 s transit, ≈ 128 s full stop | M02 JSON note; M07 §7.1 |
| R2 #9, W 3.6 — fuel exhaustion, wear limit / puncture under closed lane, repair sets | Intra-lap fuel exhaustion at `s_dry`; edge-case table; repairs consume a set | M04 §4.5; M06 §6.5; M07 §7.6 |
| R2 #10, W 3.8, R1 C02 — Google Fonts vs offline | Self-hosted `@fontsource/*` | `01_ARCHITECTURE` §1.2; FRONTEND §F.2 |
| R2 #11, R1 B20 — pit arrays overflow; 24 h infeasible | Arrays sized from `K_max`; durations limited to 1/3/6 h; tyre sets scale with duration | M01 §1.3; M06 §6.1 |
| R2 #12 — rollout rival model biased under cautions | Per-rival caution-pit propensity (Beta) conditioned on stint length | M12 §12.4 |
| R2 #13, R1 B05 — pFail under-powered; no fallback; puncture ≠ DNF; DNF barely penalised | Feasibility on all N paths: `p̂(c) ≤ max(limit, p̂(stay))`; fallback; Wilson CI shown; puncture not a failure; DNF scored `11 + lapsMissing/lapsTotal` | M12 §12.6–12.7 |
| R2 #14 — commit compares with `stay` not the plan | `stay` *is* the committed plan rolled out; commit rule compares against it | M12 §12.10 |
| R1 B01 — σ_Y clips 2.9% of laps | σ_Y = 0.03; clip bounds ±5 stationary sd; 0-clip test; GBM clip fraction reported | M01 §1.5 |
| R1 B02 — EKF traffic variance and mean | `h` includes +0.21 s mean traffic and dirty air; `R = 0.15² + 0.208` | M11 §11.1 |
| R1 B03 — rubber not observable | `rubber_est` in the observation | M08 §8.4 |
| R1 B04 — rainProb definition | Absorbing-wet probability; trigger fires on entering damp; UI numbers corrected | M05 §5.4; M12 §12.3 |
| R1 B06 — elimination vs selection criterion | Elimination on paired mean with margin `max(2·SE, 0.10)` and CVaR check; `stay`/`b1_action` never dropped | M12 §12.8 |
| R1 B07 — pit rejoin under caution | Rejoin by line-crossing time behind cars already past the exit | M06 §6.4, test 5 |
| R1 B08 — bunching test unachievable | Reworded with the 42.8 s closing limit | M06 test 4 |
| R1 B09, R2 15.7 — DP fuel bins | Exact fuel via the fill rule; state (k, a, s); brute-force test on continuous fuel | M10 §10.3 |
| R1 B10 — default seed in test split | Splits dev 1–4,999 / val 5,000–9,999 / test ≥ 1,000,000; default dev seed 914 | R9; M13 §13.2 |
| R1 B11 — surrogate domain | S axis 0.35–1.25; out-of-range throws in tests, clamps + warns in production; overrides rebuild the node part | M03 §3.4 |
| R1 B12 — provenance vocabulary | Six-tag enum incl. `UNCALIBRATED`, `UNVERIFIED`; free text in `note` | R6; shared §S.1 |
| R1 B13 — unpinned toolchain | Versions pinned in the stack table and the scaffold commands | `01_ARCHITECTURE` §1.2 |
| R1 B14 — beliefs/projections for B0/B1 | Estimator runs in every world; projections per world | M08 §8.4; M11; BACKEND §B.4 |
| R1 B15 — planner job incomplete | `PlanJob` with history, belief, plan, model bundle, seed | M12 §12.13; M01 §1.4 |
| R1 B16 — puncture flow; legality ownership | `engineLegal` (authoritative, truth) vs `plannerLegal` (advisory); forced reasons pending to next legal entry | M07 §7.2, §7.6 |
| R1 B17 — integrity untested; slow suites | Integrity test + lint; fast/slow/e2e suites with budgets | M08 test 5; gates |
| R1 B18 — environment indexed by leader lap | Clock-grid environment ticks | M05 §5.1 |
| R1 B19 — F10 pairing | Anchored to B1's first stop in all worlds; per-world variant reported unpaired | M13 §13.1 |
| R1 B21 — lapped cars at race end | Classification at first crossing after `T_finish`; later laps voided | M08 §8.5 |
| R1 B22 — nested worker pools | Bench workers run the planner inline | M12 §12.1; M13 §13.3; BACKEND §B.1 |

## Minor (P3)

| Finding | Resolution | Where |
|---|---|---|
| R1 C01 — wrong RNG section reference | Restructured; RNG is M01 | M01 |
| R1 C05, R2 15.3 — inconsistent TopBar mock | LAP 46, CLOCK 15:01, ELAPSED 1:21:14, REMAINING 1:38:46 | FRONTEND §F.3 |
| R1 C06 — night/sun mismatch, clock wrap | `h mod 24`; night = sun 0 (19:00–07:00) | M05 §5.3 |
| R1 C07 — hard-coded night factor; zones constant | `incidents.nightMultiplier` config; zones used only for display/placement | M06 §6.1–6.2 |
| R1 C08 — reason example 41 s | Computed: ≈ 16 s caution saving | M12 §12.11; M07 §7.1 |
| R1 C09 — wet-skill discontinuity | Smooth blend over w ∈ [0.1, 0.3] | M04 §4.2 |
| R1 C10 — vacuous test 17 | Reworded to grip/scheduled-triggered changes | M12 test 6 |
| R1 C11 — seeds per family vs split size | Capped by split | M13 §13.2 |
| R1 C12, R2 15.1 — "6 even steps", apex centring, kBase | 7 mass points; windows centred; `kBase_τ` compound-specific | M03 §3.4; M02 §2.2; M04 §4.4 |
| R1 C13 — injection semantics, fork snapshots | Injection table; 200-step snapshot ring buffer; same step in all worlds | M08 §8.6 |
| R1 C14 — test 12 conditional | Generator-level pairing invariant | M01 test 7 |
| R2 15.2 — `fixedStint` units | `floor((capacity − reserveLaps·q̂)/q̂)` = 29 | M09 §9.2 |
| R2 15.4 — caution start uses `lapRef` | Offset uses `lapRef` deliberately (documented); start anchored to `W_lo` | M06 §6.3 |
| R2 15.5 — EKF traffic outliers | Innovation gate at 3σ | M11 §11.2 |
| R2 15.6 — downforce convention | Stated: perpendicular to the road surface | M03 §3.2 |
| R2 15.8 — test 12 lap 1 only | Laps 1–5, generator level | M01 test 7 |
| R1 note — `driverChange` dead | Fixed to `false` in v2, documented | M10 §10.1 |
| R1 note — halving vs N | `paths` restricted to 50·2^m | M12 §12.8 |
| R1 note — undefined types | All types defined | shared §S.3–S.6 |

## Modelling caveats (W §3, R2 §1.6) — kept and labelled

| Caveat | How v2 handles it |
|---|---|
| W 3.1 provenance gaps | Per-field provenance on every geometry and parameter field |
| W 3.2 synthetic duration | "Synthetic 3 h race" label in the TopBar; 24 h removed |
| W 3.3 uncalibrated hazards | `UNCALIBRATED` tags; hazard-sensitivity experiment |
| W 3.4 synthetic rivals | UI note "rivals follow fixed synthetic policies" |
| W 3.5 simple weather | Three-regime chain labelled `ASSUMED`; matrix editable |
| W 3.7 unvalidated lap outputs | Diagnostics labelled "illustrative model outputs" |
| W §4 objective | Primary objective = expected position; λ_risk = 0 default; other metrics reported separately |
| W §4 no-change option | `stay` candidate = committed plan; commit rule |
| W §5 build order | Six gates adopted |
