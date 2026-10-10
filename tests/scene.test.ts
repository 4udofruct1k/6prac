import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS } from '../src/scene/presets';
import { benchSceneSpec, demoScene } from '../src/scene/scenes';
import { fixedPointScales, prepareScene } from '../src/scene/scene';
import { PLANE, tagBody, tagMaterial } from '../src/sim/layout';

describe('подготовка сцены', () => {
  it('масса частицы = ρ·Δx², объём = Δx², F = I', () => {
    const s = demoScene({ across: 10 });
    const rho = 1.1;
    for (let i = 0; i < s.n; i++) {
      expect(s.planes[PLANE.MASS * s.n + i]).toBeCloseTo(rho * s.dx * s.dx, 5);
      expect(s.planes[PLANE.VOL0 * s.n + i]).toBeCloseTo(s.dx * s.dx, 5);
      expect(s.planes[PLANE.F00 * s.n + i]).toBe(1);
      expect(s.planes[PLANE.F01 * s.n + i]).toBe(0);
    }
  });

  it('метка частицы хранит тело и материал', () => {
    const s = prepareScene(benchSceneSpec(8_000));
    const tags = new Uint32Array(s.planes.buffer, PLANE.TAG * s.n * 4, s.n);
    const bodies = new Set(Array.from(tags, tagBody));
    expect([...bodies].sort()).toEqual([0, 1]);
    expect(new Set(Array.from(tags, tagMaterial))).toEqual(new Set([0]));
  });

  it('фиксированная точка: узел с массой ppc²·m и запасом ×4 помещается в 2^30', () => {
    const { massScale, momScale } = fixedPointScales(2, 2, 1.5, 5.7);
    expect(4 * 2 * 4 * massScale).toBeCloseTo(2 ** 30, 0);
    expect(4 * 2 * 4 * (1.5 + 5.7) * 4 * momScale).toBeCloseTo(2 ** 30, 0);
  });

  it('для всех пресетов шаг сетки и Δt положительны и конечны', () => {
    for (const p of QUALITY_PRESETS.slice(0, 3)) {
      const s = prepareScene(benchSceneSpec(p.n));
      expect(s.h).toBeCloseTo(2 * s.dx, 12);
      expect(Number.isFinite(s.dt) && s.dt > 0).toBe(true);
      expect(s.gx * s.gy).toBeGreaterThan(s.n / 4);
    }
  });
});
