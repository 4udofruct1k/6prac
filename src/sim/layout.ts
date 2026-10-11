// Раскладка данных ядра M1.
//
// Частицы: SoA в одном буфере — плоскость на поле, поле k частицы i лежит в [k·n + i]. Один
// storage-биндинг на все поля держит каждое ядро в лимите режима совместимости WebGPU
// (maxStorageBuffersPerShaderStage = 4), а плоскости X/Y/VIZ/TAG подключаются вершинными буферами рендера.
//
// Состояние частицы (4.2): положение, скорость и APIC-матрица C (пишутся на кадр/чтение), якобиан J,
// девиатор напряжений (xx, yy, xy; zz/θθ = −(xx + yy)), ε̄p, удельная внутренняя энергия e, температура T,
// повреждение D, начальный объём V0. Давление не хранится — его даёт EOS из J и e.

export const PLANE = {
  X: 0,
  Y: 1,
  VX: 2,
  VY: 3,
  C00: 4,
  C01: 5,
  C10: 6,
  C11: 7,
  J: 8,
  SXX: 9,
  SYY: 10,
  SXY: 11,
  /** ε̄p — эквивалентная пластическая деформация */
  EPS: 12,
  /** Удельная внутренняя энергия, (км/с)² = Дж/мг */
  E: 13,
  /** Температура, K */
  T: 14,
  /** Повреждение 0…1 */
  D: 15,
  /** Начальный объём, мм³ (плоский режим — на мм толщины, осесимметричный — на радиан) */
  VOL0: 16,
  /** Скаляр для визуализации, пишется на шаге с aux по VizMode */
  VIZ: 17,
  /** u32: материал | тело << 8 | поле << 16 | флаги */
  TAG: 18,
} as const;

export const PLANE_COUNT = 19;

/** Плоскости, которые шаг трогает в режиме l2 (кроме VOL0 — только в осесимметричном режиме). */
export const HOT_PLANES = [
  PLANE.X,
  PLANE.Y,
  PLANE.J,
  PLANE.SXX,
  PLANE.SYY,
  PLANE.SXY,
  PLANE.EPS,
  PLANE.E,
  PLANE.T,
  PLANE.D,
  PLANE.TAG,
] as const;

export const TAG_MATERIAL_MASK = 0xff;
export const TAG_BODY_SHIFT = 8;
export const TAG_FIELD_SHIFT = 16;
/** Частица ушла за границу области: не участвует в счёте, её энергия — «ушедшая» (4.3, шаг 6) */
export const TAG_REMOVED = 1 << 24;

export function packTag(material: number, body: number, field: number): number {
  return (material & 0xff) | ((body & 0xff) << TAG_BODY_SHIFT) | ((field & 1) << TAG_FIELD_SHIFT);
}

export function tagMaterial(tag: number): number {
  return tag & TAG_MATERIAL_MASK;
}

export function tagBody(tag: number): number {
  return (tag >>> TAG_BODY_SHIFT) & 0xff;
}

export function tagField(tag: number): number {
  return (tag >>> TAG_FIELD_SHIFT) & 1;
}

export function tagRemoved(tag: number): boolean {
  return (tag & TAG_REMOVED) !== 0;
}

/**
 * Как ядро хранит частицы между шагами.
 * full — каждый шаг пишет все поля; l2 — шаг трогает только «горячие» плоскости, а v, C и VIZ пишет
 * на шаге перед кадром или чтением. Цель l2 — уложить рабочий набор в кэш L2 видеокарты.
 */
export type StorageMode = 'full' | 'l2';

export const STORAGE_MODES: Record<StorageMode, { label: string; bytesPerParticle: number }> = {
  full: { label: 'Полный', bytesPerParticle: PLANE_COUNT * 4 },
  l2: { label: 'L2', bytesPerParticle: HOT_PLANES.length * 4 },
};

/** По умолчанию — l2: на ПК и телефоне быстрее полного при побитово том же результате (замеры M0). */
export const DEFAULT_STORAGE_MODE: StorageMode = 'l2';

/** Два поля скоростей на узле (4.5): 0 — мишень, 1 — снаряд. */
export const FIELDS = 2;

/**
 * Накопители P2G на узел и поле: масса, импульс x/y (с толчком напряжений), толчок x/y, кинетическая
 * энергия частиц (для потерь переноса), «градиент» массы x/y (для нормали контакта).
 */
export const GRID_ACC_PER_FIELD = 8;

/** Скоростей сетки на узел: v0x, v0y, v1x, v1y и удельная потеря энергии λ (тепло частицам). */
export const GRID_V_STRIDE = 5;

/** Байт на узел сетки: i32-накопители двух полей + скорости и λ. */
export const BYTES_PER_GRID_NODE = FIELDS * GRID_ACC_PER_FIELD * 4 + GRID_V_STRIDE * 4;

/** Слоёв узлов за границей области — чтобы шаблон 3×3 частицы у края целиком лежал в сетке. */
export const GRID_PAD = 3;

export const MAX_MATERIALS = 8;

export const WORKGROUP_SIZE = 64;

/** Слова буфера состояния шага (u32; float хранятся битами). */
export const STEP = {
  DT_CUR: 0,
  DT_NEXT: 1,
  TIME: 2,
  /** Компенсация Кэхэна для суммы времени */
  TIME_C: 3,
  /** Максимум скорости сигнала по частицам (биты f32, atomicMax) — для Δt следующего шага */
  MAX_SIGNAL: 4,
  /** Бит 0: накопитель узла подошёл к пределу i32 */
  FLAGS: 5,
  STEPS: 6,
  REMOVED: 7,
} as const;
export const STEP_WORDS = 8;

/** Граничные условия стороны области. */
export enum Bc {
  /** Свободная: частицы за краем удаляются */
  Open = 0,
  /** Жёсткая стенка со скольжением: материал не уходит наружу, отрыв разрешён */
  Wall = 1,
  /** Плоскость симметрии / ось: нормальная скорость = 0 */
  Symmetry = 2,
}

export enum VizMode {
  Speed = 0,
  Pressure = 1,
  Temperature = 2,
  PlasticStrain = 3,
  Damage = 4,
  VonMises = 5,
  Body = 6,
}

/** Порог предупреждения о переполнении i32 на узле сетки (половина диапазона). */
export const FIXED_POINT_GUARD = 2 ** 30;

/**
 * Во сколько раз масса узла может превысить номинальную (ppcAxis² частиц). Кроме сжатия (до ×1,5–2 при
 * сотнях ГПа) частицы MPM скучиваются при больших сдвигах: в полосе сдвига они сходятся вдоль течения, хотя
 * J ≈ 1. В голове эродирующего стержня сцены бенчмарка на «ПК-Среднем» пик ×4,7 к 50 мкс, дальше ×3–4,3
 * до 130 мкс. Запас ×16 — вчетверо над пиком; каждое удвоение запаса стоит бит точности.
 */
export const NODE_MASS_MARGIN = 16;
