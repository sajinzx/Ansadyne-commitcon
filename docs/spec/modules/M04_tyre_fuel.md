# M04 — Grip, tyres, fuel and the green-flag lap time

| | |
|---|---|
| **Owns** | `packages/engine/src/vehicle/tyre.ts`, `vehicle/fuel.ts`, `vehicle/laptime.ts`, `vehicle/coefficients.ts` |
| **Depends on** | M01 (multipliers, pre-draws), M02 (grip), M03 (surrogate, τ curve) |
| **Used by** | M07, M08, M10, M11, M12 |
| **Gate** | 2 (deterministic), 4 (stochastic terms) |
| **Audit fixes** | A02 (fuel within the lap), A07 (persistent coefficients defined here, estimated in M11), Finding 8 (tyre-temp noise stream), C09 (wet-skill blend), C12 (compound-specific kBase), 3.6 |

Notation per car `c`, lap `k`: compound `τ ∈ {dry, wet}`, wear `W ∈ [0, 1]`, tyre temperature `T_tyre` (°C), fuel `F` (kg), mode `π`, multipliers `X, Y, Z` (M01 §1.5), wetness `w`, track temperature `T_trk`, rubber `R`, caution fraction of the lap `f_c ∈ [0, 1]` (M06).

## 4.1 Persistent per-race coefficients (hierarchical draw)

Once per race and car (stream 9):

```
b_Y,c = 0.10 · kBaseN[c]          true wear-rate offset   (multiplier e^{b_Y})
b_Z,c = 0.03 · qBaseN[c]          true burn offset        (multiplier e^{b_Z})
heat_c = exp(0.08 · heatN[c])     tyre-heating coefficient
```

These are constant through the race and **hidden**. The effective multipliers are `Y_eff = e^{b_Y}·Y` and `Z_eff = e^{b_Z}·Z`. Family F9 multiplies the 0.10 and 0.03 spreads by 3. The estimator models `b_Y` and `b_Z` explicitly (M11).

## 4.2 Car-side grip scale

```
S_car = μ_compound(τ, w) · wetSkillFactor_c(w) · f_T(T_tyre) · f_W(W) · X · gripSkill_c

μ_compound(dry, w) = 1 − 0.45·w^1.5               slick loses grip as the track gets wet
μ_compound(wet, w) = 0.86 + 0.14·min(1, w/0.35)   wet tyre slow on a dry track
   crossover at w ≈ 0.228 (both ASSUMED)

wetSkillFactor_c(w) = 1 + (wetSkill_c − 1)·clip((w − 0.1)/0.2, 0, 1)      smooth (no step at w = 0.2)
f_T(T)  = max(fTFloor, 1 − fTPenalty·((T − Topt_τ)/Twidth_τ)²)             bounded temperature window
f_W(W)  = max(0.5, 1 − alphaW_τ·W − betaW_τ·max(0, W − Wcliff_τ)²)        gradual loss, then a cliff
```

`S = S_car · S_track` (M02 §2.4) is the surrogate's uniform-scale input. Wear percentage is never treated as grip loss directly; grip loss is only what `f_W` gives. Design intent: a 30-lap dry stint reaches W ≈ 0.33, costing ≈ 4% grip (≈ 1 s/lap at stint end), so new tyres (+16 s service) versus double-stinting is a real trade-off.

## 4.3 Tyre temperature (thermal difference equation)

```
Heat_k   = heatFactor(π) · (m_mid / m_ref) · heat_c · [(1 − f_c) + f_c·cautionHeatFactor]
T_{k+1}  = T_k + aHeat·Heat_k − bCool·(T_k − T_trk,k) + sigma_C·tyreTempN[c][k]
new tyres: T = T_air + newTyreOffset        (no tyre warmers)
m_ref = mass_dry + 41
```

The lap uses the start-of-lap temperature `T_k` in `f_T`. Equilibrium ≈ `T_trk + 60 °C`. Cold new tyres slow the out-lap automatically. `tyreTempN` is its own pre-drawn array (not `epsN`), so thermal noise is independent of the lap-time residual the estimator sees.

## 4.4 Tyre wear and puncture

