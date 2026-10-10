// Сценарии гейта M1 (разделы 12 и 14): что считается, что меряется и с чем сравнивается.
// Метрики считаются по снимку частиц, поэтому одинаковы для CPU-эталона и GPU.

import { kernelMaterial } from '../materials';
import { hugoniot, type KernelMaterial } from '../materials/models';
import { REFERENCE_SCENE_MM, particleSpacing, QUALITY_PRESETS } from '../scene/presets';
import { prepareScene, type PreparedScene } from '../scene/scene';
import { taylorScene } from '../scene/scenes';
import { particlePressure } from '../sim/diagnostics';
import { Bc, PLANE, tagBody, tagRemoved } from '../sim/layout';
import type { Engine, Snapshot } from './engine';

export type GateTestId = '12.1' | '12.2' | '12.5' | '12.7' | '12.10';
export type GatePresetId = 'pc_high' | 'phone';

export interface GatePreset {
  id: GatePresetId;
  label: string;
  /** Шаг частиц пресета на эталонной сцене 2.1, мм */
  dx: number;
  /** «Телефон» — регрессия с удвоенным допуском (12) */
  toleranceScale: number;
}

function presetDx(id: GatePresetId): number {
  const p = QUALITY_PRESETS.find((q) => q.id === id)!;
  return particleSpacing(REFERENCE_SCENE_MM.w * REFERENCE_SCENE_MM.h, p.n);
}

export const GATE_PRESETS: Record<GatePresetId, GatePreset> = {
  pc_high: { id: 'pc_high', label: 'ПК-Высокий', dx: presetDx('pc_high'), toleranceScale: 1 },
  phone: { id: 'phone', label: 'Телефон', dx: presetDx('phone'), toleranceScale: 2 },
};

export interface CaseOutcome {
  /** Измеренное значение и эталон, в единицах unit */
  value: number;
  expected: number;
  unit: string;
  /** Отклонение и допуск: в процентах или в Δx (errorUnit) */
  error: number;
  tolerance: number;
  errorUnit: '%' | 'Δx' | 'шт.';
  passed: boolean;
  details?: Record<string, number>;
}

export interface MeasureContext {
  dx: number;
  toleranceScale: number;
  signal?: AbortSignal;
}

export interface GateCase {
  id: string;
  test: '12.1' | '12.5' | '12.7';
  label: string;
  /** Откуда эталон */
  reference: string;
  build(dx: number): PreparedScene;
  measure(engine: Engine, ctx: MeasureContext): Promise<CaseOutcome>;
}

function relOutcome(value: number, expected: number, unit: string, tolPct: number, details?: Record<string, number>): CaseOutcome {
  const error = (value / expected - 1) * 100;
  return { value, expected, unit, error, tolerance: tolPct, errorUnit: '%', passed: Math.abs(error) <= tolPct, details };
}

function initialY(engine: Engine, i: number): number {
  return engine.scene.planes[PLANE.Y * engine.scene.n + i];
}

// ---------- 12.1: плоский удар медь по меди, 4 км/с ----------

export const PLATE_IMPACT_V = 4;
/** Толщины в шагах частиц: геометрия масштабируется с Δx, число частиц на тело одно на любом пресете. */
const PLATE_FLYER_DX = 40;
const PLATE_TARGET_DX = 80;

/**
 * Одномерный удар (lockX, стенки симметрии по бокам): медная пластина 40Δx налетает на мишень 80Δx.
 * Одно поле — тела сварены, как в 1D-постановке; плато меряется до прихода разгрузки с тыла ударника.
 */
export function plateImpactScene(dx: number, material = 'copper_ofhc', v = PLATE_IMPACT_V): PreparedScene {
  const h = 2 * dx;
  const Lt = PLATE_TARGET_DX * dx;
  const Lf = PLATE_FLYER_DX * dx;
  return prepareScene({
    mode: 'plane',
    domain: { xmin: 0, xmax: 2 * h, ymin: -10 * dx, ymax: Lt + Lf + 10 * dx },
    dx,
    lockX: true,
    bodies: [
      { rect: { x0: 0, y0: 0, x1: 2 * h, y1: Lt }, material, velocity: [0, 0], bodyId: 0, field: 0 },
      { rect: { x0: 0, y0: Lt, x1: 2 * h, y1: Lt + Lf }, material, velocity: [0, -v], bodyId: 1, field: 0 },
    ],
    bc: { left: Bc.Symmetry, right: Bc.Symmetry, bottom: Bc.Open, top: Bc.Open },
  });
}

