import { describe, expect, it } from 'vitest';
import {
  QUALITY_PRESETS,
  REFERENCE_SCENE_MM,
  cflTimeStep,
  longitudinalSoundSpeed,
  particleSpacing,
} from '../src/scene/presets';
import { STEEL_4340_ELASTIC } from '../src/scene/materials';
import { benchScene } from '../src/scene/scenes';
import { PLANE } from '../src/sim/layout';

describe('пресеты качества (2.1)', () => {
  it('Δx для сцены 120×250 мм совпадает с таблицей спеки', () => {
    const area = REFERENCE_SCENE_MM.w * REFERENCE_SCENE_MM.h;
    const expected: Record<string, number> = { min: 1.9, phone: 1.1, pc_mid: 0.5, pc_high: 0.27, pc_ultra: 0.17 };
    for (const p of QUALITY_PRESETS) {
      const digits = expected[p.id] >= 1 ? 1 : 2;
      expect(particleSpacing(area, p.n).toFixed(digits)).toBe(expected[p.id].toFixed(digits));
    }
  });

  it('сцена бенчмарка содержит ≈ N частиц', () => {
    for (const p of QUALITY_PRESETS.slice(0, 3)) {
      const s = benchScene(p.n);
      expect(Math.abs(s.n - p.n) / p.n).toBeLessThan(0.02);
    }
  });

  it('тела сцены бенчмарка не перекрываются', () => {
    const s = benchScene(8_000);
    const seen = new Set<string>();
    for (let i = 0; i < s.n; i++) {
      const key = `${s.planes[PLANE.X * s.n + i].toFixed(4)},${s.planes[PLANE.Y * s.n + i].toFixed(4)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe('шаг по времени (2.2, 4.3)', () => {
  it('пример спеки: Δx = 0,5 мм, c ≈ 6 км/с, v = 2 км/с → около 20 нс', () => {
    const dt = cflTimeStep(0.5, 6 + 2);
    expect(dt * 1000).toBeCloseTo(18.75, 6);
  });

  it('скорость звука стали 4340 ≈ 5,7 км/с', () => {
    const m = STEEL_4340_ELASTIC;
    expect(longitudinalSoundSpeed(m.K, m.G, m.density)).toBeCloseTo(5.74, 2);
  });
});