```
k_t = kBase_τ · e^{b_Y,c} · wearMult_c · (m_mid/m_ref) · (1 + wearTempCoeff·max(0, T_k − Topt_τ))
      · wearFactor(π) · [(1 − f_c) + 0.25·f_c] · (τ = wet ? 1 + dryWearPenalty·(1 − w)² : 1) · Y_k
```

`kBase_τ` is compound-specific (dry 0.011, wet 0.016 per lap). Wear accumulates in proportion to **track distance driven on that set**: a lap fully on one set adds `k_t`; on an in-lap the old set gets `k_t·(5613/5730)`; on an out-lap the new set gets `k_t·(1 − 884/5730)`. `W` is monotone between changes and reset to 0 by a tyre change.

Puncture hazard: `p_punct = 1 − exp(−h0·exp(h1·W))` per lap; event if `punctureU[c][k] < p_punct`, at lap position `s_p = 5730·puncturePosU[c][k]`. Effect (M06/M07): `limpLoss_s` added to the lap, and a forced stop with new tyres. **A puncture is not a DNF.**

`W ≥ Wlimit` (0.95) forces a stop at the next legal pit entry (M07 §7.6 for the closed-lane case).

## 4.5 Fuel and mass

```
q_k = qBase · e^{b_Z,c} · burnMult_c · burnFactor(π) · (m_start/m_ref)^massExponent
      · [(1 − f_c) + f_c·cautionBurnFactor] · Z_k                          burn for a full lap (kg)
```

- Fuel is burned **in proportion to track distance**: at lap distance `s`, `F(s) = F_k − q_k·s/5730`. Pit-lane travel burns nothing (stated simplification).
- **Fuel exhaustion inside a lap**: if `F_k < q_k` on a lap with no pit entry before the car would run dry, the car stops at `s_dry = 5730·F_k/q_k`. It is a DNF (`fuel`) at race time `t_lapStart + t_lap·τ(s_dry)`. Fuel is never clamped to hide this. (The box-arrival case is in M07 §7.4.)
- Mass: `m(s) = mass_dry + F(s)`. The lap solver uses `m_mid = mass_dry + F_k − q_k/2` (or the mid-mass of the on-track part for in/out-laps).
- Observed fuel gauge (our car): `F_obs = F_true(at the line) + gaugeNoise·gaugeN[c][k]`.

The fuel-mass effect on lap time is **not** a separate constant; it emerges from `m` in the solver.

## 4.6 Green-flag lap time (one car, one full racing lap)

```
t_green = Surrogate(S, m_mid, w, π)·(ρ/ρ_ref)^0.15·paceFactor_c + Δ_traffic + Δ_dirty + ε
Δ_traffic = (trafficU[c][k] < 0.35) ? 0.6·trafficE[c][k] : 0       mean 0.21 s, variance 0.208 s²
Δ_dirty   = gapAhead < 1.0 s ? 0.3·(1 − gapAhead) : 0                 gap at the line at lap start
ε         = 0.15·epsN[c][k]
```

All constants `ASSUMED` (`race.default.json`, M06). The traffic term represents being passed by faster classes (GTP, LMP2), which are not simulated as cars.

**Overtaking and holding (green running)**: process cars in running order. If car B was behind car A at the start of the lap and B's computed line-crossing time is earlier than `t_A + 0.35 s`, B passes only if its lap is at least 0.6 s faster than A's, and then crosses at its own time + 0.2 s. Otherwise B is held at `t_A + 0.35 s`. Caution laps use the queue rules in M06.

## 4.7 Tests

1. `f_W ≤ 1`, monotone non-increasing in W; `f_T ≤ 1` with maximum at Topt; wet/slick crossover at w ≈ 0.228.
2. Wear is monotone between changes and resets to 0 on a change; in/out-lap wear is split by distance as specified.
3. Puncture probability increases with W; a puncture never produces a DNF.
4. Fuel never increases without a refuel; with `F_k = 2 kg`, `q = 2.65 kg` and no pit, the car stops at `s ≈ 4,325 m` with DNF(fuel).
5. Caution burn for a full caution lap = 35% of the green burn.
6. Cold new tyres give a slower first lap than the third lap on the same set (deterministic, no noise).
7. `tyreTempN` and `epsN` are different arrays (pre-draw manifest check).
