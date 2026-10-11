import { describe, expect, it } from 'vitest';
import { kernelMaterial } from '../src/materials';
import { T_ROOM } from '../src/materials/models';
import { taylorScene } from '../src/scene/scenes';
import { fixedPointScales, kineticVelocityBound, particleMass, prepareScene } from '../src/scene/scene';
import { benchSceneSpec, demoScene } from '../src/scene/scenes';
import { GRID_PAD, NODE_MASS_MARGIN, PLANE, tagBody, tagField, tagMaterial } from '../src/sim/layout';

describe('подготовка сцены', () => {
  it('плоский режим: V0 = Δx², J = 1, T = T_room, масса = ρ0·V0', () => {
    const s = demoScene({ across: 10 });
    const mat = kernelMaterial('demo_elastomer');
    for (let i = 0; i < s.n; i++) {
      expect(s.planes[PLANE.VOL0 * s.n + i]).toBe(Math.fround(s.dx * s.dx));
      expect(s.planes[PLANE.J * s.n + i]).toBe(1);
      expect(s.planes[PLANE.T * s.n + i]).toBe(T_ROOM);
    }
    expect(particleMass(mat, s.dx * s.dx)).toBeCloseTo(1.1 * s.dx * s.dx, 12);
  });

  it('осесимметричный режим: V0 = Δx²·r (кольцо на радиан)', () => {
    const s = taylorScene('copper_ofhc', 0.19, 25.4, 0.5);
    for (let i = 0; i < s.n; i += 7) {
      const r = s.planes[PLANE.X * s.n + i];
      expect(s.planes[PLANE.VOL0 * s.n + i]).toBeCloseTo(0.25 * r, 5);
    }
  });

  it('метка частицы хранит материал, тело и поле контакта', () => {
    const s = prepareScene(benchSceneSpec(8_000));
    const tags = new Uint32Array(s.planes.buffer, PLANE.TAG * s.n * 4, s.n);
    expect(new Set(Array.from(tags, tagBody))).toEqual(new Set([0, 1]));
    expect(new Set(Array.from(tags, tagField))).toEqual(new Set([0, 1]));
    expect(new Set(Array.from(tags, tagMaterial))).toEqual(new Set([0]));
  });

  it('сетка: узел (0,0) на GRID_PAD ячеек левее и ниже области', () => {
    const s = demoScene({ across: 20 });
    expect(s.origin[0]).toBeCloseTo(-GRID_PAD * s.h, 12);
    expect(s.origin[1]).toBeCloseTo(-GRID_PAD * s.h, 12);
    expect(s.origin[0] + (s.gx - 1 - GRID_PAD) * s.h).toBeGreaterThanOrEqual(160 - 1e-9);
  });

  it('фиксированная точка: узел с массой ppc²·m и запасом на скучивание помещается в 2^30', () => {
    const { massScale, momScale, kScale } = fixedPointScales(2, 2, 1.5, 5.7, 0.5);
    const nodeMass = 4 * 2 * NODE_MASS_MARGIN;
    expect(NODE_MASS_MARGIN).toBeGreaterThanOrEqual(16);
    expect(nodeMass * massScale).toBeCloseTo(2 ** 30, 0);
    expect(nodeMass * (1.5 + 3 * 5.7) * 4 * momScale).toBeCloseTo(2 ** 30, 0);
    // K — без импульса напряжений: граница по скоростям частиц, а не по скорости звука
    expect(kineticVelocityBound(1.5, 5.7)).toBeCloseTo(3 * 1.5 + 0.05 * 5.7, 12);
    expect(nodeMass * kineticVelocityBound(1.5, 5.7) ** 2 * 2 * kScale).toBeCloseTo(2 ** 30, 0);
  });

  it('начальный Δt положителен и не больше Куранта по скорости звука', () => {
    const s = taylorScene('steel_4340', 0.2, 25.4, 0.5);
    expect(s.dt0).toBeGreaterThan(0);
    expect(s.dt0).toBeLessThan((0.3 * 0.5) / 5.3);
  });
});
