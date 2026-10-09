// M01 §1.1 — seeded generator: xoshiro128** seeded through SplitMix32.
// Math.random is banned in the engine (lint rule); every random value comes from here.

const TWO_32 = 4294967296;

export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Combine integers into one 32-bit seed (MurmurHash3 fmix32 finaliser in sequence). */
export function hash32(...ints: number[]): number {
  let h = 0x811c9dc5;
  for (const v of ints) {
    const x = Math.floor(v) >>> 0;
    h = fmix32((h ^ ((x + 0x9e3779b9 + ((h << 6) >>> 0) + (h >>> 2)) >>> 0)) >>> 0);
  }
  return h >>> 0;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  private spare: number | null = null;

  constructor(seed: number) {
    let x = seed >>> 0;
    const splitmix = () => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.s0 = splitmix();
    this.s1 = splitmix();
    this.s2 = splitmix();
    this.s3 = splitmix();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** U[0, 1) */
  uniform(): number {
    return this.nextU32() / TWO_32;
  }

  /** Standard normal by Box–Muller (caches the spare value). */
  normal(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u1 = this.uniform();
    while (u1 <= 0) u1 = this.uniform();
    const u2 = this.uniform();
    const r = Math.sqrt(-2 * Math.log(u1));
    const th = 2 * Math.PI * u2;
    this.spare = r * Math.sin(th);
    return r * Math.cos(th);
  }

  exponential1(): number {
    return -Math.log(1 - this.uniform());
  }

  lognormal(mu: number, sigma: number): number {
    return Math.exp(mu + sigma * this.normal());
  }

  categorical(probs: number[]): number {
    return categoricalFromU(probs, this.uniform());
  }
}

/** Inverse CDF of a categorical distribution at a given uniform. */
export function categoricalFromU(probs: number[], u: number): number {
  let acc = 0;
  for (let i = 0; i < probs.length; i++) {
    acc += probs[i];
    if (u < acc) return i;
  }
  return probs.length - 1;
}

/** Independent generator for (masterSeed, streamId, ...indices). */
export function stream(masterSeed: number, streamId: number, ...indices: number[]): Rng {
  return new Rng(hash32(masterSeed, streamId, ...indices));
}

export const STREAM = {
  weather: 0,
  caution: 1,
  grip: 2,
  wear: 3,
  fuel: 4,
  pit: 5,
  failure: 6,
  traffic: 7,
  rival: 8,
  params: 9,
  planner: 10,
  family: 11,
} as const;
