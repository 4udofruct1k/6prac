// Сцены M0: демо «упругий блок отскакивает» и нагрузка для бенчмарка пресетов.

import { DEMO_ELASTOMER, STEEL_4340_ELASTIC } from './materials';
import { REFERENCE_SCENE_MM, particleSpacing } from './presets';
import { prepareScene, type PreparedScene, type SceneSpec } from './scene';

const PPC_AXIS = 2;
const BOUNDARY_NODES = 3;

export interface DemoOptions {
  /** Частиц по стороне блока */
  across: number;
}

export const DEMO_BLOCK_MM = 40;
export const DEMO_VELOCITY: [number, number] = [0.03, -0.06];
export const DEMO_OMEGA = 0.0015;

/**
 * Блок эластомера 40×40 мм летит к полу на 67 м/с с вращением и отскакивает.
 * Земная гравитация за сотни мкс сдвигает блок на нанометры, поэтому «падение» задано
 * начальной скоростью. Стенки области — жёсткие, со скольжением.
 */
export function demoSceneSpec({ across }: DemoOptions): SceneSpec {
  const dx = DEMO_BLOCK_MM / across;
  const x0 = 40;
  const y0 = 25;
  const halfDiag = (DEMO_BLOCK_MM / 2) * Math.SQRT2;
  const vMax = Math.hypot(...DEMO_VELOCITY) + DEMO_OMEGA * halfDiag;
  return {
    domain: { w: 160, h: 120 },
    dx,
    ppcAxis: PPC_AXIS,
    boundaryNodes: BOUNDARY_NODES,
    vMax: vMax * 1.5,
    bodies: [
      {
        rect: { x0, y0, x1: x0 + DEMO_BLOCK_MM, y1: y0 + DEMO_BLOCK_MM },
        material: DEMO_ELASTOMER,
        velocity: DEMO_VELOCITY,
        omega: DEMO_OMEGA,
        bodyId: 0,
      },
    ],
  };
}

export function demoScene(opts: DemoOptions): PreparedScene {
  return prepareScene(demoSceneSpec(opts));
}

export const BENCH_ROD_SPEED = 1.5;

/**
 * Нагрузка бенчмарка: эталонная сцена 120×250 мм из 2.1 целиком заполнена частицами
 * с шагом Δx = √(A/N), так что частиц ≈ N. Стальная плита, в верхней части — «стержень»
 * 10×60 мм со скоростью 1,5 км/с вниз: ударная волна, большие деформации, конкуренция атомиков.
 * Вокруг сцены — поле стенок из BOUNDARY_NODES узлов + 1 ячейка.
 */
export function benchSceneSpec(n: number): SceneSpec {
  const { w, h } = REFERENCE_SCENE_MM;
  const dx = particleSpacing(w * h, n);
  const pad = (BOUNDARY_NODES + 1) * PPC_AXIS * dx;
  const rodW = 10;
  const rodH = 60;
  // Стержень выровнен по сетке частиц, чтобы тела не перекрывались
  const snap = (v: number) => Math.round(v / dx) * dx;
  const rx0 = pad + snap((w - rodW) / 2);
  const rx1 = rx0 + snap(rodW);
  const ry0 = pad + snap(h - rodH);
  const top = pad + snap(h);
  const left = pad;
  const right = pad + snap(w);
  const bottom = pad;
  const steel = STEEL_4340_ELASTIC;
  return {
    domain: { w: right + pad, h: top + pad },
    dx,
    ppcAxis: PPC_AXIS,
    boundaryNodes: BOUNDARY_NODES,
    vMax: BENCH_ROD_SPEED,
    bodies: [
      // плита под стержнем
      { rect: { x0: left, y0: bottom, x1: right, y1: ry0 }, material: steel, velocity: [0, 0], bodyId: 0 },
      // по бокам от стержня
      { rect: { x0: left, y0: ry0, x1: rx0, y1: top }, material: steel, velocity: [0, 0], bodyId: 0 },
      { rect: { x0: rx1, y0: ry0, x1: right, y1: top }, material: steel, velocity: [0, 0], bodyId: 0 },
      // стержень
      { rect: { x0: rx0, y0: ry0, x1: rx1, y1: top }, material: steel, velocity: [0, -BENCH_ROD_SPEED], bodyId: 1 },
    ],
  };
}

export function benchScene(n: number): PreparedScene {
  return prepareScene(benchSceneSpec(n));
}
