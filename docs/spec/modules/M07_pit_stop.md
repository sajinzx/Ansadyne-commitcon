# M07 — Pit stop: one route model, one state machine

| | |
|---|---|
| **Owns** | `packages/engine/src/sim/pit.ts` (pure timing and fuel functions), pit section of `sim/step.ts` |
| **Depends on** | M02 (pit lane), M03 (τ curve), M04 (fuel, wear), M06 (closure, emergency rules) |
| **Used by** | M08, M10, M12 (timing functions only), frontend animation |
| **Gate** | 2 |
| **Audit fixes** | P0-1 / A01 (route model, out-lap charge), P0-2 / Finding 2 (state machine, single application), A02 (fuel at the box), B16 (puncture flow, engine vs planner legality), Finding 7 (pit-lane note), Finding 9.4 |

v1 split lane time with a track-distance ratio (117/1001) and never charged the out-lap. v2 defines a single route in which every leg has its own distance and speed, and a state machine in which every state change happens exactly once.

## 7.1 Route model

Track distances use lap distance `s`; lane distances use lane distance `u` (M02 §2.2–2.3). The timing line crosses the lane at `u_line = 47 m`.

| Leg | From → to | Distance | Time |
|---|---|---|---|
| T1 (track, in-lap) | `s = 0` → `s = 5613` | track | `t_lap,k · τ(5613)` |
| E | pit entry deceleration | — | `entryLoss = 2.0 s` |
| L1 (lane) | `u = 0` → `u = 47` (timing line) | 47 m | `47 / v_pit = 2.82 s` |
| **lap k ends at the timing line; lap k+1 (out-lap) begins** | | | |
| L2 (lane) | `u = 47` → `u = 200` (box) | 153 m | `153 / v_pit = 9.18 s` |
| S | service in the box | — | `service` (§7.5) |
| L3 (lane) | `u = 200` → `u = 400` (exit) | 200 m | `200 / v_pit = 12.00 s` |
| X | exit acceleration and merge | — | `exitLoss = 2.5 s` |
| T2 (track, out-lap) | `s = 884` → `s = 5730` | track | `t_lap,k+1 · (1 − τ(884))` |

`v_pit = 60 km/h = 16.67 m/s` (assumed to apply under green and caution). `t_lap,k` is the lap time the car would have had for a full lap under lap k's conditions (green `t_green` from M04 §4.6, or the caution lap time from M06 §6.4); `τ` is the normalised cumulative-time curve of the reference lap (M03). The track stretch `5613 → 884` (1,001 m) is skipped.

```
in-lap   = t_lap,k·τ(5613) + entryLoss + u_line/v_pit
out-lap  = (u_box − u_line)/v_pit + service + (laneLength − u_box)/v_pit + exitLoss + t_lap,k+1·(1 − τ(884))
total_pit = entryLoss + laneLength/v_pit + service + exitLoss                 (= 84.5 s for a full sequential stop)
t_stretch = t_lap·(1 − τ(5613)) + t_lap·τ(884)          green ≈ 12.6 s;  caution ≈ t_pace·1001/5730 ≈ 29.0 s
net_loss  = total_pit − t_stretch                          green ≈ 71.9 s;  caution ≈ 55.5 s (a caution saves ≈ 16 s)
identity (equal laps): in-lap + out-lap = 2·t_lap − t_stretch + total_pit
```

The 1,129 m schematic lane would give 67.7 s of transit and a ≈ 128 s full stop; that is why the 400 m override is used (M02).

## 7.2 Pit state machine (per car)

```
ON_TRACK ──(decision for lap k = PIT)──▶ ON_TRACK(pit pending)
    │ reach s = 5613 on lap k: engineLegal? ── no ──▶ stay out, log "pit refused: <reason>", keep forced reasons pending
    ▼ yes
PIT_ENTRY      t_entry  : charge entryLoss; compute F_box; DNF(fuel) if F_box < 0; stop index j += 1
    ▼
LANE_TO_LINE   t_line   : cross the timing line inside the lane → close lap k record (in-lap); start lap k+1 (out-lap)
    ▼
LANE_TO_BOX    t_box    : arrive at the box
    ▼
SERVICE        [t_box, t_box + service] : apply refuel (clamped), tyres, driver change, repair — exactly once, at t_box
    ▼
LANE_TO_EXIT   t_exit   : charge exitLoss at merge
    ▼
ON_TRACK       from s = 884 on lap k+1 (out-lap); next pit allowed from lap k+2 (noPitOnOutLap)
```