/** Плато давления в мишени между фронтом и контактом, с отступом 4h от каждого, ГПа. */
export function shockPlateau(scene: PreparedScene, snap: Snapshot, pRef: number): { mean: number; samples: number } {
  const { n } = snap;
  const ys = (i: number) => snap.planes[PLANE.Y * n + i];
  let front = Infinity;
  let contact = Infinity;
  for (let i = 0; i < n; i++) {
    if (tagRemoved(snap.tags[i])) continue;
    if (tagBody(snap.tags[i]) === 1) contact = Math.min(contact, ys(i));
    else if (particlePressure(scene, snap, i) > 0.5 * pRef) front = Math.min(front, ys(i));
  }
  const pad = 4 * scene.h;
  let sum = 0;
  let samples = 0;
  for (let i = 0; i < n; i++) {
    if (tagRemoved(snap.tags[i]) || tagBody(snap.tags[i]) !== 0) continue;
    const y = ys(i);
    if (y > front + pad && y < contact - pad) {
      sum += particlePressure(scene, snap, i);
      samples++;
    }
  }
  return { mean: samples ? sum / samples : NaN, samples };
}

const plateCase: GateCase = {
  id: 'plate-cu-4',
  test: '12.1',
  label: 'Плоский удар медь по меди, 4 км/с',
  reference: 'p = ρ0(C0 + s·up)·up, up = v/2; параметры меди из базы (7.3)',
  build: (dx) => plateImpactScene(dx),
  async measure(engine, { dx, toleranceScale }) {
    const mat = kernelMaterial('copper_ofhc');
    const { Us, p } = hugoniot(mat, PLATE_IMPACT_V / 2);
    // Ударная волна прошла ударник не до конца: разгрузка с его тыла ещё не дошла до контакта
    await engine.runTo((1.2 * PLATE_FLYER_DX * dx) / Us);
    const snap = await engine.snapshot();
    const { mean, samples } = shockPlateau(engine.scene, snap, p);
    return relOutcome(mean, p, 'ГПа', 3 * toleranceScale, { samples, t: snap.time });
  },
};

// ---------- 12.5: цилиндр Тейлора, Johnson & Cook 1983, рис. 9 ----------

export interface TaylorRef {
  material: string;
  /** Скорость удара, км/с */
  v: number;
  /** Начальная длина, мм; диаметр 7,62 мм у всех */
  L0: number;
  /** Длина после удара L/L0 — опыт (рис. 9) */
  ratio: number;
}

/** Johnson & Cook 1983, рис. 9: опытные L/L0 для меди OFHC, армко-железа и стали 4340. */
export const TAYLOR_REFS: TaylorRef[] = [
  { material: 'copper_ofhc', v: 0.13, L0: 25.4, ratio: 0.811 },
  { material: 'copper_ofhc', v: 0.146, L0: 25.4, ratio: 0.776 },
  { material: 'copper_ofhc', v: 0.19, L0: 25.4, ratio: 0.678 },
  { material: 'armco_iron', v: 0.197, L0: 25.4, ratio: 0.793 },
  { material: 'armco_iron', v: 0.221, L0: 25.4, ratio: 0.754 },
  { material: 'armco_iron', v: 0.279, L0: 12.6, ratio: 0.662 },
  { material: 'steel_4340', v: 0.208, L0: 25.4, ratio: 0.885 },
  { material: 'steel_4340', v: 0.282, L0: 12.7, ratio: 0.812 },
  { material: 'steel_4340', v: 0.343, L0: 6.1, ratio: 0.748 },
];

const MATERIAL_SHORT: Record<string, string> = { copper_ofhc: 'cu', armco_iron: 'armco', steel_4340: '4340' };
const MATERIAL_LABEL: Record<string, string> = { copper_ofhc: 'медь', armco_iron: 'армко', steel_4340: 'сталь 4340' };

/** Длина цилиндра по оси: от низа до верха частиц плюс Δx (частица — центр своей ячейки). */
export function taylorLength(snap: Snapshot, dx: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < snap.n; i++) {
    if (tagRemoved(snap.tags[i])) continue;
    const y = snap.planes[PLANE.Y * snap.n + i];
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  return hi - lo + dx;
}

