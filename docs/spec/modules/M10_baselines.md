# M10 — Baseline strategies: B0 (static DP plan) and B1 (reactive rules)

| | |
|---|---|
| **Owns** | `packages/engine/src/strategy/b0.ts`, `strategy/b1.ts`, `strategy/strategy.ts` (interface) |
| **Depends on** | M03 (surrogate), M04, M07 (timing functions, refuel helper), M08 (observation types) |
| **Used by** | M08, M12 (B1 is the rollout base policy and the "Δ vs B1" reference), M13 |
| **Gate** | 3 (B1), 5 (B0 DP) |
| **Audit fixes** | B09 / Finding 15.7 (exact fuel in the DP), Finding 2 (decision/execution points) |

## 10.1 Strategy interface

```ts
interface Strategy {
  id: "B0" | "B1" | "OPT";
  decide(obs: Observation, history: ObsHistory, belief: Belief, ctx: StrategyContext): StrategyOutput;
}
interface StrategyOutput { action: Action; plan?: Plan; decision?: Decision; note?: string }
// Action { pit: boolean; refuel_kg: number; tyres: "none" | "dry" | "wet"; driverChange: false; mode: "save" | "normal" | "push" }
```

`decide` is called at the decision point (line crossing at the end of lap k−1) and returns the action for lap k. The engine enforces legality at pit entry (M07 §7.2). `driverChange` is fixed to `false` in v2 (no driver-stint rules for 1–6 h synthetic races).

## 10.2 B1 — reactive crew-chief rules (`b1.ts`)

B1 uses only the observation and simple bookkeeping (it does **not** use the EKF): fuel estimate `F̂` = last gauge reading, expected burn `q̂ = qBase·burnFactor(mode)` (caution-adjusted); wear estimate `Ŵ = tyreAgeLaps·kBase_τ` (prior rate).

Evaluated each lap, first matching rule wins:

| # | Rule | Action |
|---|---|---|
| 1 | Fuel: `F̂ − q̂·(1 + 5613/5730) < reserveLaps·q̂` (cannot safely complete the next lap and reach the box after it) | pit; tyres if `Ŵ ≥ 0.35` |
| 2 | Caution: lane open and (`fuel used since stop ≥ 45% of capacity` or `Ŵ ≥ 0.30`) | pit; tyres if `Ŵ ≥ 0.25` |
| 3 | Weather: on slicks and `wetness_est ≥ 0.30` | pit for wets |
| 4 | Weather: on wets and `wetness_est ≤ 0.15` for 3 consecutive laps | pit for slicks |
| 5 | Wear: `Ŵ ≥ 0.62` | pit with tyres |
| — | otherwise | stay out |

Refuel by the helper (M07 §7.4); mode always `normal`. Thresholds (0.35, 0.45, 0.30, 0.25, 0.30, 0.15, 0.62) are tuned once on **dev** seeds and frozen before any val/test run; their values live in `planner.default.json` → `b1`.

B1 also provides `projectNextStop(obs)` (laps until rule 1 or 5 would fire) for the stint timeline and the OPT candidate `b1_action`.

## 10.3 B0 — static plan by exact dynamic programming (`b0.ts`)

Computed once before the race under **average conditions** (dry, all multipliers 1, prior coefficients, mean temperatures, no cautions, mean traffic 0.21 s/lap). B0 then follows the plan; it deviates only for engine-forced stops (fuel emergency, puncture, wear limit, repair) and a physically required compound swap (on slicks with `wetness_est > 0.5`).

**Exact fuel without bins (fixes B09).** Every B0 stop fills by the refuel rule `F_after(k_stop) = min(capacity, q̄·(K_est − k_stop + reserveLaps))`, which depends only on the stop lap. So fuel at any lap is determined by the lap index and the laps since the last fuel stop — no fuel state is needed.

```
K_est   = ceil(duration_s / lapRef) + 1
state   x = (k, a, s)       k = lap, a = laps on current tyres (0..ceil(Wlimit/kBase_dry)), s = laps since last fuel stop
fuel(k, s) = F_after(k − s) − q̄·s            (F_after(0) = startingFuel)
action  u ∈ { stay, pitFuel, pitFuelTyres }   (pits not allowed on an out-lap)
feasible: fuel at the pit entry of every lap ≥ 0 and ≥ reserveLaps·q̄ at the decision point
cost    c(x, u) = lap time from the surrogate with W(a), T_tyre(a) (cold for a = 0), m = mass_dry + fuel(k, s) − q̄/2,
                  w = 0, mode normal, + 0.21 s mean traffic;
                  pit actions use the M07 in-lap / out-lap formulas with expected service time
V_{K_est}(x) = 0;   V_k(x) = min_u [ c(x, u) + V_{k+1}(x′) ]
```

`W(a)` and `T_tyre(a)` are the deterministic tyre trajectories under average conditions (M04 with noise off). The DP also checks the tyre-set count of the optimal plan against `setsLeft` (always satisfied for 1–6 h at the default allocation; assert it).

Output `B0Plan { stops: { lap, refuel_kg, tyres }[], stints: { startLap, laps, compound }[], expectedTotal_s }`, shown as B0's planned bars in the stint timeline.

## 10.4 Tests

1. DP equals brute-force enumeration of all pit-lap and service combinations on a 20-lap toy race (fuel capacity scaled to 8 laps), using the **continuous** fuel simulation (no bins).
2. With noise off and symmetric conditions, B0 produces stints whose lengths differ by at most one lap.
3. B0 and B1 run to the flag with 0 illegal actions over 1,000 dev seeds (part of the M08 legality suite).
4. B1 never uses belief or truth fields (type-level: its `decide` ignores `belief`; lint).
