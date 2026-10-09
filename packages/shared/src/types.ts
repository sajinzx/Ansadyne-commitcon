// Shared PITWALL types (docs/spec/shared/SHARED_TYPES.md).
// Used by the engine, the backend and (types only) the frontend.

// ---------------------------------------------------------------- provenance
export const PROVENANCE_TAGS = [
  'REPORTED',
  'ILLUSTRATIVE',
  'ASSUMED',
  'UNCALIBRATED',
  'UNVERIFIED',
  'FITTED',
] as const;
export type Provenance = (typeof PROVENANCE_TAGS)[number];

export interface Param<T = number> {
  value: T;
  unit?: string;
  low?: number;
  high?: number;
  provenance: Provenance;
  note?: string;
}

// ---------------------------------------------------------------- basic ids
export type StrategyId = 'B0' | 'B1' | 'OPT';
export const STRATEGIES: StrategyId[] = ['B0', 'B1', 'OPT'];
export type Compound = 'dry' | 'wet';
export type Mode = 'save' | 'normal' | 'push';
export type Split = 'dev' | 'val' | 'test';
export type Regime = 'dry' | 'damp' | 'wet';
export type DnfCause = 'fuel' | 'incident' | 'failure';

// ---------------------------------------------------------------- configs
export type SegmentType = 'straight' | 'infield_turn' | 'chicane' | 'banked_turn';

export interface SegmentConfig {
  id: string;
  name: string;
  type: SegmentType;
  start_m: number;
  end_m: number;
  elevation_m: Param;
  banking_deg: Param;
  cornerRadius_m: Param | null;
  drawnMinRadius_m: number;
  dryGrip: Param;
  wetGrip: Param;
  apex: { at: number; window_m: number }[];
  points: [number, number][];
}

export interface TrackConfig {
  name: string;
  lapLength_m: Param;
  viewBox: number[];
  meanDryGrip: number;
  segments: SegmentConfig[];
  pitLane: {
    entry_s_m: number;
    exit_s_m: number;
    laneLength_m: Param;
    timingLine_u_m: Param;
    box_u_m: Param;
    speedLimit_kph: Param;
    entryLoss_s: Param;
    exitLoss_s: Param;
    points: [number, number][];
  };
  sectors: { id: string; from_m: number; to_m: number; provenance: Provenance }[];
  incidentZones: {
    id: string;
    name: string;
    from_m: number;
    to_m: number;
    categories: string[];
    level: number;
    provenance: Provenance;
  }[];
}

export interface ModeFactors {
  powerFactor: number;
  burnFactor: number;
  wearFactor: number;
  heatFactor: number;
  riskFactor: number;
}

export interface TyreCompoundConfig {
  Topt_C: number;
  Twidth_C: number;
  kBase_per_lap: number;
  alphaW: number;
  betaW: number;
  Wcliff: number;
  Wlimit: number;
  dryWearPenalty?: number;
}

export interface CarConfig {
  label: string;
  mass_dry_kg: Param;
  power_kW: Param;
  CdA_m2: Param;
  ClA_m2: Param;
  Crr: Param;
  driveGripShare: Param;
  lapRef_s: Param;
  referenceConditions: {
    fuel_kg: number;
    trackTemp_C: number;
    airTemp_C: number;
    wetness: number;
    rubber: number;
    tyreTemp_C: number;
    wear: number;
    mode: Mode;
    compound: Compound;
  };
  modes: Record<Mode, ModeFactors>;
  fuel: {
    capacity_kg: number;
    qBase_kg_per_lap: number;
    massExponent: number;
    cautionBurnFactor: number;
    gaugeNoise_kg: number;
    reserveLaps: number;
    provenance: Provenance;
  };
  tyres: {
    dry: TyreCompoundConfig;
    wet: TyreCompoundConfig;
    thermal: {
      aHeat_C: number;
      bCool: number;
      sigma_C: number;
      newTyreOffset_C: number;
      cautionHeatFactor: number;
      wearTempCoeff: number;
      fTPenalty: number;
      fTFloor: number;
    };
    puncture: { h0_per_lap: number; h1: number; limpLoss_s: number };
    /** sd of the crew's tread-depth measurement of a removed set (fraction of full wear) */
    treadGaugeSigma?: number;
    provenance: Provenance;
  };
  reliability: {
    failure_per_lap: number;
    pRetireOnFailure: number;
    repair_s: [number, number];
    provenance: Provenance;
  };
  pit: {
    refuelRate_kg_s: number;
    tyreChange4_s: number;
    driverChange_s: number;
    serviceLogSigma: number;
    slowStopProb: number;
    slowStopAdd_s: [number, number];
    provenance: Provenance;
  };
}

