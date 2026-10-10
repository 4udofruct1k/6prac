import { describe, expect, it } from 'vitest';
import { MATERIALS, getMaterial, kernelMaterial } from '../src/materials';
import {
  hugoniot,
  jcFractureStrain,
  jcYield,
  mgPressure,
  soundSpeed,
  T_ROOM,
} from '../src/materials/models';
import { MaterialDb } from '../src/materials/schema';

describe('база материалов (7.6)', () => {
  it('проходит схему, у каждого числа источник и статус', () => {
    expect(MATERIALS.length).toBeGreaterThanOrEqual(5);
    for (const m of MATERIALS) {
      expect(m.density.status).toMatch(/verified|check|tuned/);
      expect(m.eos.source).toBeTruthy();
    }
  });

  it('схема ловит ошибки', () => {
    const bad = structuredClone(getMaterial('copper_ofhc')) as Record<string, unknown>;
    (bad.density as Record<string, unknown>).source = 'нет такого';
    expect(MaterialDb.safeParse([bad]).success).toBe(false);
    expect(MaterialDb.safeParse([getMaterial('copper_ofhc'), getMaterial('copper_ofhc')]).success).toBe(false);
  });

  it('числа 7.1–7.3 перенесены без ошибок', () => {
    const cu = getMaterial('copper_ofhc');
    expect(cu.density.value).toBe(8.93);
    expect(cu.eos).toMatchObject({ C0: 3.94, s: 1.48, gamma0: 1.96 });
    expect(cu.strength).toMatchObject({ A: 0.09, B: 0.292, n: 0.31, C: 0.025, m: 1.09, Tm: 1356 });
    const st = getMaterial('steel_4340');
    expect(st.strength).toMatchObject({ A: 0.792, B: 0.51, n: 0.26, C: 0.014, m: 1.03, Tm: 1793 });
  });
});

describe('Джонсон–Кук (5.2, 5.5)', () => {
  const cu = kernelMaterial('copper_ofhc');

  it('кривая упрочнения: σy(ε̄p = 0,5) = A + B·0,5^n', () => {
    expect(jcYield(cu, 0, 1, T_ROOM)).toBeCloseTo(0.09, 12);
    expect(jcYield(cu, 0.5, 1, T_ROOM)).toBeCloseTo(0.09 + 0.292 * Math.pow(0.5, 0.31), 12);
  });

  it('скорость деформации и температура', () => {
    const base = jcYield(cu, 0.5, 1, T_ROOM);
    expect(jcYield(cu, 0.5, 1e3, T_ROOM) / base).toBeCloseTo(1 + 0.025 * Math.log(1e3), 12);
    const Thalf = T_ROOM + 0.5 * (1356 - T_ROOM);
    expect(jcYield(cu, 0.5, 1, Thalf) / base).toBeCloseTo(1 - Math.pow(0.5, 1.09), 12);
    expect(jcYield(cu, 0.5, 1, 1356)).toBe(0);
  });

  it('деформация разрушения при одноосном растяжении (σ* = 1/3)', () => {
    expect(jcFractureStrain(cu, 1 / 3, 1, T_ROOM)).toBeCloseTo(0.54 + 4.89 * Math.exp(-3.03 / 3), 12);
  });
});

describe('Ми–Грюнайзен (5.1)', () => {
  const cu = kernelMaterial('copper_ofhc');

  it('на ударной адиабате p(η, e_H) = ρ0·Us·up', () => {
    for (const up of [0.2, 1, 2, 3]) {
      const h = hugoniot(cu, up);
      // Скачок энергии Ренкина–Гюгонио: e_H = ½·p·(v0 − v) = ½·p·η/ρ0
      const eH = (0.5 * h.p * h.eta) / cu.rho0;
      expect(mgPressure(cu, 1 - h.eta, eH) / h.p).toBeCloseTo(1, 10);
    }
  });

  it('тест 12.1: симметричный удар медь по меди 4 км/с даёт ≈ 123 ГПа', () => {
    const h = hugoniot(cu, 2);
    expect(h.p).toBeCloseTo(123.2, 1);
  });

  it('скорость звука в покое: √((ρ0·C0² + 4/3·G)/ρ0)', () => {
    const c = soundSpeed(cu, 1, 0, true);
    expect(c).toBeCloseTo(Math.sqrt((8.93 * 3.94 ** 2 + (4 / 3) * 46) / 8.93), 12);
  });
});
