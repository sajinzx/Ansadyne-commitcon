# Shared types, schemas and config files (`packages/shared`)

Every type below is exported from `packages/shared/src/types.ts`, and every config or API payload has a Zod schema in `src/schemas.ts`. The backend validates all inputs with these schemas; the frontend imports the types only. Fields marked † are present only in synthetic mode and only for display.

## S.1 Provenance and parameters (fixes B12)

```ts
type Provenance = "REPORTED" | "ILLUSTRATIVE" | "ASSUMED" | "UNCALIBRATED" | "UNVERIFIED" | "FITTED";
interface Param<T = number> { value: T; unit?: string; low?: number; high?: number; provenance: Provenance; note?: string }
```

Config loaders reject any tag outside this list. Free text goes in `note`.

## S.2 Config files (in `packages/shared/config/`)

| File | Owner module | Schema |
|---|---|---|
| `track.daytona.json` | M02 | `TrackConfigSchema` |
| `car.gt3.json` | M03 | `CarConfigSchema` |
| `race.default.json` | M06 | `RaceConfigSchema` |
| `field.json` | M09 | `FieldConfigSchema` |
| `planner.default.json` | M12 | `PlannerConfigSchema` |

Range validation (422 on failure): κ > 0; σ ≥ 0; |ρ_XY| < 0.99; `capacity_kg > reserveLaps·qBase`; transition-matrix rows sum to 1 ± 1e-9; durations ∈ {1, 3, 6} h; `paths` ∈ {100, 200, 400, 800}; `lambdaRisk` ∈ [0, 2]; `cvarAlpha` ∈ [0.80, 0.99]; `pFailLimit` ∈ [0.001, 0.05].

## S.3 Run configuration

```ts
type StrategyId = "B0" | "B1" | "OPT";
type Compound = "dry" | "wet";
type Mode = "save" | "normal" | "push";
type Split = "dev" | "val" | "test";

interface RunConfig {
  masterSeed: number; split: Split; family?: string;
  durationHours: 1 | 3 | 6; startClock: string; egoGridSlot: number;
  multiplierModel: "expOU" | "gbm";
  overrides: { car?: Partial<CarConfig>; race?: Partial<RaceConfig>; planner?: Partial<PlannerConfig>;
               weatherMatrix?: number[][]; processes?: { sigmaX?: number; kappaX?: number; rhoXY?: number } };
}
```

## S.4 Actions, plans, stints, overrides

```ts
interface Action { pit: boolean; refuel_kg: number; tyres: "none" | Compound; driverChange: false; mode: Mode }
interface Plan { stops: { lap: number; refuel: "helper" | number; tyres: "none" | Compound }[];
                 mode: { mode: Mode; untilLap: number } | null; source: string; committedLap: number }
interface Stint { startLap: number; endLap?: number; compound: Compound; startFuel_kg: number; laps: number; planned?: boolean }
interface SegmentOverride { segmentId: string; wetnessOffset?: number; debris?: boolean; untilTick?: number }
interface Injection { kind: "caution" | "rain" | "fuelSpike" | "debris"; step: number; params?: { segmentId?: string } }
```

## S.5 Observation and belief

`Observation` and `ObsHistory`: defined in `modules/M08_race_engine.md` §8.4. `Belief`: defined in `modules/M11_estimator.md` §11.3. They live in `shared` so the frontend can render them.

## S.6 Stream payloads

