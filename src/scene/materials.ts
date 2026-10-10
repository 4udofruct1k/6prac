// Упругие материалы для M0. Полная база (7.6) с EOS, Джонсоном–Куком и валидатором — веха M1.
// Каждое число несёт источник и статус (принцип 0).

export type ParamStatus = 'verified' | 'check' | 'tuned';

export interface ElasticMaterial {
  id: string;
  name: string;
  /** г/см³ */
  density: number;
  /** Модуль объёмного сжатия, ГПа */
  K: number;
  /** Модуль сдвига, ГПа */
  G: number;
  source: string;
  status: ParamStatus;
  /** Пояснение к статусу, если статусы полей различаются */
  note?: string;
  color: string;
}

/** Сталь 4340: ρ, G — Batra (Dyna2D), 7.2; K = 157 ГПа — из примера 8.4, в таблицах 7.x не сверен. */
export const STEEL_4340_ELASTIC: ElasticMaterial = {
  id: 'steel_4340_elastic',
  name: 'Сталь 4340 (только упругость)',
  density: 7.84,
  K: 157,
  G: 76,
  source: 'batra',
  status: 'check',
  note: 'ρ и G — verified (7.2); K = 157 ГПа — check (8.4)',
  color: '#8A93A6',
};

/**
 * Мягкий эластомер для демо M0: виден отскок и колебания блока.
 * Не из базы материалов; подобран под картинку (E ≈ 10 МПа, ν = 0,45).
 */
export const DEMO_ELASTOMER: ElasticMaterial = {
  id: 'demo_elastomer',
  name: 'Демо-эластомер',
  density: 1.1,
  K: 0.0333,
  G: 0.00345,
  source: 'M0 demo',
  status: 'tuned',
  color: '#E0A04A',
};

/** Параметры Ламе для неогуковой модели: λ = K − 2G/3, μ = G. */
export function lame(m: ElasticMaterial): { lambda: number; mu: number } {
  return { lambda: m.K - (2 / 3) * m.G, mu: m.G };
}
