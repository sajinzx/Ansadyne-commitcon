# M12 — OPT: the adaptive strategy (plan → triggers → planner → commit)

| | |
|---|---|
| **Owns** | `packages/shared/config/planner.default.json`, `packages/engine/src/strategy/opt.ts`, `planner/plan.ts`, `planner/triggers.ts`, `planner/sampleWorld.ts`, `planner/rollout.ts`, `planner/score.ts`, `planner/commit.ts`, `planner/timing.ts` |
| **Depends on** | M01 (planner stream), M03, M04, M05 (forecast), M06 (hazard model), M07 (timing functions), M08 (observation types), M10 (B1 as base policy), M11 (belief) |
| **Must not import** | `WorldTruth`, `sim/world.ts`, `sim/step.ts`, `sim/race.ts` (lint) |
| **Gate** | 5 |
| **Audit fixes** | A04 (deterministic budget), A05 (`sampleWorld`), A06 (Plan type), B04 (weather trigger), B05 (fail and fallback), B06 (elimination), B15 (job bundle), B22 (bench inline), C08, C10, Findings 12, 13, 14, §4 of the Word audit (objective, no-change option) |

## 12.1 Flow per lap

```
obs_{k−1} → belief (M11) → triggers (§12.3) ─┬─ none  → emit the action implied by the committed Plan for lap k
                                             └─ fired → PlanJob → planner (§12.4–12.9) → commit rule (§12.10) → action for lap k
```

With `pauseForPlanner = true` (default; required for determinism) the race waits for the decision. The planner runs in the backend planner pool; in benchmarks it runs inline in the bench worker (no nested pools, fixes B22).

## 12.2 The Plan (fixes A06)

```ts
interface Plan {
  stops: { lap: number; refuel: "helper" | number; tyres: "none" | "dry" | "wet" }[];   // future stops, ascending laps
  mode: { mode: "save" | "normal" | "push"; untilLap: number } | null;
  source: string;            // candidate id that created it, e.g. "pit_in_4"
  committedLap: number;
}
```

- **Between decisions** OPT emits, for lap k: `pit = true` with the plan's service if `stops[0].lap === k`, otherwise `pit = false`; mode from `plan.mode` until `untilLap`, else `normal`. A stop that has happened is removed from the plan.
- **Initial plan** at the start = the B0 DP plan (M10 §10.3).
- **Candidate → Plan**: each candidate replaces the plan's first commitment; later stops come from the B1 projection made at decision time (`projectNextStop` repeatedly on the expected path).
- The stint timeline shows OPT's committed plan; the `fuel` and `scheduled` triggers use `plan.stops[0].lap` as "the planned stop".

## 12.3 Triggers (`triggers.ts`)

| Trigger | Condition (from observation and belief only) | Cooldown |
|---|---|---|
| `caution` | caution starts; and again when the pit lane opens | none |
| `grip` | EKF innovation \|z\| > 2.0 on 2 consecutive updated laps | 5 laps |
| `wear` | posterior mean W > 0.45 and `Yeff` mean > 1 + 2·sd | 5 laps |
| `fuel` | projected fuel at the planned stop's pit entry < `reserveLaps·q̂` | 3 laps |
| `weather` | `rainProb.in20` crosses 0.30 either way (fires on entering damp, B04), or `wetness_est` crosses 0.15 or 0.30 | 10 laps |
| `rivalPit` | an in-class rival within ±20 s pits | 2 laps |
| `incident` | our puncture or repair is pending | none |
| `forced` | the engine has a forced reason pending for our car | none |
| `scheduled` | every 10 laps, and 3 laps before the planned stop | — |

Several triggers on one lap produce **one** decision (labelled with the highest-priority trigger: caution > forced > incident > fuel > weather > wear > grip > rivalPit > scheduled). Every firing is logged.

## 12.4 Building rollout worlds without truth: `sampleWorld` (fixes A05)

```ts
sampleWorld(obs: Observation, history: ObsHistory, belief: Belief, model: ModelBundle, rng: Rng): RolloutWorld
```

For each path:

| Element | Source |
|---|---|
| Our car's hidden state (F, ξ, η, b_Y, W, ζ, b_Z) | joint draw from `belief` (M11 §11.3) |
| Our observed state (compound, tyre age, temps, position, gaps, sets) | `obs` |
| Weather path | Markov chain from `obs.regime` with the known matrix (M05), planner stream |
| Track temperature, rubber | M05 equations from the observed values |
| Cautions, incidents, failures, punctures | hazard model (M06) evaluated on the path's state, planner stream |
| Rival pace | mean and sd of each rival's last 5 green laps in `history` (fallback: class mean ± 0.4 s) |
| Rival fuel window | laps since the rival's last observed stop vs class fuel range `floor((capacity − q̄)/q̄)` ± 2 laps |
| Rival caution behaviour (Finding 12) | per-rival propensity `p_cautionPit ~ Beta(1 + pitted, 1 + stayed)` updated from that rival's observed choices at previous open-lane cautions; in a path, a rival pits when the lane opens with probability `p_cautionPit` if ≥ 8 laps into its stint, and always if within 2 laps of its fuel window |
| Rival tyre choice | new tyres every second stop (class prior) |

`ModelBundle` = car, race and field configs, the surrogate table, τ curve and the B1 thresholds. The planner never receives `WorldTruth`.

## 12.5 Candidates

| id | Meaning (first commitment) |
|---|---|
| `stay` | **the committed plan, rolled out unchanged** (the no-change option) |
| `pit_fuel` | pit this lap, fuel only |
| `pit_fuel_tyres` | pit this lap, fuel + tyres for current conditions |
| `pit_swap_compound` | pit this lap, fuel + the other compound (only if `wetness_est ≥ 0.1` or `rainProb.in20 ≥ 0.3`) |
| `pit_in_2`, `pit_in_4` | pit in 2 / 4 laps with fuel + tyres |
| `save_then_pit` | save mode for 5 laps, then pit (extends the stint) |
| `push_to_stop` | push mode until the planned stop |
| `b1_action` | what B1 would do now (reference for Δ vs B1) |

Candidates that fail `plannerLegal(obs, belief, action)` (lane closed, out-lap, no set left) are dropped, except `stay` and `b1_action`, which are always evaluated.

## 12.6 Rollout and scoring (`rollout.ts`, `score.ts`)

- **Common random numbers**: futures `0 … N−1` are generated from `stream(masterSeed, 10, lap, decisionIdx, 0)`; every candidate is evaluated on the same futures.
- **Rollout**: vectorised over paths (`Float64Array` per state variable). Apply the candidate's plan; when the plan has no further stops, continue with the B1 rules on the path's state (base policy). Simulate all ten cars with the surrogate (our car) and rival mean pace + pit events (rivals), using M04/M06/M07 formulas.
- **Horizon** `H = 40` laps or the flag. **Terminal value** at the horizon: for each car, projected remaining laps = remaining time ÷ expected lap time, minus required stops × expected net pit loss ÷ expected lap time; finishing order from projected distance.
- **Per-path outcome**: class position P ∈ 1..10; a failure (DNF from `fuel`, `incident`, `failure`) scores `P = 11 + lapsMissing/lapsTotal`. A puncture is not a failure.
- **Metrics per candidate**: mean, median, P10, P90, P(win), P(top 3), CVaR₀.₉₅(P), `p̂_fail`; `Δ vs B1` = paired mean of `P(c) − P(b1_action)` with a paired 90% t-interval.
- **Score**: `score = mean(P) + λ_risk·CVaR_α(P)`, `λ_risk = 0` by default (primary objective = expected position).

## 12.7 Feasibility and fallback (fixes B05, Finding 13)

- Evaluated on **all N paths** of the final round only (never at n = 50).
- Candidate `c` is feasible if `p̂_fail(c) ≤ max(pFailLimit, p̂_fail(stay))` — never worse than keeping the plan, or under the absolute limit. `pFailLimit = 1%` by default.
- If `stay` is itself illegal (a forced stop is pending), feasibility uses the absolute limit only; if no candidate is feasible, choose the minimum-`p̂_fail` candidate and set `keptReason = "all candidates above the failure limit"`.
- Report `p̂_fail` with a Wilson 95% interval in the Decision table.

## 12.8 Deterministic successive halving (fixes A04, B06)

```
rounds = [50, 100, 200, 400]          (default; always all rounds; futures 0..n−1 in each round)
for n in rounds:
   evaluate surviving candidates on futures 0..n−1
   leader = best mean P
   drop c if  mean(P_c − P_leader) > max(2·SE_paired, 0.10)
              and (λ_risk = 0 or CVaR(c) ≥ CVaR(leader))
   never drop: stay, b1_action
final round: metrics, feasibility (§12.7), choose best feasible by score
```

