// Раскладка данных частиц: SoA в одном буфере — плоскость на поле, поле k частицы i лежит в [k·n + i].
// Один storage-биндинг на все поля держит каждое ядро в лимите режима совместимости
// WebGPU (maxStorageBuffersPerShaderStage = 4), а плоскости X/Y/VIZ/TAG сразу
// подключаются вершинными буферами рендера по смещению.

export const PLANE = {
  X: 0,
  Y: 1,
  VX: 2,
  VY: 3,
  C00: 4,
  C01: 5,
  C10: 6,
  C11: 7,
  F00: 8,
  F01: 9,
  F10: 10,
  F11: 11,
  MASS: 12,
  VOL0: 13,
  /** Скаляр для визуализации, пишется в G2P по VizMode */
  VIZ: 14,
  /** u32: (bodyId << 16) | materialIndex */
  TAG: 15,
} as const;

export const PLANE_COUNT = 16;

/**
 * Как ядро хранит частицы между шагами.
 * full — каждый шаг пишет все поля; l2 — шаг трогает только x, F и метку (7 плоскостей из 16),
 * v, C и VIZ пишутся на шаге перед кадром или чтением, масса и объём берутся из материала и Δx.
 * Цель l2 — уложить рабочий набор частиц в кэш L2 видеокарты.
 */
export type StorageMode = 'full' | 'l2';

export const STORAGE_MODES: Record<StorageMode, { label: string; bytesPerParticle: number }> = {
  full: { label: 'Полный', bytesPerParticle: PLANE_COUNT * 4 },
  l2: { label: 'L2', bytesPerParticle: 7 * 4 },
};

/** По умолчанию — l2: на ПК с NVIDIA Blackwell быстрее полного на 2–30 % при побитово том же результате (M0). */
export const DEFAULT_STORAGE_MODE: StorageMode = 'l2';

/** Байт на узел сетки: три i32-атомика и скорость vec2f. */
export const BYTES_PER_GRID_NODE = 3 * 4 + 8;

export const MAX_MATERIALS = 8;

export const WORKGROUP_SIZE = 64;

export enum VizMode {
  Speed = 0,
  Pressure = 1,
  Body = 2,
}

/** Порог предупреждения о переполнении i32 на узле сетки (половина диапазона). */
export const FIXED_POINT_GUARD = 2 ** 30;

export function packTag(body: number, material: number): number {
  return ((body & 0xffff) << 16) | (material & 0xffff);
}

export function tagBody(tag: number): number {
  return tag >>> 16;
}

export function tagMaterial(tag: number): number {
  return tag & 0xffff;
}
