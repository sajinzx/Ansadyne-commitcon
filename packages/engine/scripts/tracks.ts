// Calibrate every circuit and print its key numbers (μ_peak, lap, sectors, top speed, pit loss).
//   pnpm tsx packages/engine/scripts/tracks.ts
import { defaultConfigs, defaultRunConfig, TRACK_IDS } from '@pitwall/shared';
import { buildModel } from '../src/vehicle/model';
import { pitDiagnostics } from '../src/sim/pit';
import { nowMs } from '../src/planner/timing';

for (const id of TRACK_IDS) {
  const t0 = nowMs();
  const m = buildModel(defaultConfigs(), defaultRunConfig({ trackId: id }));
  const ph = m.cal.reference;
  const pit = pitDiagnostics(m);
  console.log(
    `${id.padEnd(13)} L=${m.lapLength} μ=${m.cal.muPeak.toFixed(3)} lap=${ph.lapTime.toFixed(2)} target=${m.lapRef} sectors=${ph.sectorTimes.map((x) => x.toFixed(1)).join('/')} top=${m.cal.physics.topSpeed_kph.toFixed(0)} q=${m.cfg.car.fuel.qBase_kg_per_lap.toFixed(2)} kg/lap pit green=${pit.netGreen_s.toFixed(1)} caution=${pit.netCaution_s.toFixed(1)} build=${(nowMs() - t0).toFixed(0)}ms`,
  );
}
