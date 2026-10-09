# M08 — Race engine: paired worlds, the lap procedure, observer, classification

| | |
|---|---|
| **Owns** | `packages/engine/src/sim/world.ts` (truth types), `sim/step.ts`, `sim/race.ts`, `sim/observer.ts`, `sim/observerTypes.ts`, `sim/classify.ts`, `sim/snapshots.ts` |
| **Depends on** | M01–M07, M09 (rival policies), M10/M12 (ego strategies, called through the `Strategy` interface), M11 |
| **Used by** | backend race worker, M13 bench runner |
| **Gate** | 2 (single car, deterministic), 3 (multi-car), 4 (stochastic) |
| **Audit fixes** | A01/A02 (procedure), A05 (truth boundary), B03 (rubber observable), B14 (estimator in every world), B16, B21 (race end), C13 (injections, snapshots), Finding 2 |

## 8.1 Three paired worlds

A race holds three worlds — `B0`, `B1`, `OPT` — one per strategy for our car (#12). All contain the same ten cars, the same rival parameters and policies, and read the same pre-draws (M01). The worlds advance in **lockstep**: step k is computed for all three worlds before step k+1. Injected events apply at the same step in all worlds.

## 8.2 Truth state (`sim/world.ts`, never imported by `strategy/**` or `planner/**`)

```ts
interface CarTruth {
  no: number; running: boolean; classified: boolean;
  dnf?: { cause: "fuel" | "incident" | "failure"; atTime_s: number; atLapDist_m: number };
  lap: number; lapStart_s: number; lastLapTime_s: number;
  fuel_kg: number; compound: "dry" | "wet"; wear: number; tyreTemp_C: number; tyreAgeLaps: number;
  lnX: number; lnY: number; lnZ: number;                 // mean-reverting multipliers (M01)
  coeff: { bY: number; bZ: number; heat: number };     // persistent hidden coefficients (M04)
  mode: "save" | "normal" | "push";
  setsLeft: { dry: number; wet: number }; stopIndex: number;
  pendingOutLap: null | { service_s: number; refuelApplied_kg: number; tyres: "none" | "dry" | "wet"; driverChange: boolean; t_box: number };
  forced: Array<"fuel" | "wearLimit" | "puncture" | "repair">; repair_s: number;
  stints: Stint[]; lapsSinceStop: number;
}
interface WorldTruth {
  id: "B0" | "B1" | "OPT"; step: number;
  env: EnvState;                      // from the clock grid (M05)
  overrides: SegmentOverride[];       // per-segment wetness offsets, debris
  caution: CautionState;              // active, t_c, lapsLeft, lapsElapsed, pitOpen
  pendingCautionStart_s: number | null;
  cars: CarTruth[];
  finish: { T_finish_s: number | null };
}
```

## 8.3 The lap procedure for step k (`sim/step.ts`)

```
for each world W (in the order B0, B1, OPT):
  1. Decisions (before any lap of step k is computed):
     - our car: action_k = strategy_W.decide(obs_{k−1}, history, belief_W)          (B0, B1 or OPT; OPT may call the planner)
     - rivals:  action_k = rivalPolicy_c.decide(obs_{k−1}^c)                      (M09)
     - plannerLegal is applied inside strategies; forced reasons override "stay out"
  2. Caution: apply injected/background caution for step k with the window rule (M06 §6.3);
     include any pendingCautionStart_s from step k−1 incidents.
  3. For each running car c, in running order at the start of the step:
     3.1 env ← environment at the tick of lapStart_c (M05)
     3.2 update lnX, lnY, lnZ from n1, n2, n3[c][k] (M01 §1.5)
     3.3 base lap: compute t_lap,k for a full lap under lap-k conditions
            green: t_green (M04 §4.6) with the car's state at the lap start
            if pendingOutLap: the T2 portion uses the post-service state (new tyres at T_air + 10 °C, fuel after service)
     3.4 caution adjustments for the lap containing t_c (partial lap, queue; M06 §6.4) → caution fraction f_c
     3.5 hazards from pre-draws (M06 §6.2): incident / failure / puncture at their lap positions
            retirement → truncate the lap at the event, mark DNF, skip to 3.9
            puncture   → add limpLoss_s, push forced "puncture"
            repair     → push forced "repair", set repair_s
     3.6 pit: if (action_k.pit or forced non-empty) and the car reaches s = 5613:
            engineLegal(truth, action) at t_entry (M07 §7.2)
              legal   → in-lap timing; F_box; DNF(fuel) if F_box < 0; set pendingOutLap for lap k+1
              illegal → stay out; log "pit refused: <reason>"
     3.7 lap time:
            out-lap (pendingOutLap set at step k−1) → out-lap formula (M07 §7.1); apply service at t_box; clear pendingOutLap
            in-lap                                  → in-lap formula
            otherwise                               → t_lap,k with caution adjustments
            green holding/overtaking or caution queue rule (M04 §4.6, M06 §6.4)
     3.8 fuel, wear and tyre temperature by distance portions (M04); mid-lap fuel exhaustion → DNF(fuel) at s_dry
     3.9 lapEnd = lapStart + t_lap; lap += 1; record CarLapRecord
  4. Incident/failure cautions from this step → pendingCautionStart_s = max(t_event + delay, max lapEnd) (M06 §6.3)
  5. Positions and gaps: order by laps completed (desc), then line-crossing time (asc)
  6. Observations obs_k for every car (§8.4); our car's estimator update in this world (M11)
  7. Race end check (§8.5); emit LapEvent(W, k)
```

A lap can never be both an in-lap and an out-lap (`noPitOnOutLap`).

## 8.4 Observer (`sim/observer.ts`) — what strategies may see

```ts
interface Observation {
  step: number; lap: number; raceTime_s: number; remaining_s: number; clock: string;
  flag: "green" | "caution"; pitOpen: boolean; cautionLapsElapsed: number;
  regime: "dry" | "damp" | "wet";
  wetness_est: number;               // clip(w + 0.03·wetObsN[k], 0, 1)
  trackTemp_C: number; airTemp_C: number;
  rubber_est: number;                // R from the track-evolution model (deterministic given observed weather; B03)
  rainProb: { in10: number; in20: number; in40: number };            // M05 §5.4
  overrides: SegmentOverride[];      // debris/wet patches announced by race control
  ego: { lastLap_s: number; sectorTimes_s: [number, number, number]; fuelGauge_kg: number;
         compound: "dry" | "wet"; tyreAgeLaps: number; tyreTemp_C: number; mode: string;
         stops: number; position: number; gapAhead_s: number; gapBehind_s: number;
         setsLeft: { dry: number; wet: number }; lastRefuelApplied_kg: number | null;   // delivered fuel is measured by the rig
         lastLapFlags: { inLap: boolean; outLap: boolean; caution: boolean; incident: boolean } };
  rivals: { no: number; position: number; laps: number; gap_s: number; lastLap_s: number;
            tyreAgeSinceSeenStop: number; stops: number; inPit: boolean; running: boolean }[];
}
interface ObsHistory { last: Observation[] }   // last 10 observations, oldest first
```

Hidden from strategies: wear `W`, multipliers, true fuel, persistent coefficients, the weather path, future events, rival fuel, wear and policies. Tyre temperature is observed (TPMS-style). The fuel gauge is noisy.

**Estimator in every world (B14)**: the M11 estimator reads only `Observation`, so it runs for our car in all three worlds. Each world's belief feeds that world's Fuel & Tyres panel and its scoreboard projection. Only OPT uses it for decisions.

## 8.5 Race end and classification (fixes B21)

- `T_finish` = race time of the leader's first line crossing with `raceTime ≥ duration_s`.
- Each car is classified at its **first line crossing at or after `T_finish`**. Laps credited = its line crossings up to and including that one. A car that is a lap or more down is classified with fewer laps automatically.
- Laps that start after `T_finish` are **voided**: no fuel, wear, hazard or DNF effects. The engine runs at most one more step after `T_finish` is known.
- Order: finishers by laps credited (desc), then crossing time (asc); then DNFs by laps completed (desc), then retirement time (desc). Display "+n LAP" for cars down on laps.

## 8.6 Snapshots, injections, forks

- Snapshot every world at every step into a ring buffer of 200 steps (state is small). Forks (backend) copy a snapshot, force a different action for our car, and run headless to the end with the same pre-draws.
- Injections are queued and applied at the first uncomputed step, in all worlds:

| Kind | Effect |
|---|---|
| `caution` | forces a background caution at that step (start offset from `cautionStartU[k]`) |
| `rain` | M05 §5.5 |
| `fuelSpike` | our car's burn × 1.15 for 5 laps in every world (exogenous fault) |
| `debris` | debris flag on a segment for 10 ticks; surrogate rebuild (M03) |

Each injection is recorded `{ kind, step, params }`; replaying the list reproduces the run (R2).

## 8.7 Tests

1. Determinism: same config, seed and injections ⇒ identical `LapEvent` stream hash (50 seeds, B1 in all three slots; plus 5 seeds with full OPT).
2. Pairing: environment and every rival pre-draw used on steps 1–5 are identical in the three worlds; the environment at a given race time is identical even when our car leads in only one world.
3. Legality (`pnpm test:slow`): over 1,000 seeds × 3 worlds (B1 in the OPT slot): 0 illegal actions accepted, 0 fuel overfills, 0 tyre-set overdraws.
4. Race end: a car 1.4 laps behind at `T_finish` is classified one lap down; no lap starting after `T_finish` changes fuel or produces a DNF.
5. Integrity (truth perturbation): run to step k and snapshot. Make a copy whose hidden truth differs in ways not yet visible in any observation (rival fuel ±20 kg; our `bY` +0.2 applied only from step k+1; a different future weather path). Ask B0, B1 and OPT for their step-k+1 action from both copies: the actions and the full `Decision` objects (excluding `elapsedMs`) must be identical. The ESLint import rule (`01_ARCHITECTURE.md` §1.4) must also pass.
6. Single-car deterministic gate test: one car, no randomness, 10 laps with one stop reproduces the hand-computed lap times from M03/M04/M07.