export interface RaceConfig {
  duration_s: number;
  durationOptions_h: number[];
  end: 'time_certain';
  startClock: string;
  startingFuel_kg: number;
  startingCompound: Compound;
  rules: {
    pitClosedFirstCautionLaps: Param;
    emergencyFuelWhenClosed: Param<boolean> & { splash_kg: number };
    serviceMode: Param<'sequential' | 'parallel'>;
    minPitService_s: Param;
    tyreSets: { dryPerHour: number; dryBase: number; wetPerHour: number; wetBase: number; provenance: Provenance };
    noPitOnOutLap: Param<boolean>;
    drivers: DriverRules;
  };
  caution: {
    background_per_lap: number;
    wetMultiplier: number;
    nightMultiplier: number;
    durationLaps: Record<string, number>;
    minGreenLapsBetween: number;
    paceLapFactor: number;
    runToQueueFactor: number;
    queueGap_s: number;
    raceControlDelay_s: number;
    pFcyGivenIncident: number;
    pFcyGivenFailure: number;
    provenance: Provenance;
  };
  incidents: {
    base_per_car_lap: number;
    wetMultiplier: number;
    wearMultiplier: number;
    nightMultiplier: number;
    pRetire: number;
    repair_s: [number, number];
    provenance: Provenance;
  };
  traffic: { pPerLap: number; meanLoss_s: number; provenance: Provenance };
  dirtyAir: { gapThreshold_s: number; maxLoss_s: number; provenance: Provenance };
  overtaking: { holdGap_s: number; passDelta_s: number; passCost_s: number; provenance: Provenance };
  residualSigma_s: Param;
}

export type RivalArchetype = 'ego' | 'reactive' | 'fixedStint' | 'aggressiveCaution' | 'conservative';

export interface FieldCar {
  no: number;
  label: string;
  paceFactor: number;
  gripSkill: number;
  wearMult: number;
  burnMult: number;
  wetSkill: number;
  grid: number;
  archetype: RivalArchetype;
}

export interface FieldConfig {
  ego: number;
  note: string;
  cars: FieldCar[];
}

export interface B1Thresholds {
  fuelTyreWear: number;
  cautionFuelUsed: number;
  cautionWear: number;
  cautionTyreWear: number;
  wetIn: number;
  wetOut: number;
  wearLimit: number;
}

export interface PlannerConfig {
  paths: number;
  rounds: number[];
  horizonLaps: number;
  budgetMs: number;
  lambdaRisk: number;
  cvarAlpha: number;
  pFailLimit: number;
  elimination: { minGap: number; seMultiplier: number };
  commit: { minGainPositions: number; ciLevel: number; dwellLaps: number };
  triggers: {
    gripZ: number;
    gripConsecutive: number;
    gripCooldown: number;
    wearCooldown: number;
    fuelReserveLaps: number;
    fuelCooldown: number;
    rainProbThreshold: number;
    weatherCooldown: number;
    rivalWindow_s: number;
    rivalCooldown: number;
    scheduledEvery: number;
    preStopLaps: number;
  };
  rankStability: { seedSets: number; paths: number };
  pauseForPlanner: boolean;
  b1: B1Thresholds;
}

