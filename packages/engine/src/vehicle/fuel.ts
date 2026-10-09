// M04 §4.5 — fuel burn and mass. Fuel is burned in proportion to track distance; the pit lane burns nothing.
import type { CarConfig, Mode } from '@pitwall/shared';
import { massRef } from './tyre';

export interface BurnInputs {
  bZ: number;
  burnMult: number;
  mode: Mode;
  mStart: number;
  fc: number;
  Z: number;
  fuelSpike?: number;
}

/** Burn for a full lap (kg). */
export function burnPerLap(car: CarConfig, i: BurnInputs): number {
  const f = car.fuel;
  return (
    f.qBase_kg_per_lap *
    Math.exp(i.bZ) *
    i.burnMult *
    car.modes[i.mode].burnFactor *
    Math.pow(i.mStart / massRef(car), f.massExponent) *
    (1 - i.fc + i.fc * f.cautionBurnFactor) *
    i.Z *
    (i.fuelSpike ?? 1)
  );
}

/** Nominal burn (no noise, normal mode, green) used by strategies' bookkeeping. */
export function nominalBurn(car: CarConfig, mode: Mode = 'normal', fc = 0): number {
  return car.fuel.qBase_kg_per_lap * car.modes[mode].burnFactor * (1 - fc + fc * car.fuel.cautionBurnFactor);
}

/**
 * Lap distance at which the car runs dry, or null if it completes the stretch.
 * @param F fuel at the start of the stretch, q burn per full lap, from/to lap distances.
 */
export function dryPoint(F: number, q: number, fromS: number, toS: number, lapLength: number): number | null {
  const need = (q * (toS - fromS)) / lapLength;
  if (F >= need) return null;
  return fromS + (Math.max(0, F) / q) * lapLength;
}
