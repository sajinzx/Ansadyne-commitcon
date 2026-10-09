# M06 — Race rules, incidents, failures and full-course cautions

| | |
|---|---|
| **Owns** | `packages/shared/config/race.default.json`, `packages/engine/src/world/hazards.ts`, `world/caution.ts` |
| **Depends on** | M01, M03 (τ curve), M04 (wear), M05 (environment) |
| **Used by** | M07, M08, M12 (hazard model in rollouts), M13 |
| **Gate** | 4 |
| **Audit fixes** | A03 (caution start window), A09 (outcome variates pre-drawn), B07 (rejoin rule), B08 (test 9), B05.3 (puncture ≠ DNF), B20 (durations), C07 (night multiplier, zones), 3.3, Finding 9.2–9.4 |

## 6.1 `race.default.json` (create exactly this)

```json
{
  "duration_s": 10800, "durationOptions_h": [1, 3, 6],
  "end": "time_certain",
  "startClock": "13:40",
  "startingFuel_kg": 82, "startingCompound": "dry",
  "rules": {
    "pitClosedFirstCautionLaps": { "value": 2, "provenance": "UNVERIFIED", "note": "IMSA closes the pit lane until the field is collected" },
    "emergencyFuelWhenClosed":   { "value": true, "splash_kg": 6, "provenance": "UNVERIFIED" },
    "serviceMode":               { "value": "sequential", "provenance": "UNVERIFIED", "note": "whether tyres may be changed while refuelling" },
    "minPitService_s":           { "value": 0, "provenance": "UNVERIFIED" },
    "tyreSets":                  { "dryPerHour": 2, "dryBase": 3, "wetPerHour": 1, "wetBase": 2, "provenance": "ILLUSTRATIVE" },
    "noPitOnOutLap":             { "value": true, "provenance": "ASSUMED", "note": "a car must complete one racing lap between stops" }
  },
  "caution": {
    "background_per_lap": 0.004, "wetMultiplier": 3.0, "nightMultiplier": 1.2,
    "durationLaps": { "3": 0.20, "4": 0.30, "5": 0.25, "6": 0.15, "7": 0.10 },
    "minGreenLapsBetween": 5, "paceLapFactor": 1.55, "runToQueueFactor": 1.35, "queueGap_s": 0.9,
    "raceControlDelay_s": 8, "pFcyGivenIncident": 0.7, "pFcyGivenFailure": 0.3,
    "provenance": "UNCALIBRATED"
  },
  "incidents": { "base_per_car_lap": 0.0005, "wetMultiplier": 4.0, "wearMultiplier": 3.0, "nightMultiplier": 1.2,
                 "pRetire": 0.25, "repair_s": [45, 180], "provenance": "UNCALIBRATED" },
  "traffic": { "pPerLap": 0.35, "meanLoss_s": 0.6, "provenance": "ASSUMED" },
  "dirtyAir": { "gapThreshold_s": 1.0, "maxLoss_s": 0.3, "provenance": "ASSUMED" },
  "overtaking": { "holdGap_s": 0.35, "passDelta_s": 0.6, "passCost_s": 0.2, "provenance": "ASSUMED" },
  "residualSigma_s": { "value": 0.15, "provenance": "ASSUMED" }
}
```

Tyre sets available per car: dry = `dryBase + dryPerHour·hours` (3 h ⇒ 9), wet = `wetBase + wetPerHour·hours` (3 h ⇒ 5).

## 6.2 Incidents, failures and punctures (per running car, per lap)

```
p_incident = base · (1 + wetMultiplier·w) · (1 + wearMultiplier·max(0, W − 0.6)) · riskFactor(π) · (night ? nightMultiplier : 1)
p_failure  = failure_per_lap · riskFactor(π)                    (car.gt3.json reliability)
p_puncture = 1 − exp(−h0·exp(h1·W))                             (M04 §4.4)
```

| Event | Occurs if | Where in the lap | Outcome (all pre-drawn) |
|---|---|---|---|
| Incident | `incidentU < p_incident` | `s = 5730·incidentPosU` | retire if `incidentRetireU < pRetire` (DNF `incident`); else repair stop of `45 + 135·incidentRepairU` s at the next pit entry with new tyres. Caution if `incidentFcyU < pFcyGivenIncident` |
| Failure | `failureU < p_failure` | `s = 5730·failurePosU` | retire if `failureRetireU < pRetireOnFailure` (DNF `failure`); else repair of `120 + 180·failureRepairU` s at the next pit entry. Caution if `failureFcyU < pFcyGivenFailure` |
| Puncture | `punctureU < p_puncture` | `s = 5730·puncturePosU` | `limpLoss_s` added to the lap; forced stop with new tyres at the next legal pit entry. **Never a DNF** |

