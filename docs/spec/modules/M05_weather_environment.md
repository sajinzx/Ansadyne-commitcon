# M05 — Weather and environment (the master driver)

| | |
|---|---|
| **Owns** | `packages/engine/src/world/weather.ts`, `world/environment.ts` |
| **Depends on** | M01 (pre-draws), `race.default.json` |
| **Used by** | M02 (grip inputs), M04, M06 (hazard multipliers), M08 (observer), M11, M12 (forecast) |
| **Gate** | 4 |
| **Audit fixes** | B04 (rain probability), B18 (clock-indexed environment), C06 (clock wrap, night), 3.5 (labelled simplification), C13 (rain injection) |

Weather is sampled first; grip, temperatures, hazards and the best compound are all conditional on it. The model is a deliberate simplification (three regimes, one wetness value for the whole track plus optional per-segment offsets) and is labelled `ASSUMED` in the UI.

## 5.1 Clock grid (environment ticks)

The environment advances on a **clock grid**, not on anyone's lap count, so it is identical in all three worlds regardless of who leads:

```
Δ_env = lapRef = 107 s;   tick j covers race time [j·Δ_env, (j+1)·Δ_env)
env(t) = state of tick floor(t / Δ_env)
```

A car's lap uses the environment of the tick containing its **lap start time**. Wetness and track temperature are interpolated linearly between ticks for display.

## 5.2 Regime chain (per tick)

States `dry`, `damp`, `wet`. Default per-tick transition matrix (rows sum to 1; `ASSUMED`, editable):

```
          dry     damp    wet
dry    [ 0.996   0.004   0.000 ]
damp   [ 0.030   0.940   0.030 ]
wet    [ 0.000   0.040   0.960 ]
rainIntensity: dry 0, damp 0.25, wet 1.0
```

Transition at tick j: next regime = inverse CDF of the current row at `weatherU[j]`. Long-run fractions with these defaults: dry 81%, damp 11%, wet 8%.

## 5.3 Wetness, temperatures, rubber, night

```
w_{j+1}  = clip( w_j + 0.12·rain_j − 0.06·(T_trk,j/30)·w_j·(rain_j = 0 ? 1 : 0.3), 0, 1 )
h        = (startClock + t/3600) mod 24                      local clock hour
T_air(h) = 18 + 6·cos(2π·(h − 15)/24)                        January Florida (ILLUSTRATIVE)
sun(h)   = max(0, sin(π·(h − 7)/12))                         daylight 07:00–19:00
η_{j+1}  = 0.9·η_j + 0.5·trackTempN[j]                       mean-reverting noise
T_trk    = T_air + 12·sun(h)·(1 − 0.7·[regime ≠ dry]) − 5·w + η
R_{j+1}  = w_j < 0.1 ? min(0.06, R_j + 0.0004) : R_j·(1 − 0.5·w_j)      rubber builds dry, washes in rain
night    = sun(h) = 0                                       i.e. 19:00–07:00
```

Default start clock 13:40. The clock wraps with `mod 24` for 6 h races.

## 5.4 Rain probability (forecast) — fixes B04

Strategies know the transition matrix and the **current regime**, not the path. Rain probability is the probability of reaching `wet` within n ticks, computed with `wet` made absorbing:

```
A = P with row "wet" replaced by [0, 0, 1]
rainProb.inN = (A^N)[current, wet]           N ∈ {10, 20, 40}
```

Defaults: from `dry` → 0.005 / 0.016 / 0.047; from `damp` → 0.231 / 0.357 / 0.470; from `wet` → 1. The `weather` trigger (M12) uses `in20 ≥ 0.30`, so it fires when the regime turns damp. The UI weather card shows the 20-tick distribution from the current regime (from dry: dry 93.9%, damp 4.8%, wet 1.3%).

## 5.5 Injections

- `INJECT RAIN`: from the next tick the regime is forced to `wet` for 15 ticks (then the chain resumes), identically in all worlds. Logged with its tick.
- Per-segment wetness offsets and debris come from the Track tab (`Apply to running race`) and trigger a surrogate rebuild (M03 §3.4).

## 5.6 Tests

1. Rows of the matrix sum to 1; the simulated long-run fractions over 200,000 ticks are within ±1% of 81/11/8%.
2. `w` stays in [0, 1]; `R` in [0, 0.06]; `h` wraps correctly past midnight.
3. `rainProb` matches the closed-form values above to 1e-3.
4. Environment at a given race time is identical in all three worlds (pairing test with our car leading in one world only).