export interface Configs {
  track: TrackConfig;
  car: CarConfig;
  race: RaceConfig;
  field: FieldConfig;
  planner: PlannerConfig;
}

// ---------------------------------------------------------------- run config
export interface RunConfig {
  masterSeed: number;
  split: Split;
  family?: string;
  durationHours: 1 | 3 | 6;
  startClock: string;
  egoGridSlot: number;
  multiplierModel: 'expOU' | 'gbm';
  overrides: {
    car?: {
      capacity_kg?: number;
      qBase_kg_per_lap?: number;
      kBaseDry_per_lap?: number;
      laneLength_m?: number;
      serviceMode?: 'sequential' | 'parallel';
    };
    race?: { background_per_lap?: number };
    planner?: Partial<Pick<PlannerConfig, 'paths' | 'horizonLaps' | 'lambdaRisk' | 'cvarAlpha' | 'pFailLimit' | 'pauseForPlanner'>> & {
      gripZ?: number;
      gripCooldown?: number;
    };
    weatherMatrix?: number[][];
    processes?: { sigmaX?: number; kappaX?: number; rhoXY?: number };
  };
  /** bench-only: oracle belief for the honesty experiment (rejected by the live API) */
  oracleBelief?: boolean;
}

// ---------------------------------------------------------------- actions, plans
export interface Action {
  pit: boolean;
  refuel_kg: number;
  tyres: 'none' | Compound;
  /** swap drivers at this stop (the crew's driver policy fills it when a strategy leaves it false) */
  driverChange: boolean;
  /** index of the incoming driver when driverChange is true */
  nextDriver?: number;
  mode: Mode;
}

export interface DriverSpec {
  name: string;
  /** lap-time factor relative to the car's base pace (1.007 = 0.7% slower) */
  pace: number;
  rating: 'Platinum' | 'Gold' | 'Silver' | 'Bronze';
}

export interface DriverRules {
  /** line-ups by race length in hours */
  lineups: Record<string, DriverSpec[]>;
  /** minimum total drive time per driver by race length in hours (s) */
  minDrive_s: Record<string, number>;
  /** no driver may drive more than this continuously (s) */
  maxContinuous_s: number;
  provenance: Provenance;
  note?: string;
}

export interface DriverState {
  current: number;
  lineup: DriverSpec[];
  total_s: number[];
  continuous_s: number;
  minDrive_s: number;
  maxContinuous_s: number;
}

export interface PlanStop {
  lap: number;
  refuel: 'helper' | number;
  tyres: 'none' | Compound;
}

export interface Plan {
  stops: PlanStop[];
  mode: { mode: Mode; untilLap: number } | null;
  source: string;
  committedLap: number;
}

export interface Stint {
  startLap: number;
  endLap?: number;
  compound: Compound;
  startFuel_kg: number;
  laps: number;
  planned?: boolean;
}

export interface SegmentOverride {
  segmentId: string;
  wetnessOffset?: number;
  debris?: boolean;
  untilTick?: number;
}

export type InjectionKind = 'caution' | 'rain' | 'fuelSpike' | 'debris' | 'weather' | 'weatherMatrix' | 'surface';
export interface InjectionParams {
  /** debris: the segment */
  segmentId?: string;
  /** weather: force this Markov state for `ticks` ticks (default 15), then the chain resumes */
  regime?: Regime;
  ticks?: number;
  /** weatherMatrix: new per-tick transition matrix from the next tick on */
  matrix?: number[][];
  /** surface: the persistent track set-up (replaces the previous one; [] and 0 = back to original) */
  overrides?: SegmentOverride[];
  trackTempOffset_C?: number;
}
export interface Injection {
  kind: InjectionKind;
  step: number;
  params?: InjectionParams;
}

