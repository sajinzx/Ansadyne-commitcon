# M01 — Random numbers, streams, pre-draws and multiplier processes

| | |
|---|---|
| **Owns** | `packages/engine/src/rng/rng.ts`, `rng/streams.ts`, `rng/predraw.ts`, `stochastic/ou.ts` |
| **Depends on** | `shared` (types, configs) |
| **Used by** | every world-side module (M04–M09), planner (M12, own stream only), bench (M13) |
| **Gate** | 1 (RNG), 4 (pre-draws and processes) |
| **Audit fixes** | A09, B01, B15(d), B18, Finding 8, Finding 11, C13 |

## 1.1 Generator

- **xoshiro128\*\*** (four 32-bit words), seeded through **SplitMix32** from a 32-bit seed.
- API: `nextU32()`, `uniform()` ∈ [0, 1) (`nextU32() / 2^32`), `normal()` (Box–Muller; caches the spare value — deterministic because every array is filled in a fixed order), `exponential1()` = `−ln(1 − uniform())`, `lognormal(mu, sigma)`, `categorical(probs)`.
- `hash32(...ints)`: combine integers with the MurmurHash3 `fmix32` finaliser in sequence (`h = fmix32(h ^ x_i + 0x9e3779b9 + (h << 6) + (h >>> 2))`, starting from `h = 0x811c9dc5`).
- `stream(masterSeed, streamId, ...indices)` → a new generator seeded with `hash32(masterSeed, streamId, ...indices)`. Indices let one stream id produce independent sub-streams (per car, per decision, per seed set).
- `Math.random()` is banned in `packages/engine` (lint).

## 1.2 Stream ids

| id | Name | Scope |
|---|---|---|
| 0 | `weather` | environment ticks: regime transitions, temperature noise; per-lap wetness observation noise |
| 1 | `caution` | background caution decision, start offset, duration (per step) |
| 2 | `grip` | grip multiplier shocks (per car) |
| 3 | `wear` | wear-rate multiplier shocks (per car) |
| 4 | `fuel` | burn multiplier shocks, fuel-gauge noise (per car) |
| 5 | `pit` | pit service variability (per car, per stop) |
| 6 | `failure` | incident, failure and puncture uniforms and their outcomes (per car) |
| 7 | `traffic` | traffic, residual lap noise, tyre-temperature noise (per car) |
| 8 | `rival` | rival parameter jitter and policy-threshold jitter (per car) |
| 9 | `params` | hierarchical per-race coefficients (per car) |
| 10 | `planner` | planner futures — **never** used by the world |
| 11 | `family` | benchmark-family randomness (forced-event times) |

## 1.3 Complete pre-draw manifest (fixes A09, Finding 8, Finding 11)

Before the race starts, `predraw(config, masterSeed)` fills every array below. **Any random value used by the world must come from this table.** Adding a new random quantity means adding a row here.

Sizes: `K_max = ceil(duration_s / (0.9 · lapRef)) + 20` laps; `J_max = ceil(duration_s / lapRef) + 40` environment ticks (tick length `Δ_env = lapRef = 107 s`); `S_max = ceil(K_max / 5) + 5` stops per car.

| Array | Stream | Shape | Distribution | Consumed by |
|---|---|---|---|---|
| `weatherU` | 0 | [J_max] | U(0,1) | M05 regime transition at tick j |
| `trackTempN` | 0 | [J_max] | N(0,1) | M05 track-temperature AR(1) noise |
| `wetObsN` | 0 | [K_max] | N(0,1) | M08 observer: `wetness_est` noise for our car's lap k |
| `cautionU` | 1 | [K_max] | U(0,1) | M06 background caution at step k |
| `cautionStartU` | 1 | [K_max] | U(0,1) | M06 start offset inside the allowed window |
| `cautionDurU` | 1 | [K_max] | U(0,1) | M06 duration (categorical inverse-CDF) |
| `n1` | 2 | [car][K_max] | N(0,1) | M01 §1.5 grip shock |
| `n2` | 3 | [car][K_max] | N(0,1) | M01 §1.5 wear-rate shock |
| `n3` | 4 | [car][K_max] | N(0,1) | M01 §1.5 burn shock |
| `gaugeN` | 4 | [car][K_max] | N(0,1) | M08 fuel-gauge noise |
| `pitLogN` | 5 | [car][S_max] | N(0,1) | M07 service variability |
| `pitSlowU` | 5 | [car][S_max] | U(0,1) | M07 slow-stop occurrence |
| `pitSlowAddU` | 5 | [car][S_max] | U(0,1) | M07 slow-stop extra time |
| `incidentU`, `incidentPosU`, `incidentRetireU`, `incidentFcyU`, `incidentRepairU` | 6 | [car][K_max] each | U(0,1) | M06 incident occurrence, position in lap, retirement, caution, repair time |
| `failureU`, `failurePosU`, `failureRetireU`, `failureFcyU`, `failureRepairU` | 6 | [car][K_max] each | U(0,1) | M06 mechanical failure, same pattern |
| `punctureU`, `puncturePosU` | 6 | [car][K_max] each | U(0,1) | M04/M06 puncture occurrence and position |
| `trafficU` | 7 | [car][K_max] | U(0,1) | M04 traffic hit |
| `trafficE` | 7 | [car][K_max] | Exp(1) | M04 traffic loss (× mean) |
| `epsN` | 7 | [car][K_max] | N(0,1) | M04 residual lap noise |
| `tyreTempN` | 7 | [car][K_max] | N(0,1) | M04 tyre-temperature noise (separate from `epsN`) |
| `rivalPaceN`, `rivalGripN` | 8 | [car] | N(0,1) | M09 start-of-race jitter |
| `rivalPolicyU` | 8 | [car][8] | U(0,1) | M09 policy-threshold jitter |
| `kBaseN`, `qBaseN`, `heatN` | 9 | [car] | N(0,1) | M04 hierarchical coefficients |
| `familyU` | 11 | [8] | U(0,1) | M13 forced-event timing (e.g. F6 rain onset) |

