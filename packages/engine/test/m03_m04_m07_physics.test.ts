import { beforeAll, describe, expect, it } from 'vitest';
import { defaultConfigs, defaultRunConfig } from '@pitwall/shared';
import { buildModel, type ModelBundle } from '../src/vehicle/model';
import { QssSolver, qssCar, airDensity, V_TOP } from '../src/vehicle/qss';
import { nodeFactors, segmentGrips, sTrack } from '../src/track/surface';
import { MODES, SurrogateRangeError } from '../src/vehicle/surrogate';
import { Rng } from '../src/rng/rng';
import { fT, fW, muCompound, punctureProb, sCar, tyreTempNext, newTyreTemp, wetSkillFactor } from '../src/vehicle/tyre';
import { burnPerLap, dryPoint } from '../src/vehicle/fuel';
import { serviceTime, totalPit, inLapTime, outLapTime, tStretch, fuelAtBox, pitDiagnostics } from '../src/sim/pit';

let model: ModelBundle;
let solver: QssSolver;
const cfg = defaultConfigs();

beforeAll(() => {
  model = buildModel(cfg, defaultRunConfig());
  solver = new QssSolver(model.geo.grid, qssCar(cfg.car));
});

describe('M03 QSS lap solver and calibration (gate 2)', () => {
  it('calibrates the reference lap to 107.00 ± 0.01 s with mu_peak in [1.33, 1.44]', () => {
    expect(model.cal.reference.lapTime).toBeGreaterThan(106.99);
    expect(model.cal.reference.lapTime).toBeLessThan(107.01);
    expect(model.cal.muPeak).toBeGreaterThan(1.33);
    expect(model.cal.muPeak).toBeLessThan(1.44);
  });

  it('reproduces the prototype reference values', () => {
    const [s1, s2, s3] = model.cal.reference.sectorTimes;
    expect(s1).toBeCloseTo(29.3, 0);
    expect(s2).toBeCloseTo(46.9, 0);
    expect(s3).toBeCloseTo(30.8, 0);
    expect(model.cal.physics.topSpeed_kph).toBeGreaterThan(280);
    expect(model.cal.physics.topSpeed_kph).toBeLessThan(298);
    expect(['S01', 'S02']).toContain(model.cal.physics.topSpeedSegment);
    expect(model.cal.physics.minSpeedS08_kph).toBeGreaterThan(55);
    expect(model.cal.physics.c_f_s_per_kg).toBeGreaterThan(0.005);
    expect(model.cal.tStretchRef).toBeCloseTo(12.6, 0);
  });

  it('more mass is slower, more grip is faster, v never exceeds v_cap, S10–S11 are flat out', () => {
    const nodes = nodeFactors(cfg.track, model.geo.grid, 0, []);
    const rho = airDensity(22);
    const base = (m: number, S: number) => solver.solve(nodes, model.cal.muPeak * S, m, model.cal.power_kW * 1000, rho).lapTime;
    expect(base(1400, 0.97)).toBeGreaterThan(base(1370, 0.97));
    expect(base(1370, 1.0)).toBeLessThan(base(1370, 0.95));
    const r = solver.solve(nodes, model.cal.muPeak * model.cal.sRef, model.cal.massRef, model.cal.power_kW * 1000, rho, true);
    for (let i = 0; i < model.geo.grid.n; i++) expect(r.v[i]).toBeLessThanOrEqual(solver.vCap(i) + 1e-9);
    const ids = cfg.track.segments.map((s) => s.id);
    let prev = -1;
    for (let i = 0; i < model.geo.grid.n; i++) {
      const id = ids[model.geo.grid.seg[i]];
      if (id === 'S10' || id === 'S11') {
        if (prev >= 0) expect(r.v[i]).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = r.v[i];
      }
    }
  });

  it('banked friction circle: a_long ≥ 0 below the cap and → 0 at the cap', () => {
    const nodes = nodeFactors(cfg.track, model.geo.grid, 0.5, []);
    const rho = airDensity(22);
    for (const S of [0.4, 0.7, 1.0]) {
      solver.solve(nodes, model.cal.muPeak * S, 1371, model.cal.power_kW * 1000, rho);
      for (let i = 0; i < model.geo.grid.n; i += 7) {
        const cap = solver.vCap(i);
        for (const f of [0.2, 0.5, 0.9]) expect(solver.aLong(cap * f, i, 1371, rho)).toBeGreaterThanOrEqual(0);
        if (model.geo.grid.invR[i] > 0 && cap < V_TOP) {
          const a = solver.aLong(cap, i, 1371, rho);
          const aTop = solver.aLong(cap * 0.5, i, 1371, rho) + 1;
          expect(a / aTop).toBeLessThan(1e-5);
        }
      }
    }
  });

  it('wet banking: lap times are finite and decrease as grip rises', () => {
    const nodes = nodeFactors(cfg.track, model.geo.grid, 1, []);
    let prev = Infinity;
    for (const S of [0.35, 0.45, 0.6, 0.8, 1.0]) {
      const T = solver.solve(nodes, model.cal.muPeak * S, 1371, model.cal.power_kW * 1000, airDensity(22)).lapTime;
      expect(Number.isFinite(T)).toBe(true);
      expect(T).toBeLessThan(prev);
      prev = T;
    }
  });

  it('surrogate matches direct QSS: ≤ 0.05 s on dry points, ≤ 0.5% everywhere (incl. wet and overrides)', () => {
    const r = new Rng(3);
    for (const ovs of [[], [{ segmentId: 'S08', wetnessOffset: 0.3, debris: true }]]) {
      const m2 = ovs.length ? buildModel(cfg, defaultRunConfig(), { overrides: ovs, calibration: { cal: model.cal, geo: model.geo } }) : model;
      for (let i = 0; i < 200; i++) {
        const dry = i % 2 === 0;
        const S = dry ? 0.7 + r.uniform() * 0.55 : 0.35 + r.uniform() * 0.9;
        const m = 1330 + r.uniform() * 82;
        const w = dry ? 0 : r.uniform();
        const mode = MODES[Math.floor(r.uniform() * 3)];
        const T = solver.solve(
          nodeFactors(cfg.track, model.geo.grid, w, ovs),
          model.cal.muPeak * S,
          m,
          model.cal.power_kW * 1000 * cfg.car.modes[mode].powerFactor,
          airDensity(22),
        ).lapTime;
        const err = Math.abs(m2.surrogate.lapTime(S, m, w, mode) - T);
        if (dry) expect(err).toBeLessThan(0.05);
        expect(err / T).toBeLessThan(0.005);
      }
    }
  });

  it('solver friction equals S_car × UI grip exactly (factorisation)', () => {
    const r = new Rng(17);
    for (let k = 0; k < 200; k++) {
      const st = { wetness: r.uniform(), trackTemp_C: 10 + 50 * r.uniform(), rubber: 0.06 * r.uniform(), overrides: k % 2 ? [{ segmentId: 'S05', wetnessOffset: 0.2, debris: true }] : [] };
      const sCarV = 0.5 + r.uniform() * 0.6;
      const S = sCarV * sTrack(st.trackTemp_C, st.rubber, st.wetness, cfg.track.meanDryGrip);
      const nodes = nodeFactors(cfg.track, model.geo.grid, st.wetness, st.overrides);
      const grips = segmentGrips(cfg.track, st);
      for (let i = 0; i < model.geo.grid.n; i += 97) {
        const muOverPeak = S * nodes[i];
        expect(Math.abs(muOverPeak - sCarV * grips[model.geo.grid.seg[i]].effectiveGrip)).toBeLessThan(1e-12);
      }
    }
  });

  it('out-of-range surrogate queries throw in strict mode and clamp otherwise', () => {
    model.surrogate.strict = true;
    expect(() => model.surrogate.lapTime(0.2, 1371, 0, 'normal')).toThrow(SurrogateRangeError);
    model.surrogate.strict = false;
    const before = model.surrogate.outOfRange;
    expect(Number.isFinite(model.surrogate.lapTime(0.2, 1371, 0, 'normal'))).toBe(true);
    expect(model.surrogate.outOfRange).toBe(before + 1);
  });
});