// ---------------------------------------------------------------- observation, belief
export interface Observation {
  step: number;
  lap: number;
  raceTime_s: number;
  remaining_s: number;
  clock: string;
  flag: 'green' | 'caution';
  pitOpen: boolean;
  cautionLapsElapsed: number;
  regime: Regime;
  wetness_est: number;
  trackTemp_C: number;
  airTemp_C: number;
  rubber_est: number;
  rainProb: { in10: number; in20: number; in40: number };
  overrides: SegmentOverride[];
  ego: {
    no: number;
    lastLap_s: number;
    sectorTimes_s: [number, number, number];
    fuelGauge_kg: number;
    compound: Compound;
    tyreAgeLaps: number;
    lapsSinceStop: number;
    tyreTemp_C: number;
    mode: Mode;
    stops: number;
    position: number;
    gapAhead_s: number;
    gapBehind_s: number;
    setsLeft: { dry: number; wet: number };
    lastRefuelApplied_kg: number | null;
    /** tread-depth measurement of the set removed at the stop that ended last lap (out-lap only) */
    treadMeasured?: { wear: number; laps: number; compound: Compound } | null;
    drivers?: DriverState;
    lastLapFlags: { inLap: boolean; outLap: boolean; caution: boolean; incident: boolean };
    fuelUsedSinceStop_kg: number;
    running: boolean;
    forcedPending: boolean;
  };
  rivals: {
    no: number;
    position: number;
    laps: number;
    gap_s: number;
    lastLap_s: number;
    tyreAgeSinceSeenStop: number;
    stops: number;
    inPit: boolean;
    running: boolean;
    lastLapGreen: boolean;
    pittedThisCaution: boolean;
  }[];
}

export interface ObsHistory {
  last: Observation[];
}

export interface Estimate {
  mean: number;
  sd: number;
}

export interface Belief {
  lap: number;
  fuel: Estimate;
  X: Estimate;
  Yeff: Estimate;
  Zeff: Estimate;
  W: Estimate;
  /** grip/wear filter mean and covariance over [xi, eta, bY, W] */
  gripMean: number[];
  gripCov: number[][];
  /** fuel filter mean and covariance over [F, zeta, bZ] */
  fuelMean: number[];
  fuelCov: number[][];
  gated: boolean;
  lastInnovationZ: number;
  updated: boolean;
}

// ---------------------------------------------------------------- stream payloads
export interface EnvPublic {
  tick: number;
  regime: Regime;
  wetness: number;
  trackTemp_C: number;
  airTemp_C: number;
  rubber: number;
  rainProb: { in10: number; in20: number; in40: number };
  night: boolean;
  /** regime distribution (dry, damp, wet) after 5, 10 and 20 ticks from the current state */
  forecast?: { in5: number[]; in10: number[]; in20: number[] };
  /** the transition matrix in force */
  matrix?: number[][];
  /** persistent track set-up applied by the user (Track tab) */
  surface?: { overrides: SegmentOverride[]; trackTempOffset_C: number };
}

export interface CautionPublic {
  active: boolean;
  lapsElapsed: number;
  lapsLeft: number | null;
  pitOpen: boolean;
  startTime_s: number | null;
}

export interface PitTiming {
  phase: 'in' | 'out';
  t_entry?: number;
  t_line?: number;
  t_box?: number;
  service_s?: number;
  t_exit?: number;
  refuelApplied_kg?: number;
  tyres?: 'none' | Compound;
  forced?: string[];
}

export interface EgoTruth {
  fuel_kg: number;
  wear: number;
  X: number;
  Yeff: number;
  Zeff: number;
  tyreTemp_C: number;
}

export interface CarLapRecord {
  no: number;
  lap: number;
  lapStart_s: number;
  lapTime_s: number;
  lineCross_s: number;
  sectorTimes_s: [number, number, number];
  position: number;
  lapsDown: number;
  gapLeader_s: number;
  gapAhead_s: number;
  compound: Compound;
  tyreAgeLaps: number;
  stops: number;
  flag: 'green' | 'caution' | 'mixed';
  pit: PitTiming | null;
  running: boolean;
  classified: boolean;
  dnf?: { cause: DnfCause; atTime_s: number; atLapDist_m: number };
  mode: Mode;
  /** who drove this lap */
  driver?: string;
  ego?: { belief: Belief; truth?: EgoTruth; plan?: Plan | null };
}

