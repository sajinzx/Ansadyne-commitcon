# M03 — Vehicle model: QSS lap solver, surrogate table, calibration

| | |
|---|---|
| **Owns** | `packages/shared/config/car.gt3.json`, `packages/engine/src/vehicle/qss.ts`, `vehicle/surrogate.ts`, `vehicle/calibrate.ts` |
| **Depends on** | M02 (node grid, grip function) |
| **Used by** | M04 (lap time), M07 (τ curve, stretch time), M10, M11, M12, backend `SurrogateCache` and `/track/preview` |
| **Gate** | 2 |
| **Audit fixes** | A08 (banked friction circle), B11 (surrogate domain), P0-4 (exact grip factorisation), 3.7 (illustrative outputs), Finding 15.1 and 15.6 |

## 3.1 `car.gt3.json` (create exactly this)

All values are **class-level assumptions** for a GT3 car under Balance of Performance. None is Audi, IMSA or manufacturer data. `mu_peak` is calibrated at start-up (§3.5).

```json
{
  "label": "GT3 class-level model (synthetic)",
  "mass_dry_kg":   { "value": 1330, "provenance": "ASSUMED", "note": "car + driver" },
  "power_kW":      { "value": 360,  "provenance": "ASSUMED", "low": 330, "high": 400 },
  "CdA_m2":        { "value": 1.05, "provenance": "ASSUMED", "low": 0.9, "high": 1.2 },
  "ClA_m2":        { "value": 2.6,  "provenance": "ASSUMED", "low": 2.0, "high": 3.2 },
  "Crr":           { "value": 0.015, "provenance": "ASSUMED" },
  "driveGripShare":{ "value": 0.55, "provenance": "ASSUMED", "note": "share of available grip usable for traction (RWD)" },
  "lapRef_s":      { "value": 107.0, "provenance": "ILLUSTRATIVE", "note": "typical GT3 race pace at the Daytona road course; calibration target only" },
  "referenceConditions": { "fuel_kg": 41, "trackTemp_C": 30, "airTemp_C": 22, "wetness": 0, "rubber": 0,
                           "tyreTemp_C": 95, "wear": 0, "mode": "normal", "compound": "dry" },
  "modes": {
    "save":   { "powerFactor": 0.94, "burnFactor": 0.91, "wearFactor": 0.92, "heatFactor": 0.95, "riskFactor": 0.8 },
    "normal": { "powerFactor": 1.00, "burnFactor": 1.00, "wearFactor": 1.00, "heatFactor": 1.00, "riskFactor": 1.0 },
    "push":   { "powerFactor": 1.03, "burnFactor": 1.06, "wearFactor": 1.15, "heatFactor": 1.08, "riskFactor": 1.5 }
  },
  "fuel": { "capacity_kg": 82, "qBase_kg_per_lap": 2.65, "massExponent": 0.3, "cautionBurnFactor": 0.35,
            "gaugeNoise_kg": 0.4, "reserveLaps": 1.0, "provenance": "ASSUMED" },
  "tyres": {
    "dry": { "Topt_C": 95, "Twidth_C": 40, "kBase_per_lap": 0.011, "alphaW": 0.12, "betaW": 1.5, "Wcliff": 0.55, "Wlimit": 0.95 },
    "wet": { "Topt_C": 60, "Twidth_C": 35, "kBase_per_lap": 0.016, "alphaW": 0.14, "betaW": 1.5, "Wcliff": 0.50, "Wlimit": 0.95, "dryWearPenalty": 2.0 },
    "thermal":  { "aHeat_C": 30, "bCool": 0.5, "sigma_C": 1.0, "newTyreOffset_C": 10, "cautionHeatFactor": 0.3,
                  "wearTempCoeff": 0.02, "fTPenalty": 0.08, "fTFloor": 0.90 },
    "puncture": { "h0_per_lap": 1e-5, "h1": 10.0, "limpLoss_s": 25 },
    "provenance": "ASSUMED"
  },
  "reliability": { "failure_per_lap": 0.00015, "pRetireOnFailure": 0.5, "repair_s": [120, 300], "provenance": "UNCALIBRATED" },
  "pit": { "refuelRate_kg_s": 2.0, "tyreChange4_s": 16, "driverChange_s": 9,
           "serviceLogSigma": 0.09, "slowStopProb": 0.03, "slowStopAdd_s": [3, 12], "provenance": "ASSUMED" }
}
```

(The service mode — sequential or parallel — is a race rule and lives in `race.default.json`, M06.)

## 3.2 Quasi-steady-state lap solver (`qss.ts`)