Three points per stop, each used once:
- **Decision point**: the line crossing at the end of lap k−1. The strategy sees `Observation(k−1)` and returns `Action` for lap k. `plannerLegal(obs, belief, action)` (advisory, inside strategies) filters candidates.
- **Execution point**: pit entry on lap k (`s = 5613`). `engineLegal(truth, action)` is authoritative: lane open (M06), tyre set available, not an out-lap, refuel ≥ 0. An illegal pit becomes "stay out" with a logged reason; strategies re-decide next lap. Forced reasons (fuel emergency, `W ≥ Wlimit`, puncture, repair) stay pending until the first legal entry.
- **State-update point**: box arrival on lap k+1. Fuel, tyres, wear, tyre temperature, sets and driver change update here and nowhere else.

## 7.3 Lap records

A stop touches two lap records:
- **In-lap** (lap k): `pit = { phase: "in", t_entry, t_line }`; lap time = in-lap formula.
- **Out-lap** (lap k+1): `pit = { phase: "out", t_box, service_s, t_exit, refuelApplied_kg, tyres }`; lap time = out-lap formula.

Consecutive stops are impossible (`noPitOnOutLap`), so a record is never both. The frontend animates the car along T1, the lane (using `u`), and T2 from these timestamps.

## 7.4 Fuel at the box (fixes A02)

```
F_box            = F_k − q_k·(5613/5730)                        fuel on arrival at pit entry (the lane burns nothing)
F_box < 0        ⇒ the car ran dry before the pit entry: DNF(fuel) at s_dry = 5730·F_k/q_k
refuel_applied   = clip(refuel_requested, 0, capacity − F_box)  engine clamps with truth; log requested − applied
F after service  = F_box + refuel_applied
out-lap burn     = q_{k+1}·(1 − 884/5730)
```

Strategies request fuel with the **refuel helper**, using estimates only:

```
F̂_box          = F̂ − q̂·(5613/5730)
lapsLeftEst    = ceil((duration_s − t̂_box) / t̂_lap) + 1
refuel_request = clip(q̂·(lapsLeftEst + reserveLaps) − F̂_box, 0, capacity − F̂_box)
```

Emergency splash while the lane is closed: allowed only if `F̂_box < 2·q̂`; amount `splash_kg = 6`, fuel only.

## 7.5 Service time

```
t_fuel   = refuel_applied / refuelRate                (2.0 kg/s)
t_tyres  = tyres ≠ "none" ? 16 : 0
t_driver = driverChange ? 9 : 0
base     = sequential: max(t_fuel, t_driver) + t_tyres
           parallel:   max(t_fuel, t_tyres, t_driver)                 (rule serviceMode, UNVERIFIED)
base     = max(base, minPitService_s)
service  = max( base·exp(0.09·pitLogN[c][j]) + (pitSlowU[c][j] < 0.03 ? 3 + 9·pitSlowAddU[c][j] : 0),  repair_s )
```

`j` is the car's stop index (arrays sized from `K_max`, M01). `repair_s` is 0 unless a repair is pending (M06).

## 7.6 Forced stops and pending reasons

| Reason | Created when | Action at the next legal entry |
|---|---|---|
| Fuel emergency | `F̂_box` for the next lap < `reserveLaps·q̂` (engine-side check uses truth for the forced case) | refuel by helper |
| Wear limit | `W ≥ Wlimit` | new tyres + helper fuel |
| Puncture | M04 §4.4 | new tyres + helper fuel; `limpLoss_s` already charged |
| Repair | M06 §6.2 | new tyres if a set is left; service ≥ repair time |

A forced stop overrides a strategy's "stay out" and is logged as `forced`.

## 7.7 Tests

1. Default full sequential stop (80 kg + 4 tyres): `total_pit = 2 + 24 + (40 + 16) + 2.5 = 84.5 s` before variability.
2. **Lap accounting**: for a green stop with equal `t_lap`, `in-lap + out-lap − 2·t_lap = total_pit − t_stretch` to 1e-9.
3. Every stop applies refuel, tyres and set decrement exactly once (event-count test over 1,000 seeds).
4. `F_k = 2 kg`, `q = 2.65 kg`, pit requested ⇒ DNF(fuel) before pit entry. A full fill leaves the box at exactly `capacity`. Requested-minus-applied clamps are counted separately from overfills (which must be 0).
5. A pit decided on lap k while a caution closing the lane starts during lap k is refused at the entry and logged.
6. A pit action on an out-lap is refused; a puncture on an out-lap becomes a forced in-lap on the next lap.
