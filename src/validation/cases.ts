// Сценарии гейта M1 (разделы 12 и 14): что считается, что меряется и с чем сравнивается.
// Метрики считаются по снимку частиц, поэтому одинаковы для CPU-эталона и GPU.

import { kernelMaterial } from '../materials';
import { hugoniot } from '../materials/models';
import { REFERENCE_SCENE_MM, particleSpacing, QUALITY_PRESETS } from '../scene/presets';
import { prepareScene, type PreparedScene } from '../scene/scene';
import { taylorScene } from '../scene/scenes';
import { particlePressure } from '../sim/diagnostics';
import { Bc, PLANE, tagBody, tagRemoved } from '../sim/layout';
import type { Engine, EngineFactory, Snapshot } from './engine';

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
  /** Решатель для дополнительных прогонов сценария (поиск порога) */
  factory?: EngineFactory;
}

export interface GateCase {
  id: string;
  test: '12.1' | '12.5' | '12.7';
  label: string;
  /** Откуда эталон */
  reference: string;
  build(dx: number): PreparedScene;
  measure(engine: Engine, ctx: MeasureContext): Promise<CaseOutcome>;
  /** Шаг частиц сценария по шагу пресета (по умолчанию — шаг пресета) */
  dx?(presetDx: number): number;
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

export const SPALL_MATERIAL = 'copper_ofhc';

/** Шаг для плоских ударов: тоньше толщины ударника / 6 пластину не разрешить. */
function plateDx(presetDx: number, flyer: number): number {
  return Math.min(presetDx, flyer / 6);
}

/**
 * Симметричный удар (1D: lockX, плоскости симметрии по бокам): мишень Lt на тыльной поверхности y = 0,
 * ударник Lf летит на неё со скоростью v. Тела в разных полях контакта: контакт не держит растяжение,
 * ударник отлетает, как в опыте. Толщины округляются до целого числа частиц.
 */
export function plateShotScene(dx: number, Lf: number, Lt: number, v: number, material = SPALL_MATERIAL): PreparedScene {
  const h = 2 * dx;
  const lt = Math.round(Lt / dx) * dx;
  const lf = Math.round(Lf / dx) * dx;
  return prepareScene({
    mode: 'plane',
    domain: { xmin: 0, xmax: 2 * h, ymin: -20 * dx, ymax: lt + lf + 20 * dx },
    dx,
    lockX: true,
    bodies: [
      { rect: { x0: 0, y0: 0, x1: 2 * h, y1: lt }, material, velocity: [0, 0], bodyId: 0, field: 0 },
      { rect: { x0: 0, y0: lt, x1: 2 * h, y1: lt + lf }, material, velocity: [0, -v], bodyId: 1, field: 1 },
    ],
    bc: { left: Bc.Symmetry, right: Bc.Symmetry, bottom: Bc.Open, top: Bc.Open },
  });
}

export interface ShotResult {
  /** В мишени есть разрушенные частицы (D = 1) — откольная пластина отделилась */
  separated: boolean;
  damaged: number;
  /** Наибольшая пористость в мишени и раскрытие φ·Δx, мкм */
  maxPhi: number;
  openingUm: number;
  /** Откольная прочность по спаду скорости тыльной поверхности ½·ρ0·C0·Δu, ГПа (NaN — без истории) */
  pullback: number;
  /** Скорость тыльной поверхности на плато, км/с */
  uMax: number;
  t: number;
}

/**
 * Прогон удара: до 2,6·(Lt + Lf)/C0 — встреча разгрузок и раскрытие трещины. С history — скорость тыльной
 * поверхности (ряд частиц у y = 0) каждые 0,01 мкс и откольная прочность по ней, как в опыте:
 * σ = ½·ρ0·C0·(u_max − u_min), u_min — первый минимум после плато.
 */
export async function runShot(engine: Engine, Lf: number, Lt: number, history: boolean): Promise<ShotResult> {
  const scene = engine.scene;
  const mat = scene.materials[0];
  const dx = scene.dx;
  const n = scene.n;
  const tEnd = (2.6 * (Lt + Lf)) / mat.C0;
  let snap = await engine.snapshot();
  const rear: number[] = [];
  for (let i = 0; i < n; i++) if (tagBody(snap.tags[i]) === 0 && initialY(engine, i) < dx) rear.push(i);
  const samples: [number, number][] = [];
  if (history) {
    for (let t = 0.01; t < tEnd; t += 0.01) {
      await engine.runTo(t);
      snap = await engine.snapshot();
      let u = 0;
      for (const i of rear) u -= snap.planes[PLANE.VY * n + i];
      samples.push([snap.time, u / rear.length]);
    }
  }
  await engine.runTo(tEnd);
  snap = await engine.snapshot();
  let damaged = 0;
  let maxPhi = 0;
  for (let i = 0; i < n; i++) {
    if (tagBody(snap.tags[i]) !== 0) continue;
    if (snap.planes[PLANE.D * n + i] >= 1) damaged++;
    maxPhi = Math.max(maxPhi, snap.planes[PLANE.PHI * n + i]);
  }
  let pullback = NaN;
  let uMax = NaN;
  if (samples.length > 2) {
    const peak = Math.max(...samples.map((s) => s[1]));
    let k = samples.findIndex((s) => s[1] >= 0.9 * peak);
    while (k + 1 < samples.length && samples[k + 1][1] >= samples[k][1]) k++;
    uMax = samples[k][1];
    let uMin = uMax;
    const window = samples[k][0] + (2 * Lf) / mat.C0 + 0.5;
    for (let j = k; j < samples.length && samples[j][0] < window; j++) uMin = Math.min(uMin, samples[j][1]);
    pullback = 0.5 * mat.rho0 * mat.C0 * (uMax - uMin);
  }
  return { separated: damaged > 0, damaged, maxPhi, openingUm: maxPhi * dx * 1000, pullback, uMax, t: snap.time };
}

interface SpallShot {
  id: string;
  /** Толщины ударника и мишени, мм; скорость, км/с */
  Lf: number;
  Lt: number;
  v: number;
  /** Отделилась ли откольная пластина в опыте */
  separated: boolean;
  label: string;
  reference: string;
  /** Опыт дал откольную прочность по спаду скорости тыльной поверхности, ГПа */
  pullback?: number;
}

/** Удары медь по меди с исходом из опыта (у всех медь OFHC или чистая медь ≥ 99,99 %). */
export const SPALL_SHOTS: SpallShot[] = [
  { id: 'spall-bless-80', Lf: 1.5, Lt: 4.0, v: 0.08, separated: false, label: 'Откол меди: 1,5/4,0 мм, 80 м/с — без пор', reference: 'Bless 1981, табл. 4: нет пор' },
  { id: 'spall-bless-103', Lf: 1.45, Lt: 3.9, v: 0.103, separated: false, label: 'Откол меди: 1,45/3,9 мм, 103 м/с — слой пор', reference: 'Bless 1981, табл. 4: слой пор без отделения' },
  { id: 'spall-bless-168', Lf: 2.0, Lt: 4.0, v: 0.168, separated: true, label: 'Откол меди: 2,0/4,0 мм, 168 м/с — отделение', reference: 'Bless 1981, табл. 4: откольная пластина отделилась' },
  { id: 'spall-bless-244', Lf: 1.45, Lt: 4.0, v: 0.244, separated: true, label: 'Откол меди: 1,45/4,0 мм, 244 м/с — отделение', reference: 'Bless 1981, табл. 4: откольная пластина отделилась' },
  { id: 'spall-peng-94', Lf: 3.01, Lt: 6.04, v: 0.094, separated: false, label: 'Откол меди: 3,01/6,04 мм, 94 м/с — повреждение без отделения', reference: 'Peng 2015, табл. 1: повреждение до 0,047 без отделения' },
  { id: 'spall-peng-138', Lf: 2.02, Lt: 4.05, v: 0.138, separated: false, label: 'Откол меди: 2,02/4,05 мм, 138 м/с — повреждение без отделения', reference: 'Peng 2015, табл. 1: повреждение до 0,096 без отделения' },
  { id: 'spall-thomas-308', Lf: 1.78, Lt: 4.0, v: 0.308, separated: true, pullback: 1.37, label: 'Откол меди: 1,78/4,00 мм, 308 м/с — откольная прочность', reference: 'Thomas et al. 2016, табл. 1: откольная прочность 1,37 ГПа по VISAR' },
];

/** Порог полного откола в опыте: скорость удара, км/с. */
interface SpallThreshold {
  id: string;
  Lf: number;
  Lt: number;
  v: number;
  label: string;
  reference: string;
}

export const SPALL_THRESHOLDS: SpallThreshold[] = [
  { id: 'spall-smith-3', Lf: 3.05, Lt: 6.35, v: 0.128, label: 'Порог откола меди: 3,05/6,35 мм (импульс 1,5 мкс)', reference: 'Smith 1963, табл. I: полное отделение с 128 м/с, при 122 м/с нет' },
  { id: 'spall-smith-1.5', Lf: 1.5, Lt: 6.35, v: 0.153, label: 'Порог откола меди: 1,5/6,35 мм (импульс 0,75 мкс)', reference: 'Smith 1963, табл. I: полное отделение с 153 м/с, при 147 м/с нет' },
];

function shotCase(shot: SpallShot): GateCase {
  return {
    id: shot.id,
    test: '12.7',
    label: shot.label,
    reference: shot.reference,
    dx: (d) => plateDx(d, shot.Lf),
    build: (dx) => plateShotScene(dx, shot.Lf, shot.Lt, shot.v),
    async measure(engine, { toleranceScale }): Promise<CaseOutcome> {
      const r = await runShot(engine, shot.Lf, shot.Lt, shot.pullback !== undefined);
      const details = { damaged: r.damaged, maxPhi: r.maxPhi, openingUm: r.openingUm, t: r.t };
      if (shot.pullback !== undefined) {
        const out = relOutcome(r.pullback, shot.pullback, 'ГПа', 15 * toleranceScale, { ...details, uMax: r.uMax });
        return { ...out, passed: out.passed && r.separated === shot.separated };
      }
      const value = r.separated ? 1 : 0;
      const expected = shot.separated ? 1 : 0;
      return {
        value,
        expected,
        unit: 'отделение (1 — есть)',
        error: value - expected,
        tolerance: 0,
        errorUnit: 'шт.',
        passed: value === expected,
        details,
      };
    },
  };
}

/** Поиск порога отделения: 6 делений пополам между 0,6 и 1,4 скорости опыта (шаг ~1,3 %). */
function thresholdCase(th: SpallThreshold): GateCase {
  return {
    id: th.id,
    test: '12.7',
    label: th.label,
    reference: th.reference,
    dx: (d) => plateDx(d, th.Lf),
    build: (dx) => plateShotScene(dx, th.Lf, th.Lt, th.v),
    async measure(engine, { dx, toleranceScale, factory, signal }): Promise<CaseOutcome> {
      if (!factory) throw new Error('Поиск порога требует решателя для повторных прогонов');
      // Сам сценарий — удар со скоростью опыта (по нему баланс энергии 12.2)
      const atExp = await runShot(engine, th.Lf, th.Lt, false);
      let lo = 0.6 * th.v;
      let hi = 1.4 * th.v;
      for (let k = 0; k < 6 && !signal?.aborted; k++) {
        const v = 0.5 * (lo + hi);
        const e = await factory(plateShotScene(dx, th.Lf, th.Lt, v));
        try {
          if ((await runShot(e, th.Lf, th.Lt, false)).separated) hi = v;
          else lo = v;
        } finally {
          e.destroy();
        }
      }
      const vth = 0.5 * (lo + hi);
      return relOutcome(vth * 1000, th.v * 1000, 'м/с', 10 * toleranceScale, {
        separatedAtExperiment: atExp.separated ? 1 : 0,
        openingUmAtExperiment: atExp.openingUm,
      });
    },
  };
}

export const GATE_CASES: GateCase[] = [
  plateCase,
  ...TAYLOR_REFS.map(taylorCase),
  ...SPALL_SHOTS.map(shotCase),
  ...SPALL_THRESHOLDS.map(thresholdCase),
];

export function gateCase(id: string): GateCase {
  const c = GATE_CASES.find((g) => g.id === id);
  if (!c) throw new Error(`Нет сценария гейта ${id}`);
  return c;
}
