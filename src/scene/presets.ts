// Пресеты качества и шаг по времени — разделы 2.1, 2.2, 4.3 спеки.
// Единицы ядра (4.6): мм, мкс, мг → г/см³, км/с, ГПа, Дж.

export type PresetId = 'min' | 'phone' | 'pc_mid' | 'pc_high' | 'pc_ultra';

export interface QualityPreset {
  id: PresetId;
  label: string;
  /** Целевое число частиц N (стартовая цель; финальные числа фиксируются бенчмарком M0). */
  n: number;
  where: string;
}

/** Пример сцены из 2.1: 120 × 250 мм. По ней в спеке посчитан Δx для каждого пресета. */
export const REFERENCE_SCENE_MM = { w: 120, h: 250 } as const;

export const QUALITY_PRESETS: readonly QualityPreset[] = [
  { id: 'min', label: 'Минимум', n: 8_000, where: 'старые телефоны' },
  { id: 'phone', label: 'Телефон', n: 25_000, where: 'Android' },
  { id: 'pc_mid', label: 'ПК-Средний', n: 120_000, where: 'ПК' },
  { id: 'pc_high', label: 'ПК-Высокий', n: 400_000, where: 'ПК, эталон для испытаний' },
  { id: 'pc_ultra', label: 'ПК-Ультра', n: 1_000_000, where: 'ПК, тесты сходимости' },
];

/** Шаг частиц Δx = √(A/N), мм. */
export function particleSpacing(areaMm2: number, n: number): number {
  return Math.sqrt(areaMm2 / n);
}

/** Коэффициент Куранта (4.3). */
export const C_CFL = 0.3;

/**
 * Δt = C_CFL · Δx / max(c_p + |v|), мкс.
 * Δx — шаг частиц, как в численном примере 2.2 (Δx = 0,5 мм, c ≈ 6 км/с, v = 2 км/с → ≈ 20 нс).
 */
export function cflTimeStep(dxMm: number, maxSignalKmS: number): number {
  return (C_CFL * dxMm) / maxSignalKmS;
}

/** Продольная скорость звука c_p = √((K + 4/3·G)/ρ), км/с. K, G в ГПа, ρ в г/см³. */
export function longitudinalSoundSpeed(K: number, G: number, rho: number): number {
  return Math.sqrt((K + (4 / 3) * G) / rho);
}