Inputs: node grid (M02 §2.3), per-node friction `μ_i`, total mass `m`, power `P = power_kW·1000·powerFactor`, air density `ρ`. Outputs: lap time, three sector times, speed profile `v_i`, per-node times `dt_i`, cumulative time `t_i`.

Constants: `g = 9.81 m/s²`; `ρ = 101325 / (287.05·(T_air + 273.15))`; numeric ceiling `v_top = 120 m/s`.

**Conventions (state them in code comments).** Bank angle θ tilts the road toward the corner centre. Downforce `F_L = ½ρ·ClA·v²` acts **perpendicular to the road surface** and adds to normal load. Lateral quantities are measured **along the road surface**. On straights `1/r = 0`.

**Step 1 — cornering speed cap** (lateral balance in the banked frame):

```
m·v²/r·(cosθ − μ sinθ) = m·g·(sinθ + μ cosθ) + μ·½ρ·ClA·v²
v_cap² = m·g·(sinθ + μ cosθ) / ( m·(cosθ − μ sinθ)/r − μ·½ρ·ClA )
if 1/r = 0 or the denominator ≤ 0: v_cap = v_top   (corner not grip-limited)
v_cap = min(v_cap, v_top)
```

**Step 2 — available longitudinal grip at speed v (banked-frame friction circle; fixes A08)**:

```
N(v)/m    = g·cosθ + (v²/r)·sinθ + ½ρ·ClA·v²/m      normal load per unit mass
a_lat(v)  = max(0, (v²/r)·cosθ − g·sinθ)             outward lateral demand along the surface (below the
                                                     neutral speed the driver is assumed to take a lower line)
a_tot(v)  = μ·N(v)/m
a_long(v) = sqrt( max(0, a_tot² − a_lat²) )
```

This is the same balance as Step 1: `a_long = 0` exactly at `v = v_cap`, so the two steps can never disagree. (v1 used the flat-road circle here, which gave zero grip on wet banking.)

**Step 3 — forward pass (acceleration)** from node `i` to `i+1`, using the speed at node `i`:

```
F_drag = ½ρ·CdA·v²;   F_roll = Crr·(m·g + ½ρ·ClA·v²)
a      = min( P/(m·max(v, 5)),  driveGripShare·a_long(v) ) − (F_drag + F_roll)/m
v_{i+1} = min( v_cap_{i+1}, sqrt(max(0, v_i² + 2·a·ds)) )
```

**Step 4 — backward pass (braking)** from node `i+1` to `i`, using the speed and geometry at node `i+1`:

```
a_brake = a_long(v_{i+1}) + (F_drag + F_roll)/m
v_i     = min( v_i, sqrt(v_{i+1}² + 2·a_brake·ds) )
```

Closed loop: run the forward pass over two consecutive laps starting at `v_cap_0`, then the backward pass over the same two laps, and keep the second lap. A numeric floor `v_min = 3 m/s` keeps the car moving on near-zero grip, so lap times stay finite.

**Step 5 — times**: `dt_i = 2·ds/(v_i + v_{i+1})`, lap time `T = Σ dt_i`, sector times by summing inside sector bounds, cumulative `t_i`, normalised curve `τ(s) = t(s)/T`.

Performance: one solve ≈ 4 × 2,865 node updates; preallocate `Float64Array` buffers per solver instance.

## 3.3 Grip factorisation used by the solver

```
μ_i = μ_peak · S_car · S_track · node_{j(i)}(w, overrides)
```

`S_track` and `node_j` come from M02 §2.4; `S_car` (compound, tyre temperature, wear, grip multiplier, driver skill) comes from M04 §4.2. The product `S = S_car·S_track` is the **uniform scale** stored as an axis of the surrogate.

## 3.4 Surrogate table (`surrogate.ts`)

A QSS solve per car per lap per Monte Carlo path is too slow, so the engine **and** the planner both use the same precomputed table — one physics model for both.

Axes:

| Axis | Values |
|---|---|
| `S_eff = S · e(w)` (effective uniform scale; public domain of `S` is 0.35–1.25) | 0.12 to 1.25, step 0.025 (46 values) |
| `m` (kg) | `mass_dry + capacity·i/6`, i = 0..6 (**7 points**) |
| `w` (global wetness; node part uses `w_j = clip(w + offset_j)`) | 0 to 1, step 0.1 (11 values) |
| `mode` | save, normal, push (through `powerFactor`) |

`e(w)` = length-weighted mean node factor at wetness `w` divided by the dry mean. Wetness lowers every segment's grip by nearly the same factor, so lap time depends mainly on `S_eff`; storing the table on `(S_eff, m, w)` and querying at the exact `S_eff` leaves only a small residual to interpolate across `w`. (A plain `(S, m, w)` table had multi-second errors on wet laps.) Total 46 × 7 × 11 × 3 = 10,626 solves per surface layout (≈ 2 s). Each cell stores lap time and the three sector fractions. Query: trilinear interpolation over (S, m, w) inside the mode table. Air-density correction: `T ← T·(ρ/ρ_ref)^0.15` (`ASSUMED`, small).