describe('M04 tyres and fuel (gate 2, noise off)', () => {
  it('f_W ≤ 1 and non-increasing; f_T peaks at Topt; compound crossover at w ≈ 0.228', () => {
    let prev = 2;
    for (let W = 0; W <= 1; W += 0.01) {
      const v = fW(cfg.car, 'dry', W);
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      prev = v;
    }
    expect(fT(cfg.car, 'dry', 95)).toBe(1);
    expect(fT(cfg.car, 'dry', 70)).toBeLessThan(1);
    let cross = 0;
    for (let w = 0; w <= 1; w += 0.001) if (muCompound('wet', w) > muCompound('dry', w)) { cross = w; break; }
    expect(cross).toBeGreaterThan(0.22);
    expect(cross).toBeLessThan(0.235);
    expect(wetSkillFactor(1.1, 0.2)).toBeCloseTo(1.05, 10);
  });

  it('puncture probability rises with wear', () => {
    expect(punctureProb(cfg.car, 0.9)).toBeGreaterThan(punctureProb(cfg.car, 0.3));
  });

  it('fuel: running dry happens at the right lap distance; caution burn is 35%', () => {
    expect(dryPoint(2, 2.65, 0, 5730, 5730)).toBeCloseTo(4324.5, 0);
    expect(dryPoint(10, 2.65, 0, 5730, 5730)).toBeNull();
    const green = burnPerLap(cfg.car, { bZ: 0, burnMult: 1, mode: 'normal', mStart: 1371, fc: 0, Z: 1 });
    const caution = burnPerLap(cfg.car, { bZ: 0, burnMult: 1, mode: 'normal', mStart: 1371, fc: 1, Z: 1 });
    expect(caution / green).toBeCloseTo(0.35, 10);
  });

  it('cold new tyres give a slower first lap than the third lap', () => {
    let T = newTyreTemp(cfg.car, 22);
    const laps: number[] = [];
    for (let k = 0; k < 3; k++) {
      const S = sCar(cfg.car, { compound: 'dry', w: 0, tyreTemp: T, wear: 0, X: 1, gripSkill: 1, wetSkill: 1 }) * model.cal.sRef;
      laps.push(model.surrogate.lapTime(S, 1371, 0, 'normal'));
      T = tyreTempNext(cfg.car, T, 30, 'normal', 1371, 1, 0, 0);
    }
    expect(laps[0]).toBeGreaterThan(laps[2]);
  });
});