- A retirement ends the car at the event time; it is classified by laps completed (M08).
- A repair stop is a forced pit action with `tyres = current compound` if a set is left (it consumes a set), otherwise the car keeps its worn set; the repair time replaces normal service time if longer (`service = max(service, repair)`).
- Incident-zone levels are **not** used to scale the hazard (they are uncalibrated); `incidentPosU` places the event on the map and the zone name is shown in the audit log when the position falls inside one.

## 6.3 Caution start — window rule (fixes A03)

The engine is lap-synchronous: in step k every running car computes its lap k. A caution start time `t_c` must never fall inside a lap that has **already** been computed.

```
W_lo(k) = max over running cars of lapStart_c(k)        latest start of any car's step-k lap
```

- **Background caution at step k** (decided before any lap of step k is computed): if `cautionU[k] < background·(1 + wetMultiplier·w)·(night ? nightMultiplier : 1)` and at least `minGreenLapsBetween` green steps have passed, then `t_c = W_lo(k) + cautionStartU[k]·lapRef`.
- **Incident- or failure-caused caution** during step k (known only after the step is computed): `t_c = max(t_event + raceControlDelay_s, W_lo(k+1))`, where `W_lo(k+1) = max over running cars of lapEnd_c(k)`. This can delay race control by up to the field spread; it is a stated simplification.
- Because `t_c ≥` every car's current lap start, the lap of each car that contains `t_c` is always **not yet computed**; the partial-lap rule (§6.4) is applied to it when it is computed.
- Only one caution at a time. A new caution-causing event during an active caution does not extend it (simplification). Duration: `durationLaps` sampled by inverse CDF at `cautionDurU[k]`, counted in leader laps.
- Pairing note: background-caution draws are indexed by step k (identical across worlds); `t_c` can differ slightly between worlds because `W_lo` depends on our car. Forced cautions in benchmark families are anchored to the **B1 world** and applied at the same step in all worlds (M13).

## 6.4 Caution behaviour

- **Partial lap**: if `t_c` lies in a car's lap `[t_start, t_start + t_green)`: `f_n = (t_c − t_start)/t_green`; `t_lap = f_n·t_green + (1 − f_n)·t_run`, with `t_run = runToQueueFactor·lapRef`. The caution fraction of that lap is `f_c = 1 − f_n` (used by wear, burn, heat in M04).
- **Queue (pace-car ghost)**: the leader runs at `t_pace = paceLapFactor·lapRef`. Cars behind run at `t_run` until they reach the queue. A car may never cross the line earlier than `t_ahead + queueGap_s`, where "ahead" is the car physically ahead on track.
- **No passing on track** under caution.
- **Pit-lane closure**: for the first `pitClosedFirstCautionLaps` caution laps only emergency fuel splashes are allowed (`splash_kg`, fuel only, no tyres).
- **Rejoin after a stop under caution (fixes B07)**: a car exiting the pits takes its place in the queue by its line-crossing time. The queue rule applies relative to the car physically ahead after pit exit. Cars that passed the pit exit before it stay ahead.
- Caution ends after its sampled laps; the next lap is green for everyone. Wave-arounds are not modelled (lapped cars stay lapped).

## 6.5 Edge cases (fixes Finding 9)

| Situation | Rule |
|---|---|
| `W ≥ Wlimit` while the lane is closed | The car stays out at caution pace (no extra wear model beyond M04), puncture hazard continues, and it is forced into the pits at the first lap the lane opens |
| Puncture during a closed-lane caution | `limpLoss_s` is added to the lap on which it happens (even a caution lap); the forced tyre stop happens at the first open pit entry |
| Puncture on an out-lap (`noPitOnOutLap`) | The car limps for the rest of the out-lap and the next lap becomes a forced in-lap |
| Fuel running out under caution | Caution burn applies; if fuel still runs out the car is a DNF (`fuel`) at `s_dry` (M04 §4.5) |
| Repair and tyre sets | A repair stop consumes a set if one is left (counted in the set-overdraw test) |
| Several forced reasons on one lap | One stop handles them all (fuel helper amount, new tyres, repair time as the service floor) |

## 6.6 Tests

1. Background caution: `t_c ≥ W_lo(k)`; incident caution: `t_c ≥ max lapEnd(k)`. Over 1,000 seeds, **no computed lap ever contains a later-declared `t_c`**.
2. A car 60 s behind the leader when a caution is forced gets the partial-lap formula on the lap containing `t_c`.
3. No passing on track under caution; pit actions are refused while the lane is closed except emergency splashes.
4. **Reworded bunching test (fixes B08)**: after 2 caution laps, every lead-lap car whose gap to the car ahead at `t_c` was ≤ `2·(t_pace − t_run)` (≈ 42.8 s) is within `queueGap + 0.01 s` of the car ahead; every other car has closed its gap by exactly `2·(t_pace − t_run)` (± 0.01 s).
5. Three cars pitting under caution rejoin in the order of their pit-exit times, behind non-pitting cars that passed the exit earlier.
6. A puncture never produces a DNF; a repair stop decrements tyre sets when one is available.
