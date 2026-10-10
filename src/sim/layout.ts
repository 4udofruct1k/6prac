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