- The work done is a pure function of the job. `budgetMs` (1,500) is **only measured and reported** (`elapsedMs`, an `overBudget` flag); it never stops computation.
- Work is partitioned **by candidate** across planner workers; each worker regenerates the futures from the seed; results are reduced in candidate-id order. Pool size does not change results.
- `paths` in the settings sets the last round (it must be 50·2^m; the UI offers 100, 200, 400, 800).

## 12.9 Rank stability

Re-run the top-two comparison on 5 extra seed sets (`seedSet = 1..5`, 100 paths each). Stability = share of seed sets with the same winner. Shown as "rank stability 93%"; logged with the decision.

## 12.10 Commit rule (fixes Finding 14; no noisy switching)

The comparison is always against the **committed plan** — `stay` is that plan rolled out unchanged. OPT replaces its plan only if all hold:

1. `score(best) ≤ score(stay) − 0.15` positions;
2. the paired 90% CI of `P(best) − P(stay)` lies entirely below 0;
3. at least 3 laps since the last change — unless the trigger is `caution`, `forced`, `incident`, `fuel` or a compound-critical `weather` change.

Otherwise keep the plan and log "kept plan — gain not significant" (or the failing condition).

## 12.11 Reasons (plain language, at most 3)

Built from the largest drivers, using computed numbers, e.g.:
- "Caution: net pit loss ≈ 16 s cheaper than under green" (from M07: 71.9 s green vs 55.5 s caution at default service);
- "Tyre wear 0.47 ± 0.05; cliff (0.55) in ≈ 6 laps";
- "Fuel for 9.8 laps; next window closes lap 74";
- "Rain probability 36% within 20 laps (track damp)".

## 12.12 `planner.default.json` (create exactly this)

```json
{
  "paths": 400, "rounds": [50, 100, 200, 400], "horizonLaps": 40, "budgetMs": 1500,
  "lambdaRisk": 0.0, "cvarAlpha": 0.95, "pFailLimit": 0.01,
  "elimination": { "minGap": 0.10, "seMultiplier": 2 },
  "commit": { "minGainPositions": 0.15, "ciLevel": 0.90, "dwellLaps": 3 },
  "triggers": { "gripZ": 2.0, "gripConsecutive": 2, "gripCooldown": 5, "wearCooldown": 5, "fuelReserveLaps": 1.0,
                "fuelCooldown": 3, "rainProbThreshold": 0.30, "weatherCooldown": 10, "rivalWindow_s": 20,
                "rivalCooldown": 2, "scheduledEvery": 10, "preStopLaps": 3 },
  "rankStability": { "seedSets": 5, "paths": 100 },
  "pauseForPlanner": true,
  "b1": { "fuelTyreWear": 0.35, "cautionFuelUsed": 0.45, "cautionWear": 0.30, "cautionTyreWear": 0.25,
          "wetIn": 0.30, "wetOut": 0.15, "wearLimit": 0.62 }
}
```

## 12.13 Planner job (fixes B15)

```ts
interface PlanJob {
  obs: Observation; history: ObsHistory; belief: Belief; plan: Plan;
  model: ModelBundle;            // configs, surrogate (transferable), τ curve
  config: PlannerConfig;         // from planner.default.json plus live risk settings
  seed: { master: number; lap: number; decisionIdx: number };
  trigger: string;
}
plan(job: PlanJob): Decision    // Decision type in shared/SHARED_TYPES.md
```

## 12.14 Tests

1. **Determinism**: the same `PlanJob` gives an identical `Decision` (excluding `elapsedMs`, `overBudget`) with planner pools of 1, 3 and 7 workers and with an artificial 10× slowdown.
2. **Integrity**: the truth-perturbation test (M08 §8.7 test 5) passes for OPT.
3. **Plan execution**: after committing `pit_in_4` at lap 50 with no later trigger, OPT pits at lap 54 and the stint timeline shows that stop.
4. **Fallback**: with a forced stop pending and all candidates above the limit, the minimum-`p̂_fail` candidate is chosen and `keptReason` is set.
5. **Elimination**: `stay` and `b1_action` are present in every final table.
6. **Commit rule**: on a stationary calm race, plan changes caused by `grip` or `scheduled` triggers are ≤ 1 per 100 laps (rewritten v1 test 17).
7. Latency (benchmark, not a gate): p95 `elapsedMs` at defaults is reported in the bench report.