```ts
interface EnvPublic { tick: number; regime: "dry" | "damp" | "wet"; wetness: number; trackTemp_C: number;
                      airTemp_C: number; rubber: number; rainProb: { in10: number; in20: number; in40: number }; night: boolean }
interface CautionPublic { active: boolean; lapsElapsed: number; lapsLeft: number | null; pitOpen: boolean; startTime_s: number | null }

interface PitTiming { phase: "in" | "out"; t_entry?: number; t_line?: number; t_box?: number; service_s?: number;
                      t_exit?: number; refuelApplied_kg?: number; tyres?: "none" | Compound; forced?: string[] }

interface CarLapRecord {
  no: number; lap: number; lapStart_s: number; lapTime_s: number; lineCross_s: number;
  sectorTimes_s: [number, number, number];
  position: number; lapsDown: number; gapLeader_s: number; gapAhead_s: number;
  compound: Compound; tyreAgeLaps: number; stops: number; flag: "green" | "caution" | "mixed";
  pit: PitTiming | null; running: boolean; classified: boolean; dnf?: { cause: "fuel" | "incident" | "failure"; atTime_s: number; atLapDist_m: number };
  ego?: { belief: Belief; truth?: { fuel_kg: number; wear: number; X: number; Yeff: number; Zeff: number; tyreTemp_C: number } };  // truth †
}

interface LapEvent { world: StrategyId; step: number; clock: string; raceTime_s: number;
                     env: EnvPublic; caution: CautionPublic; cars: CarLapRecord[]; events: RaceEvent[] }

type RaceEvent =
  | { type: "pit"; car: number; step: number; forced: boolean; refused?: string }
  | { type: "incident" | "failure" | "puncture"; car: number; step: number; atLapDist_m: number; zone?: string; outcome: "retire" | "repair" | "limp" }
  | { type: "caution_start"; step: number; t_c: number; cause: "background" | "incident" | "failure" | "injected" }
  | { type: "caution_end" | "pit_open"; step: number }
  | { type: "dnf"; car: number; cause: "fuel" | "incident" | "failure" }
  | { type: "injected"; injection: Injection }
  | { type: "trigger"; world: StrategyId; trigger: string; step: number }
  | { type: "warning"; code: "surrogate_out_of_range" | "planner_over_budget" | "gated_update" | "refuel_clamped"; detail: string };

interface CandidateRow { id: string; label: string; meanPos: number; medianPos: number; p10: number; p90: number;
  pWin: number; pTop3: number; cvar: number; pFail: number; pFailCI95: [number, number]; score: number;
  deltaVsB1: number; deltaCI90: [number, number]; paths: number; feasible: boolean }

interface Decision { id: string; world: "OPT"; step: number; lap: number; trigger: string;
  candidates: CandidateRow[]; chosen: string; committed: boolean; keptReason?: string; plan: Plan;
  nPaths: number; rounds: number[]; elapsedMs: number; overBudget: boolean; rankStability: number;
  reasons: string[]; histChosen: number[]; histB1: number[] }      // finishing-position histograms, length 11 (P1–P10, DNF)

interface Projection { step: number; world: StrategyId; meanPos: number; p10: number; p90: number; nextStopLap: number | null; stopsDone: number; stopsPlanned: number }

interface RunInfo { runId: string; state: "created" | "running" | "paused" | "finished" | "error";
  step: number; raceTime_s: number; config: RunConfig; seedLabel: string;
  repro: { codeVersion: string; configHash: string; masterSeed: number; injections: Injection[] };
  init?: { track: TrackGeometryPayload; tau: { s: number[]; tau: number[] }; b0Plan: Plan; diagnostics: Diagnostics; mu_peak: number } }

interface RunSummary { byStrategy: Record<StrategyId, { finalPos: number; laps: number; stops: number; dnf?: string }>;
  decisions: number; injections: Injection[] }

interface ForkRequest { world: StrategyId; fromStep: number; forcedPlan: Plan }
interface ForkResult { forkId: string; finalPos: number; laps: number; positionTrace: number[]; deltaVsParent: number }

interface BenchRequest { families: string[]; seedsPerFamily: number; split: Split; rounds?: number[]; experiment?: string; oracleBelief?: boolean }
interface BenchResult { families: FamilyResult[]; settingsHash: string; codeVersion: string; runtimeMs: number }
interface FamilyResult { family: string; n: number; paired: boolean;
  diffs: Record<"OPT-B1" | "OPT-B0" | "B1-B0", { mean: number; ciBoot95: [number, number]; ciT95: [number, number]; holmAdjustedP: number }>;
  winTieLoss: Record<"OPT-B1" | "OPT-B0", [number, number, number]>;
  pFinish: Record<StrategyId, number>; pWin: Record<StrategyId, number>; cvar95: Record<StrategyId, number>;
  meanStops: Record<StrategyId, number>; decisionMsP95: number }

interface ProblemDetails { type: string; title: string; status: number; detail?: string; instance?: string; errors?: { path: string; message: string }[] }
```

`TrackGeometryPayload` (from `GET /track`): smoothed polyline points per segment, pit-lane polyline with `u` stations (entry, line, box, exit), sector boundary points, incident-zone polylines, and the segment table with every field and its provenance. `Diagnostics`: M03 §3.5 emergent values.
