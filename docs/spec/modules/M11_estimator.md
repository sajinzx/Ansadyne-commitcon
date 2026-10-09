# M11 — Estimator: belief state for our car

| | |
|---|---|
| **Owns** | `packages/engine/src/estimator/ekf.ts`, `estimator/belief.ts` |
| **Depends on** | M01 (process parameters), M03 (surrogate and its Jacobian), M04 (dynamics), M08 (observation types only) |
| **Used by** | M08 (runs in every world), M12 (planner samples futures from it), frontend (Fuel & Tyres, parameter cards) |
| **Gate** | 5 |
| **Audit fixes** | A07 (persistent offsets), B02 (traffic mean and variance), B03 (rubber observed), B14 (every world), Finding 15.5 (innovation gate) |

The estimator reads **only** `Observation` / `ObsHistory`. It runs for our car in all three worlds; each world's belief feeds that world's panels and projections, and OPT uses its own for decisions.

## 11.1 Two filters

**Fuel filter** — state `f = [F, ζ, b_Z]` (`ζ = lnZ_OU`):

```
process   F'   = F − q̄_k·exp(b_Z + ζ)·g_q + refuelDelivered     g_q = known factors: burnFactor(mode), mass term, caution fraction
          ζ'   = e^{−κ_Z}·ζ + w_ζ,          Var w_ζ = σ_Z²·(1 − e^{−2κ_Z})/(2κ_Z)
          b_Z' = b_Z + w_b,                 sd w_b = 1e-4 per lap (near-constant)
measure   y    = fuelGauge = F + v,          sd v = 0.4 kg
prior     F ~ N(startingFuel, 0.2²), ζ ~ N(0, σ_Z²/(2κ_Z)), b_Z ~ N(0, 0.03²)
```

`refuelDelivered` = `lastRefuelApplied_kg` from the observation (the rig measures delivered fuel).

**Grip and wear filter** — extended Kalman filter, state `x = [ξ, η, b_Y, W]` (`ξ = lnX`, `η = lnY_OU`):

```
process   ξ'   = e^{−κ_X}·ξ + w_ξ
          η'   = e^{−κ_Y}·η + w_η
          b_Y' = b_Y + w_b,                    sd w_b = 1e-3 per lap
          W'   = W + kBase_τ·exp(b_Y + η)·g_W     g_W = known factors: mass, measured tyre temperature, mode, caution fraction, compound/wetness penalty
          on a tyre change: W ← 0 with variance 0 (ξ, η, b_Y unchanged)
measure   t_obs = h(x) + v
          h(x) = Surrogate( S(ξ, W; compound, measured T_tyre, wetness_est, rubber_est, trackTemp), m̂_mid, wetness_est, mode )·paceFactor
                 + 0.21                                     mean traffic loss (B02)
                 + dirtyAir(gapAhead observed)
          Var v = 0.15² + 0.208                              residual + traffic variance (B02)
prior     ξ ~ N(0, 0.030²), η ~ N(0, 0.095²), b_Y ~ N(0, 0.10²), W = 0
```

The Jacobian `∂h/∂x` is computed by central differences on the surrogate (step 1e-4 in each state). `rubber_est` is part of the observation (B03); the wetness used is `wetness_est`.

## 11.2 When to update

Skip the lap-time measurement update (predict only) on: caution laps (any `f_c > 0`), in-laps, out-laps, laps with an incident or puncture, and when the innovation is **gated**: `|z| = |t_obs − h(x̂)| / sqrt(H P Hᵀ + R) > 3` (a lapping event or traffic outlier). Log gated laps. The fuel filter updates every lap (the gauge is always read).

## 11.3 Belief output

```ts
interface Belief {
  lap: number;
  fuel:     { mean: number; sd: number };
  X:        { mean: number; sd: number };          // e^{ξ}
  Yeff:     { mean: number; sd: number };          // e^{b_Y + η}: effective wear-rate multiplier
  Zeff:     { mean: number; sd: number };          // e^{b_Z + ζ}
  W:        { mean: number; sd: number };
  gripCov:  number[][];  fuelCov: number[][];      // full covariances for sampling
  gated: boolean; lastInnovationZ: number;
}
sample(belief, rng, n) → n joint draws of { F, ξ, η, b_Y, W, ζ, b_Z }   (Gaussian from the covariances; W clipped to [0, 1])
```

## 11.4 Tests

1. **Persistent offset (A07)**: truth `b_Y = ln 1.2` (wear rate +20%), all other noise off: the posterior mean of `Yeff` is within ±5% of 1.2 by lap 25 of a stint.
2. **No bias from traffic (B02)**: truth X = 1, traffic and residual noise on, W known: the posterior mean of ξ over 50 laps is within ±0.005 of 0.
3. Coverage: with full noise, the true X, `Yeff` and W lie inside the 2σ interval on ≥ 90% of laps (50 seeds).
4. Burn: `Zeff` converges to within ±2% of the truth within 10 laps.
5. Gate: a single injected 8 s traffic hit is gated and does not move W by more than 0.002.
6. The estimator compiles without access to any truth type (lint).