/** Диаметр «ножки» у стенки, отнесённый к начальному. */
function taylorFoot(snap: Snapshot, dx: number, R: number): number {
  let lo = Infinity;
  for (let i = 0; i < snap.n; i++) if (!tagRemoved(snap.tags[i])) lo = Math.min(lo, snap.planes[PLANE.Y * snap.n + i]);
  let rmax = 0;
  for (let i = 0; i < snap.n; i++) {
    if (tagRemoved(snap.tags[i]) || snap.planes[PLANE.Y * snap.n + i] > lo + 1) continue;
    rmax = Math.max(rmax, snap.planes[PLANE.X * snap.n + i]);
  }
  return (rmax + dx / 2) / R;
}

/** Шаг проверки длины и предел времени, мкс */
const TAYLOR_CHECK_US = 5;
const TAYLOR_MAX_US = 200;

function taylorCase(ref: TaylorRef): GateCase {
  const ms = Math.round(ref.v * 1000);
  return {
    id: `taylor-${MATERIAL_SHORT[ref.material]}-${ms}`,
    test: '12.5',
    label: `Тейлор: ${MATERIAL_LABEL[ref.material]}, ${ms} м/с, L0 = ${ref.L0.toLocaleString('ru')} мм`,
    reference: `Johnson & Cook 1983, рис. 9: L/L0 = ${ref.ratio.toLocaleString('ru')}`,
    build: (dx) => taylorScene(ref.material, ref.v, ref.L0, dx),
    async measure(engine, { dx, toleranceScale, signal }) {
      // Пластика кончается, затем длина звенит упруго; ждём, пока три замера подряд не сдвинутся
      // больше чем на 0,05 % L0, и не раньше 2·L0/(0,3 км/с)
      let prev = ref.L0;
      let stable = 0;
      let snap = await engine.snapshot();
      let t = 0;
      while (t < TAYLOR_MAX_US && stable < 3 && !signal?.aborted) {
        t += TAYLOR_CHECK_US;
        await engine.runTo(t);
        snap = await engine.snapshot();
        const len = taylorLength(snap, dx);
        stable = Math.abs(len - prev) / ref.L0 < 5e-4 && snap.time > (2 * ref.L0) / 0.3 ? stable + 1 : 0;
        prev = len;
      }
      const ratio = taylorLength(snap, dx) / ref.L0;
      return relOutcome(ratio, ref.ratio, 'L/L0', 5 * toleranceScale, {
        footDiameter: taylorFoot(snap, dx, 3.81),
        t: snap.time,
      });
    },
  };
}

// ---------- 12.7: откол при плоском ударе (металлы) ----------

const SPALL_FLYER_DX = 20;
const SPALL_TARGET_DX = 60;
export const SPALL_MATERIAL = 'copper_ofhc';

/**
 * Скорость симметричного удара, при которой амплитуда волны равна откольной прочности:
 * ρ0·(C0 + s·up)·up = |p_min|, v = 2·up. Встречные волны разгрузки дают растяжение той же амплитуды.
 */
export function spallThreshold(mat: KernelMaterial): number {
  let up = 0;
  for (let k = 0; k < 60; k++) up = -mat.pmin / (mat.rho0 * (mat.C0 + mat.s * up));
  return 2 * up;
}

/**
 * Ударник 20Δx и мишень 60Δx из меди в разных полях контакта: контакт не держит растяжение, ударник
 * отлетает, как в опыте. Разгрузки с тыла мишени и с тыла ударника встречаются на глубине толщины ударника.
 */
export function spallScene(dx: number, v: number, material = SPALL_MATERIAL): PreparedScene {
  const h = 2 * dx;
  const Lt = SPALL_TARGET_DX * dx;
  const Lf = SPALL_FLYER_DX * dx;
  return prepareScene({
    mode: 'plane',
    domain: { xmin: 0, xmax: 2 * h, ymin: -10 * dx, ymax: Lt + Lf + 10 * dx },
    dx,
    lockX: true,
    bodies: [
      { rect: { x0: 0, y0: 0, x1: 2 * h, y1: Lt }, material, velocity: [0, 0], bodyId: 0, field: 0 },
      { rect: { x0: 0, y0: Lt, x1: 2 * h, y1: Lt + Lf }, material, velocity: [0, -v], bodyId: 1, field: 1 },
    ],
    bc: { left: Bc.Symmetry, right: Bc.Symmetry, bottom: Bc.Open, top: Bc.Open },
  });
}

