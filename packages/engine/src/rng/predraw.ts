// M01 §1.3 — complete pre-draw manifest. Every world-side random value is an array lookup here.
// Arrays are filled in the order of the manifest table, car by car, index by index.
import { Rng, STREAM, stream } from './rng';

export class PredrawOverflowError extends Error {
  constructor(name: string, index: number, size: number) {
    super(`pre-draw array ${name} read at ${index} but has ${size} entries`);
    this.name = 'PredrawOverflowError';
  }
}

export interface PredrawSizes {
  nCars: number;
  K: number; // K_max laps
  J: number; // J_max environment ticks
  S: number; // S_max stops per car
}

export function predrawSizes(duration_s: number, lapRef_s: number, nCars: number): PredrawSizes {
  const K = Math.ceil(duration_s / (0.9 * lapRef_s)) + 20;
  const J = Math.ceil(duration_s / lapRef_s) + 40;
  const S = Math.ceil(K / 5) + 5;
  return { nCars, K, J, S };
}

/** A per-car 2-D array stored flat as [car * width + index]. */
export class CarArray {
  constructor(
    readonly name: string,
    readonly data: Float64Array,
    readonly width: number,
  ) {}
  get(car: number, i: number): number {
    if (i < 0 || i >= this.width) throw new PredrawOverflowError(this.name, i, this.width);
    return this.data[car * this.width + i];
  }
}

export class Vec {
  constructor(
    readonly name: string,
    readonly data: Float64Array,
  ) {}
  get(i: number): number {
    if (i < 0 || i >= this.data.length) throw new PredrawOverflowError(this.name, i, this.data.length);
    return this.data[i];
  }
}

export interface Predraw {
  seed: number;
  sizes: PredrawSizes;
  // stream 0 — weather
  weatherU: Vec;
  trackTempN: Vec;
  wetObsN: Vec;
  // stream 1 — caution
  cautionU: Vec;
  cautionStartU: Vec;
  cautionDurU: Vec;
  // streams 2–4 — multiplier shocks, fuel gauge
  n1: CarArray;
  n2: CarArray;
  n3: CarArray;
  gaugeN: CarArray;
  // stream 5 — pit service (per stop)
  pitLogN: CarArray;
  pitSlowU: CarArray;
  pitSlowAddU: CarArray;
  /** tread-depth measurement noise of the removed set (per stop) */
  treadN: CarArray;
  // stream 6 — incidents, failures, punctures
  incidentU: CarArray;
  incidentPosU: CarArray;
  incidentRetireU: CarArray;
  incidentFcyU: CarArray;
  incidentRepairU: CarArray;
  failureU: CarArray;
  failurePosU: CarArray;
  failureRetireU: CarArray;
  failureFcyU: CarArray;
  failureRepairU: CarArray;
  punctureU: CarArray;
  puncturePosU: CarArray;
  // stream 7 — traffic, residual, tyre temperature
  trafficU: CarArray;
  trafficE: CarArray;
  epsN: CarArray;
  tyreTempN: CarArray;
  // stream 8 — rivals
  rivalPaceN: Vec;
  rivalGripN: Vec;
  rivalPolicyU: CarArray;
  // stream 9 — hierarchical coefficients
  kBaseN: Vec;
  qBaseN: Vec;
  heatN: Vec;
  // stream 11 — family randomness
  familyU: Vec;
}

function vec(name: string, n: number, rng: Rng, kind: 'u' | 'n' | 'e'): Vec {
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = kind === 'u' ? rng.uniform() : kind === 'n' ? rng.normal() : rng.exponential1();
  return new Vec(name, a);
}

/**
 * Fill per-car arrays in manifest order: for each array in `specs`, for each car, for each index.
 * Each (stream, car) pair has its own generator so cars are independent of field size.
 */
function carArrays(
  masterSeed: number,
  streamId: number,
  nCars: number,
  width: number,
  specs: { name: string; kind: 'u' | 'n' | 'e' }[],
): CarArray[] {
  const out = specs.map((s) => new CarArray(s.name, new Float64Array(nCars * width), width));
  const rngs = Array.from({ length: nCars }, (_, c) => stream(masterSeed, streamId, c));
  specs.forEach((s, ai) => {
    for (let c = 0; c < nCars; c++) {
      const rng = rngs[c];
      const data = out[ai].data;
      for (let i = 0; i < width; i++) {
        data[c * width + i] = s.kind === 'u' ? rng.uniform() : s.kind === 'n' ? rng.normal() : rng.exponential1();
      }
    }
  });
  return out;
}

