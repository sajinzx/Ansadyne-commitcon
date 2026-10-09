// M13 §13.1 — benchmark scenario families. Forced events are applied identically in all worlds
// (anchored to the B1 world), except F10-adv which is per world and reported unpaired.
import type { ModelBundle } from '../vehicle/model';

export interface FamilyEffects {
  id: string;
  paired: boolean;
  model?: ModelBundle;
  fixedDry?: boolean;
  trackTempOffset?: number;
  rainOnset?: boolean;
  cautionAtFraction?: number;
  cautionAfterFirstStop?: 'B1' | 'own';
  gaugeNoiseFactor?: number;
}

export const FAMILY_INFO: Record<string, string> = {
  F1: 'Calm dry: weather fixed dry, background caution × 0.5',
  F2: 'Early caution: forced at 15% of race time',
  F3: 'Mid caution: forced at 50% of race time',
  F4: 'Late caution: forced at 85% of race time',
  F5: 'Random cautions: defaults',
  F6: 'Rain onset: damp then wet at 30–70% of the race',
  F7: 'High wear: kBase × 1.5, track +8 °C',
  F8: 'Fuel stress: qBase × 1.04, gauge noise × 2',
  F9: 'Model mismatch: persistent-coefficient spreads × 3',
  F10: "Worst timing: caution one lap after B1's first stop (paired)",
  'F10-adv': "Worst timing per world: caution one lap after each world's own first stop (unpaired)",
};

function cloneModel(model: ModelBundle): ModelBundle {
  return { ...model, cfg: structuredClone(model.cfg) };
}

export function applyFamily(id: string, model: ModelBundle): FamilyEffects {
  switch (id) {
    case 'F1': {
      const m = cloneModel(model);
      m.cfg.race.caution.background_per_lap *= 0.5;
      return { id, paired: true, model: m, fixedDry: true };
    }
    case 'F2':
      return { id, paired: true, cautionAtFraction: 0.15 };
    case 'F3':
      return { id, paired: true, cautionAtFraction: 0.5 };
    case 'F4':
      return { id, paired: true, cautionAtFraction: 0.85 };
    case 'F5':
      return { id, paired: true };
    case 'F6':
      return { id, paired: true, rainOnset: true };
    case 'F7': {
      const m = cloneModel(model);
      m.cfg.car.tyres.dry.kBase_per_lap *= 1.5;
      m.cfg.car.tyres.wet.kBase_per_lap *= 1.5;
      return { id, paired: true, model: m, trackTempOffset: 8 };
    }
    case 'F8': {
      const m = cloneModel(model);
      m.cfg.car.fuel.qBase_kg_per_lap *= 1.04;
      m.cfg.car.fuel.gaugeNoise_kg *= 2;
      return { id, paired: true, model: m };
    }
    case 'F9': {
      const m = cloneModel(model);
      m.coeffSpread = 3;
      return { id, paired: true, model: m };
    }
    case 'F10':
      return { id, paired: true, cautionAfterFirstStop: 'B1' };
    case 'F10-adv':
      return { id, paired: false, cautionAfterFirstStop: 'own' };
    default:
      throw new Error(`unknown family ${id}`);
  }
}