Rules:
- Arrays are filled in the order of this table, car by car, index by index. The fill order is part of the determinism contract.
- Hazards compare a pre-drawn uniform with a **state-dependent** probability (`event = U < p(state)`), so random numbers stay paired across worlds even when states differ.
- Strategy actions never consume world random numbers.
- A world reading past an array end throws (`PredrawOverflowError`); tests fail on it.

## 1.4 Derived seeds (fixes B15(d))

- Planner futures for a decision: `stream(masterSeed, 10, lap, decisionIndexOnLap, seedSet)` where `seedSet = 0` for the decision and `1..5` for rank-stability reruns.
- Bench run for split seed `s`: the master seed is `s` itself (ranges in `00_PROJECT_RULES.md` R9).
- Fork runs reuse the parent's pre-draws (same master seed); only the forced action differs.

## 1.5 Positive multipliers: exp-OU (default) and GBM (experiment) — `stochastic/ou.ts`

Grip `X`, wear-rate `Y` and fuel-burn `Z` are positive multipliers around 1, per car, updated once per lap. Default model: exponential Ornstein–Uhlenbeck (mean-reverting log). GBM is only for the sensitivity experiment (`multiplierModel = "gbm"`).

Correlated shocks (order X, Y, Z; ρ_XY between grip and wear rate):

```
z_X = n1
z_Y = ρ_XY · n1 + sqrt(1 − ρ_XY²) · n2
z_Z = n3
```

Exact one-lap update for `x = ln(multiplier)`:

```
exp-OU:  x_{k+1} = θ + (x_k − θ)·e^{−κ} + σ·sqrt((1 − e^{−2κ}) / (2κ)) · z_k        θ = 0
GBM:     x_{k+1} = x_k + (μ − σ²/2) + σ·z_k,   μ = σ²/2 (flat median)
half-life = ln 2 / κ            stationary sd of x (exp-OU) = σ / sqrt(2κ)
```

Defaults (`ASSUMED`):

| Multiplier | κ | σ | Half-life | Stationary sd of ln | Clip bounds (±5 sd) |
|---|---|---|---|---|---|
| X (grip) | 0.08 | 0.012 | 8.7 laps | 0.030 | [0.861, 1.162] |
| Y (wear rate) | 0.05 | **0.03** | 13.9 laps | 0.095 | [0.622, 1.607] |
| Z (burn) | 0.10 | 0.015 | 6.9 laps | 0.034 | [0.846, 1.183] |

ρ_XY = −0.40 (`ASSUMED`).

- Clip `x` to ±5 stationary sd and count clips. At the defaults the expected clip rate is about 6×10⁻⁷ per lap; a test asserts 0 clips over 20,000 laps (fixes B01).
- In GBM mode the same bounds apply; report the clip fraction with every GBM result and mark the experiment **invalid** if more than 1% of laps clip.
- Validation of the inputs (`params` schema): κ > 0, σ ≥ 0, |ρ_XY| < 0.99. Invalid values are rejected by the API with a 422 error.
- The persistent per-race coefficient offsets (M04 §4.1) are **separate** from these mean-reverting multipliers; the estimator models both (M11).

## 1.6 Tests

1. Same seed ⇒ the same 10,000 numbers; streams with different ids or indices have |correlation| < 0.02.
2. `predraw` twice with the same seed ⇒ byte-identical arrays (hash compare).
3. Array sizes follow §1.3 for 1 h, 3 h and 6 h races; reading past the end throws.
4. exp-OU: over 20,000 laps, mean of x within ±0.01 of 0, sd within 5% of σ/√(2κ), 0 clips at defaults.
5. GBM: the median of X stays within ±2% of 1 over 100 laps (10,000 paths).
6. Correlation of z_X and z_Y over 50,000 draws within ±0.02 of ρ_XY.
7. Generator-level pairing invariant (replaces v1 test 12): three worlds built from one `predraw` read identical values for every rival on laps 1–5, whatever our car does.