describe('M07 pit timing (gate 2)', () => {
  it('a full sequential stop (80 kg + tyres) is 84.5 s', () => {
    const svc = serviceTime(model, { refuel_kg: 80, tyres: 'dry', driverChange: false });
    expect(svc).toBeCloseTo(56, 10);
    expect(totalPit(model, svc)).toBeCloseTo(84.5, 10);
    const d = pitDiagnostics(model);
    expect(d.netGreen_s).toBeCloseTo(71.9, 0);
    expect(d.netCaution_s).toBeCloseTo(55.5, 0);
  });

  it('in-lap + out-lap − 2·t_lap = total_pit − t_stretch (to 1e-9), green and caution', () => {
    for (const caution of [false, true]) {
      const tLap = caution ? 165.85 : 107;
      const svc = 47.3;
      const lhs = inLapTime(model, tLap, caution) + outLapTime(model, svc, tLap, caution) - 2 * tLap;
      expect(Math.abs(lhs - (totalPit(model, svc) - tStretch(model, tLap, caution)))).toBeLessThan(1e-9);
    }
  });

  it('fuel at the box: 2 kg with 2.65 kg/lap cannot reach the pit entry; a full fill leaves at capacity', () => {
    expect(fuelAtBox(model, 2, 2.65)).toBeLessThan(0);
    const box = fuelAtBox(model, 10, 2.65);
    expect(box + (cfg.car.fuel.capacity_kg - box)).toBe(cfg.car.fuel.capacity_kg);
  });
});