- **Domain**: if a query falls outside the axes, clamp to the edge, increment `surrogateOutOfRange`, and log a warning event once per run. In tests an out-of-range query throws.
- **Rebuild trigger**: a change in any per-segment override (wetness offset, debris), or in car parameters. Global `T_trk`, `R`, tyre and multiplier state only move `S` and need no rebuild.
- **Cache**: the backend `SurrogateCache` keys tables by `hash(trackConfig, overrides, carConfig, mu_peak)` and shares them across runs and workers (tables are plain `Float64Array`s, transferable).
- Also stored from the reference solve: speed profile `v_i`, cumulative times `t_i`, `τ(s)`, and `t_stretch_ref` (track time from 5,613 m through 0 to 884 m).

## 3.5 Start-up calibration of `mu_peak` (`calibrate.ts`)

Bisection on `mu_peak ∈ [0.8, 2.6]` (40 iterations) so that the QSS lap at `referenceConditions` (fresh dry tyres at Topt so `f_T = 1`, `f_W = 1`, `X = 1`, fuel 41 kg, dry, `T_trk = 30 °C` so `S_track = 0.9722`, normal mode) equals `lapRef_s = 107.0 s` within ±0.01 s. If the target is unreachable inside the μ range, hold μ at the bound and bisect `power_kW` within ±15%; log both as calibrated values.

**Emergent diagnostics** (shown in the Assumptions tab and Track tab as illustrative model outputs, not calibrated results):
- fuel-mass sensitivity `c_f = ∂T/∂m` by central difference at ±5 kg;
- top speed and its location; minimum speeds at the West Horseshoe (S04) and Bus Stop (S08);
- grip sensitivity `∂T/∂S` at reference;
- `τ(5613)`, `τ(884)`, `t_stretch_ref`.

**Reference values from a prototype of exactly this solver and data** (v2, banked-frame Step 2). Use them to check the implementation; small differences from discretisation are fine:

| Quantity | Value |
|---|---|
| `mu_peak` | ≈ 1.385 |
| Reference lap | 107.0 s; sectors ≈ 29.3 / 46.9 / 30.8 s |
| Top speed | ≈ 289 km/h at the end of the front stretch (entering S02) |
| S10–S11 | flat out, ≈ 229–283 km/h, no braking |
| West Horseshoe (S04) minimum | ≈ 90 km/h |
| Bus Stop (S08) minimum | ≈ 68 km/h |
| `c_f` | ≈ 0.010 s/kg (lower than the common ≈ 0.03 rule of thumb because this lap is mostly grip- and drag-limited; report as an uncalibrated emergent value, do not tune it) |
| `∂T/∂S` | ≈ −25 s per unit S (≈ 1 s per 4% grip) |
| `τ(5613)`, `τ(884)`, `t_stretch_ref` | ≈ 0.986, ≈ 0.104, ≈ 12.6 s |
| Wet check (all segments w = 1) | lap ≈ 160 s at S = 0.6 and ≈ 187 s at S = 0.45 — finite and monotone |

Soft sanity ranges (console warning only): `c_f ∈ [0.005, 0.06]` s/kg; top speed 250–310 km/h; Bus Stop minimum 55–130 km/h.

## 3.6 Tests

1. Calibrated reference lap = 107.00 ± 0.01 s; `mu_peak` ∈ [1.33, 1.44].
2. More mass ⇒ slower; more grip ⇒ faster; `v_i ≤ v_cap_i` at every node; no braking on S10–S11 at reference; top speed occurs at the end of S01 / start of S02.
3. Property: for every node and `v ≤ v_cap`, `a_long(v) ≥ 0`, and `a_long → 0` as `v → v_cap` (within 1e-6 relative).
4. Wet banking: with all segments at w = 1 and S ∈ [0.35, 1.0], lap times are finite and decrease monotonically as S increases.
5. Surrogate vs direct QSS on 200 random points inside the domain, with and without overrides: ≤ 0.05 s on dry points (S ≥ 0.7); ≤ 0.5% relative everywhere, including wet points (wet laps run 150–260 s, so an absolute 0.05 s bound is not meaningful there).
6. Factorisation: for random (w, T, R, overrides, S_car), the solver's `μ_i/μ_peak` equals `S_car·grip_j` from M02 to 1e-12.
7. Out-of-range surrogate query throws in test mode; in production mode it clamps and increments the counter.