export function predraw(masterSeed: number, sizes: PredrawSizes): Predraw {
  const { nCars, K, J, S } = sizes;
  const w = stream(masterSeed, STREAM.weather);
  const weatherU = vec('weatherU', J, w, 'u');
  const trackTempN = vec('trackTempN', J, w, 'n');
  const wetObsN = vec('wetObsN', K, w, 'n');

  const c = stream(masterSeed, STREAM.caution);
  const cautionU = vec('cautionU', K, c, 'u');
  const cautionStartU = vec('cautionStartU', K, c, 'u');
  const cautionDurU = vec('cautionDurU', K, c, 'u');

  const [n1] = carArrays(masterSeed, STREAM.grip, nCars, K, [{ name: 'n1', kind: 'n' }]);
  const [n2] = carArrays(masterSeed, STREAM.wear, nCars, K, [{ name: 'n2', kind: 'n' }]);
  const [n3, gaugeN] = carArrays(masterSeed, STREAM.fuel, nCars, K, [
    { name: 'n3', kind: 'n' },
    { name: 'gaugeN', kind: 'n' },
  ]);
  const [pitLogN, pitSlowU, pitSlowAddU, treadN] = carArrays(masterSeed, STREAM.pit, nCars, S, [
    { name: 'pitLogN', kind: 'n' },
    { name: 'pitSlowU', kind: 'u' },
    { name: 'pitSlowAddU', kind: 'u' },
    { name: 'treadN', kind: 'n' },
  ]);
  const fail = carArrays(
    masterSeed,
    STREAM.failure,
    nCars,
    K,
    [
      'incidentU',
      'incidentPosU',
      'incidentRetireU',
      'incidentFcyU',
      'incidentRepairU',
      'failureU',
      'failurePosU',
      'failureRetireU',
      'failureFcyU',
      'failureRepairU',
      'punctureU',
      'puncturePosU',
    ].map((name) => ({ name, kind: 'u' as const })),
  );
  const [trafficU, trafficE, epsN, tyreTempN] = carArrays(masterSeed, STREAM.traffic, nCars, K, [
    { name: 'trafficU', kind: 'u' },
    { name: 'trafficE', kind: 'e' },
    { name: 'epsN', kind: 'n' },
    { name: 'tyreTempN', kind: 'n' },
  ]);

  const r = stream(masterSeed, STREAM.rival);
  const rivalPaceN = vec('rivalPaceN', nCars, r, 'n');
  const rivalGripN = vec('rivalGripN', nCars, r, 'n');
  const [rivalPolicyU] = carArrays(masterSeed, STREAM.rival, nCars, 8, [{ name: 'rivalPolicyU', kind: 'u' }]);

  const p = stream(masterSeed, STREAM.params);
  const kBaseN = vec('kBaseN', nCars, p, 'n');
  const qBaseN = vec('qBaseN', nCars, p, 'n');
  const heatN = vec('heatN', nCars, p, 'n');

  const familyU = vec('familyU', 8, stream(masterSeed, STREAM.family), 'u');

  return {
    seed: masterSeed,
    sizes,
    weatherU,
    trackTempN,
    wetObsN,
    cautionU,
    cautionStartU,
    cautionDurU,
    n1,
    n2,
    n3,
    gaugeN,
    pitLogN,
    pitSlowU,
    pitSlowAddU,
    treadN,
    incidentU: fail[0],
    incidentPosU: fail[1],
    incidentRetireU: fail[2],
    incidentFcyU: fail[3],
    incidentRepairU: fail[4],
    failureU: fail[5],
    failurePosU: fail[6],
    failureRetireU: fail[7],
    failureFcyU: fail[8],
    failureRepairU: fail[9],
    punctureU: fail[10],
    puncturePosU: fail[11],
    trafficU,
    trafficE,
    epsN,
    tyreTempN,
    rivalPaceN,
    rivalGripN,
    rivalPolicyU,
    kBaseN,
    qBaseN,
    heatN,
    familyU,
  };
}

/** Hash every array of a pre-draw (determinism tests). */
export function hashPredraw(pd: Predraw): string {
  let h = 0x811c9dc5;
  const mix = (a: Float64Array) => {
    const u = new Uint32Array(a.buffer, a.byteOffset, a.length * 2);
    for (let i = 0; i < u.length; i++) {
      h ^= u[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const v of Object.values(pd)) {
    if (v instanceof Vec || v instanceof CarArray) mix(v.data);
  }
  return h.toString(16);
}

/** Test helper: remove all randomness — normals and exponentials 0, event uniforms just below 1
 *  (nothing happens), weather uniforms 0 (the chain stays in its current regime). */
export function zeroNoise(pd: Predraw): Predraw {
  for (const [name, v] of Object.entries(pd)) {
    if (!(v instanceof Vec || v instanceof CarArray)) continue;
    const uniform = /U$/.test(name);
    v.data.fill(uniform && name !== 'weatherU' ? 0.999999 : 0);
  }
  return pd;
}
