// Схема записи материала (формат 7.6). Числа — во внутренних единицах ядра (4.6):
// г/см³, км/с, ГПа; температура в K, теплоёмкость cp — в Дж/(кг·K), как в примере 7.6.

import { z } from 'zod';
import { SOURCES } from './sources';

export const Status = z.enum(['verified', 'check', 'tuned']);
export type Status = z.infer<typeof Status>;

const sourced = {
  source: z.string().refine((s) => s in SOURCES, { message: 'источник не найден в sources.ts' }),
  status: Status,
  note: z.string().optional(),
};

const positive = z.number().positive();

export const MaterialRecord = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string(),
  class: z.enum(['metal', 'elastomer', 'fluid']),
  density: z.object({ value: positive, unit: z.literal('g/cm3'), ...sourced }),
  elastic: z.object({ G: z.number().nonnegative(), unit: z.literal('GPa'), ...sourced }),
  eos: z.object({
    model: z.literal('mie_gruneisen'),
    /** км/с */
    C0: positive,
    s: z.number().nonnegative(),
    gamma0: z.number().nonnegative(),
    ...sourced,
  }),
  strength: z.discriminatedUnion('model', [
    z.object({
      model: z.literal('johnson_cook'),
      /** ГПа */
      A: positive,
      B: z.number().nonnegative(),
      n: positive,
      C: z.number().nonnegative(),
      m: positive,
      /** K */
      Tm: positive,
      ...sourced,
    }),
    z.object({ model: z.literal('elastic'), ...sourced }),
    z.object({ model: z.literal('none'), ...sourced }),
  ]),
  damage: z.discriminatedUnion('model', [
    z.object({ model: z.literal('jc_fracture'), D: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]), ...sourced }),
    z.object({ model: z.literal('none') }),
  ]),
  /** Порог откола p_min, ГПа (отрицательный); null — откол по давлению не моделируется */
  spall: z.object({ p_min: z.number().negative().nullable(), source: sourced.source.optional(), status: Status }),
  thermal: z.object({
    /** Дж/(кг·K) */
    cp: positive,
    /** Доля пластической работы в тепло (Тейлор–Куинни) */
    beta: z.number().min(0).max(1),
    ...sourced,
  }),
  visual: z.object({ color: z.string().regex(/^#[0-9A-Fa-f]{6}$/) }),
});

export type MaterialRecord = z.infer<typeof MaterialRecord>;

export const MaterialDb = z.array(MaterialRecord).superRefine((list, ctx) => {
  const seen = new Set<string>();
  for (const m of list) {
    if (seen.has(m.id)) ctx.addIssue({ code: 'custom', message: `повтор id ${m.id}` });
    seen.add(m.id);
  }
});