export type RaceEvent =
  | { type: 'pit'; car: number; step: number; forced: boolean; refused?: string; world: StrategyId }
  | {
      type: 'incident' | 'failure' | 'puncture';
      car: number;
      step: number;
      atLapDist_m: number;
      zone?: string;
      outcome: 'retire' | 'repair' | 'limp';
      world: StrategyId;
    }
  | { type: 'caution_start'; step: number; t_c: number; cause: 'background' | 'incident' | 'failure' | 'injected'; world: StrategyId }
  | { type: 'caution_end' | 'pit_open'; step: number; world: StrategyId }
  | { type: 'dnf'; car: number; cause: DnfCause; step: number; world: StrategyId }
  | { type: 'injected'; injection: Injection }
  | { type: 'trigger'; world: StrategyId; trigger: string; step: number }
  | { type: 'penalty'; car: number; step: number; reason: string; world: StrategyId }
  | { type: 'driver_change'; car: number; step: number; from: string; to: string; world: StrategyId }
  | {
      type: 'warning';
      code: 'surrogate_out_of_range' | 'planner_over_budget' | 'gated_update' | 'refuel_clamped';
      detail: string;
    };

export interface LapEvent {
  world: StrategyId;
  step: number;
  clock: string;
  raceTime_s: number;
  env: EnvPublic;
  caution: CautionPublic;
  cars: CarLapRecord[];
  events: RaceEvent[];
}

export interface CandidateRow {
  id: string;
  label: string;
  meanPos: number;
  medianPos: number;
  p10: number;
  p90: number;
  pWin: number;
  pTop3: number;
  cvar: number;
  pFail: number;
  pFailCI95: [number, number];
  score: number;
  deltaVsB1: number;
  deltaCI90: [number, number];
  paths: number;
  feasible: boolean;
}

export interface Decision {
  id: string;
  world: 'OPT';
  step: number;
  lap: number;
  trigger: string;
  candidates: CandidateRow[];
  chosen: string;
  committed: boolean;
  keptReason?: string;
  plan: Plan;
  nPaths: number;
  rounds: number[];
  elapsedMs: number;
  overBudget: boolean;
  rankStability: number;
  reasons: string[];
  /** finishing-position histograms, length 11 (P1..P10, DNF) */
  histChosen: number[];
  histB1: number[];
}

export interface Projection {
  step: number;
  world: StrategyId;
  meanPos: number;
  p10: number;
  p90: number;
  nextStopLap: number | null;
  stopsDone: number;
  stopsPlanned: number;
}

export interface Diagnostics {
  mu_peak: number;
  power_kW: number;
  lapRef_s: number;
  sectorTimes_s: [number, number, number];
  c_f_s_per_kg: number;
  topSpeed_kph: number;
  topSpeedAt_m: number;
  topSpeedSegment: string;
  minSpeedS04_kph: number;
  minSpeedS08_kph: number;
  dT_dS: number;
  tau5613: number;
  tau884: number;
  tStretchRef_s: number;
  pit: { fullStop_s: number; netGreen_s: number; netCaution_s: number };
}