/**
 * Откол в мишени по снимку: число разрушенных частиц (D ≥ 1) и главная трещина — наибольший зазор
 * между соседними слоями частиц (слой — частицы с одной начальной высотой). Глубина трещины — начальная
 * высота между этими слоями, от тыльной поверхности мишени (y = 0). Так в опыте меряют толщину откольной
 * пластины; середина зоны повреждения сдвигается с амплитудой удара, а трещина — нет.
 */
export function spallCrack(engine: Engine, snap: Snapshot, dx: number): { damaged: number; depth: number; gap: number } {
  const rows = new Map<number, { y: number; k: number }>();
  let damaged = 0;
  for (let i = 0; i < snap.n; i++) {
    if (tagBody(snap.tags[i]) !== 0 || tagRemoved(snap.tags[i])) continue;
    if (snap.planes[PLANE.D * snap.n + i] >= 1) damaged++;
    const row = Math.round(initialY(engine, i) / dx - 0.5);
    const r = rows.get(row) ?? { y: 0, k: 0 };
    r.y += snap.planes[PLANE.Y * snap.n + i];
    r.k++;
    rows.set(row, r);
  }
  const ids = [...rows.keys()].sort((a, b) => a - b);
  let gap = 0;
  let depth = NaN;
  for (let k = 1; k < ids.length; k++) {
    const lo = rows.get(ids[k - 1])!;
    const hi = rows.get(ids[k])!;
    const g = hi.y / hi.k - lo.y / lo.k;
    if (g > gap) {
      gap = g;
      depth = (ids[k - 1] + ids[k] + 1) * 0.5 * dx;
    }
  }
  return { damaged, depth, gap: gap / dx };
}

function spallCase(factor: number): GateCase {
  const spall = factor > 1;
  return {
    id: `spall-cu-${factor}`,
    test: '12.7',
    label: `Откол меди: удар ${factor.toLocaleString('ru')}·v_th — ${spall ? 'откольная пластина' : 'без откола'}`,
    reference: spall
      ? 'Главная трещина на глубине толщины ударника от тыла мишени (встреча разгрузок)'
      : 'Растяжение ниже откольной прочности p_min — разрушенных частиц нет',
    build: (dx) => spallScene(dx, factor * spallThreshold(kernelMaterial(SPALL_MATERIAL))),
    async measure(engine, { dx, toleranceScale }): Promise<CaseOutcome> {
      const mat = kernelMaterial(SPALL_MATERIAL);
      // Встреча разгрузок около (Lt + Lf)/C0; с запасом, чтобы трещина успела раскрыться
      await engine.runTo((2.2 * (SPALL_TARGET_DX + SPALL_FLYER_DX) * dx) / mat.C0);
      const snap = await engine.snapshot();
      const { damaged, depth, gap } = spallCrack(engine, snap, dx);
      const vth = spallThreshold(mat);
      if (!spall) {
        return {
          value: damaged,
          expected: 0,
          unit: 'частиц с D = 1',
          error: damaged,
          tolerance: 0,
          errorUnit: 'шт.',
          passed: damaged === 0,
          details: { maxGapDx: gap, vThreshold: vth, t: snap.time },
        };
      }
      const expected = SPALL_FLYER_DX * dx;
      const error = (depth - expected) / dx;
      const tolerance = 2 * toleranceScale;
      return {
        value: depth,
        expected,
        unit: 'мм от тыла',
        error,
        tolerance,
        errorUnit: 'Δx',
        // Трещина раскрыта: зазор между слоями заметно больше шага частиц
        passed: damaged > 0 && gap > 1.25 && Math.abs(error) <= tolerance,
        details: { damaged, maxGapDx: gap, vThreshold: vth, t: snap.time },
      };
    },
  };
}

export const GATE_CASES: GateCase[] = [
  plateCase,
  ...TAYLOR_REFS.map(taylorCase),
  spallCase(0.8),
  spallCase(2),
];

export function gateCase(id: string): GateCase {
  const c = GATE_CASES.find((g) => g.id === id);
  if (!c) throw new Error(`Нет сценария гейта ${id}`);
  return c;
}
