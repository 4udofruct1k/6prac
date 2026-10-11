// База материалов (7.6): JSON + проверка схемой при загрузке + перевод в параметры ядра.

import raw from './db.json';
import { DamageModel, SpallModel, StrengthModel, type KernelMaterial } from './models';
import { MaterialDb, paramValue, type MaterialRecord } from './schema';

export type { MaterialRecord } from './schema';

/** Все материалы базы; схема проверяется при импорте — ошибка в JSON падает сразу. */
export const MATERIALS: readonly MaterialRecord[] = MaterialDb.parse(raw);

export function getMaterial(id: string): MaterialRecord {
  const m = MATERIALS.find((x) => x.id === id);
  if (!m) throw new Error(`Материал ${id} не найден в базе`);
  return m;
}

/** Запись базы → параметры ядра. cp: Дж/(кг·K) → Дж/(мг·K). */
export function toKernel(rec: MaterialRecord): KernelMaterial {
  const st = rec.strength;
  const jc =
    st.model === 'johnson_cook'
      ? { A: st.A, B: st.B, n: st.n, C: st.C, m: st.m, Tm: st.Tm }
      : { A: 0, B: 0, n: 1, C: 0, m: 1, Tm: 1e6 };
  return {
    rho0: rec.density.value,
    C0: rec.eos.C0,
    s: rec.eos.s,
    gamma0: rec.eos.gamma0,
    G: rec.elastic.G,
    ...jc,
    cp: rec.thermal.cp * 1e-6,
    beta: rec.thermal.beta,
    D: rec.damage.model === 'jc_fracture' ? rec.damage.D : [0, 0, 0, 0, 0],
    strength:
      st.model === 'johnson_cook'
        ? StrengthModel.JohnsonCook
        : st.model === 'elastic'
          ? StrengthModel.Elastic
          : StrengthModel.None,
    damage: rec.damage.model === 'jc_fracture' ? DamageModel.JohnsonCook : DamageModel.None,
    ...(rec.spall.model === 'porosity'
      ? {
          spall: SpallModel.Porosity,
          phi0: paramValue(rec.spall.phi0),
          ysat: paramValue(rec.spall.Y_sat),
          etaV: paramValue(rec.spall.eta),
          phiF: paramValue(rec.spall.phi_f),
          deltaC: rec.spall.delta_c.value,
        }
      : { spall: SpallModel.None, phi0: 0, ysat: 0, etaV: 1, phiF: 1, deltaC: 1e30 }),
  };
}

export function kernelMaterial(id: string): KernelMaterial {
  return toKernel(getMaterial(id));
}