export interface TrackGeometryPayload {
  name: string;
  viewBox: number[];
  lapLength_m: number;
  centerline: { x: number; y: number; s: number; seg: string }[];
  segments: {
    id: string;
    name: string;
    type: SegmentType;
    start_m: number;
    end_m: number;
    length_m: number;
    elevation_m: Param;
    banking_deg: Param;
    cornerRadius_m: Param | null;
    drawnMinRadius_m: number;
    dryGrip: Param;
    wetGrip: Param;
    polyline: [number, number][];
  }[];
  pitLane: {
    polyline: [number, number][];
    stations: { entry: [number, number]; line: [number, number]; box: [number, number]; exit: [number, number] };
    laneLength_m: number;
    timingLine_u_m: number;
    box_u_m: number;
    entry_s_m: number;
    exit_s_m: number;
    speedLimit_kph: number;
  };
  sectors: { id: string; from_m: number; to_m: number; boundary: [number, number] }[];
  incidentZones: { id: string; name: string; level: number; categories: string[]; polyline: [number, number][]; provenance: Provenance }[];
  startFinish: { point: [number, number]; heading: number };
}

export interface RunInit {
  track: TrackGeometryPayload;
  tau: { s: number[]; tau: number[] };
  b0Plan: Plan;
  diagnostics: Diagnostics;
  mu_peak: number;
  field: FieldCar[];
  ego: number;
  setsAvailable: { dry: number; wet: number };
  expectedLaps: number;
}

export type RunState = 'created' | 'running' | 'paused' | 'finished' | 'error';

export interface RunInfo {
  runId: string;
  state: RunState;
  step: number;
  raceTime_s: number;
  config: RunConfig;
  seedLabel: string;
  speed: number;
  nonDeterministic: boolean;
  repro: { codeVersion: string; configHash: string; masterSeed: number; injections: Injection[] };
  init?: RunInit;
  error?: ProblemDetails;
}

export interface RunSummary {
  byStrategy: Record<StrategyId, { finalPos: number; laps: number; stops: number; dnf?: string }>;
  decisions: number;
  injections: Injection[];
}

export interface ForkRequest {
  world: StrategyId;
  fromStep: number;
  forcedPlan: Plan;
}

export interface ForkResult {
  forkId: string;
  finalPos: number;
  laps: number;
  positionTrace: number[];
  deltaVsParent: number;
  parentFinalPos: number;
}

export interface BenchRequest {
  families: string[];
  seedsPerFamily: number;
  split: Split;
  rounds?: number[];
  experiment?: string;
  oracleBelief?: boolean;
}

export type DiffKey = 'OPT-B1' | 'OPT-B0' | 'B1-B0';

export interface FamilyResult {
  family: string;
  n: number;
  paired: boolean;
  diffs: Record<DiffKey, { mean: number; ciBoot95: [number, number]; ciT95: [number, number]; holmAdjustedP: number }>;
  winTieLoss: Record<'OPT-B1' | 'OPT-B0', [number, number, number]>;
  pFinish: Record<StrategyId, number>;
  pWin: Record<StrategyId, number>;
  cvar95: Record<StrategyId, number>;
  meanStops: Record<StrategyId, number>;
  meanPos: Record<StrategyId, number>;
  decisionMsP95: number;
  /** Wilson 95% intervals of the win/tie/loss shares */
  winTieLossCI?: Record<'OPT-B1' | 'OPT-B0', [[number, number], [number, number], [number, number]]>;
  /** McNemar exact p-value for paired finish/DNF */
  mcnemarP?: Record<'OPT-B1' | 'OPT-B0', number>;
  pTop3?: Record<StrategyId, number>;
  /** the claim rule: Holm-adjusted test favours OPT over B1 */
  claimOptBeatsB1?: boolean;
}

export interface BenchResult {
  families: FamilyResult[];
  settingsHash: string;
  codeVersion: string;
  runtimeMs: number;
  rounds: number[];
  split: Split;
  experiment?: string;
  extra?: Record<string, unknown>;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: { path: string; message: string }[];
}

export type StreamType =
  | 'run_meta'
  | 'lap'
  | 'decision'
  | 'projection'
  | 'event'
  | 'warning'
  | 'state'
  | 'run_end'
  | 'heartbeat';

export interface StreamMessage<T = unknown> {
  v: 1;
  runId: string;
  seq: number;
  type: StreamType;
  payload: T;
}
