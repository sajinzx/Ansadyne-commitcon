// M04 §4.2–4.4 — car-side grip scale, tyre temperature, wear and puncture.
import type { CarConfig, Compound, Mode } from '@pitwall/shared';

export function muCompound(compound: Compound, w: number): number {
  return compound === 'dry' ? 1 - 0.45 * Math.pow(Math.max(0, w), 1.5) : 0.86 + 0.14 * Math.min(1, w / 0.35);
}

/** Smooth wet-skill blend over w ∈ [0.1, 0.3] (no step at w = 0.2). */
export function wetSkillFactor(wetSkill: number, w: number): number {
  const t = Math.max(0, Math.min(1, (w - 0.1) / 0.2));
  return 1 + (wetSkill - 1) * t;
}

export function fT(car: CarConfig, compound: Compound, T: number): number {
  const c = car.tyres[compound];
  const th = car.tyres.thermal;
  return Math.max(th.fTFloor, 1 - th.fTPenalty * ((T - c.Topt_C) / c.Twidth_C) ** 2);
}

export function fW(car: CarConfig, compound: Compound, W: number): number {
  const c = car.tyres[compound];
  return Math.max(0.5, 1 - c.alphaW * W - c.betaW * Math.max(0, W - c.Wcliff) ** 2);
}

export interface CarGripInputs {
  compound: Compound;
  w: number;
  tyreTemp: number;
  wear: number;
  X: number;
  gripSkill: number;
  wetSkill: number;
}

/** S_car = μ_compound · wetSkillFactor · f_T · f_W · X · gripSkill */
export function sCar(car: CarConfig, g: CarGripInputs): number {
  return (
    muCompound(g.compound, g.w) *
    wetSkillFactor(g.wetSkill, g.w) *
    fT(car, g.compound, g.tyreTemp) *
    fW(car, g.compound, g.wear) *
    g.X *
    g.gripSkill
  );
}

export function massRef(car: CarConfig): number {
  return car.mass_dry_kg.value + 41;
}

/** Thermal difference equation for one lap; `fc` is the caution fraction of the lap. */
export function tyreTempNext(
  car: CarConfig,
  T: number,
  trackTemp: number,
  mode: Mode,
  mMid: number,
  heatCoeff: number,
  fc: number,
  noiseN: number,
): number {
  const th = car.tyres.thermal;
  const heat = car.modes[mode].heatFactor * (mMid / massRef(car)) * heatCoeff * (1 - fc + fc * th.cautionHeatFactor);
  return T + th.aHeat_C * heat - th.bCool * (T - trackTemp) + th.sigma_C * noiseN;
}

export function newTyreTemp(car: CarConfig, airTemp: number): number {
  return airTemp + car.tyres.thermal.newTyreOffset_C;
}

export interface WearInputs {
  compound: Compound;
  bY: number;
  wearMult: number;
  mMid: number;
  tyreTemp: number;
  mode: Mode;
  fc: number;
  w: number;
  Y: number;
}

/** Wear added over a full lap on one set (k_t). */
export function wearRate(car: CarConfig, i: WearInputs): number {
  const c = car.tyres[i.compound];
  const th = car.tyres.thermal;
  const wetPenalty = i.compound === 'wet' ? 1 + (c.dryWearPenalty ?? 0) * (1 - i.w) ** 2 : 1;
  return (
    c.kBase_per_lap *
    Math.exp(i.bY) *
    i.wearMult *
    (i.mMid / massRef(car)) *
    (1 + th.wearTempCoeff * Math.max(0, i.tyreTemp - c.Topt_C)) *
    car.modes[i.mode].wearFactor *
    (1 - i.fc + 0.25 * i.fc) *
    wetPenalty *
    i.Y
  );
}

export function punctureProb(car: CarConfig, W: number): number {
  const p = car.tyres.puncture;
  return 1 - Math.exp(-p.h0_per_lap * Math.exp(p.h1 * W));
}
