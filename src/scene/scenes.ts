// Сцены: демо «упругий блок отскакивает» и нагрузка для бенчмарка пресетов.

import { Bc } from '../sim/layout';
import { REFERENCE_SCENE_MM, particleSpacing } from './presets';
import { prepareScene, type PreparedScene, type SceneSpec } from './scene';

export interface DemoOptions {
  /** Частиц по стороне блока */
  across: number;
}

export const DEMO_BLOCK_MM = 40;
export const DEMO_VELOCITY: [number, number] = [0.03, -0.06];
export const DEMO_OMEGA = 0.0015;

const WALLS = { left: Bc.Wall, right: Bc.Wall, bottom: Bc.Wall, top: Bc.Wall };

/**
 * Блок эластомера 40×40 мм летит к полу на 67 м/с с вращением и отскакивает.
 * Земная гравитация за сотни мкс сдвигает блок на нанометры, поэтому «падение» задано
 * начальной скоростью. Стенки — по краю области, на одном месте при любом разрешении.
 */
export function demoSceneSpec({ across }: DemoOptions): SceneSpec {
  const dx = DEMO_BLOCK_MM / across;
  const x0 = 35;
  const y0 = 20;
  return {
    mode: 'plane',
    domain: { xmin: 0, xmax: 160, ymin: 0, ymax: 120 },
    dx,
    bc: WALLS,
    bodies: [
      {
        rect: { x0, y0, x1: x0 + DEMO_BLOCK_MM, y1: y0 + DEMO_BLOCK_MM },
        material: 'demo_elastomer',
        velocity: DEMO_VELOCITY,
        omega: DEMO_OMEGA,
        bodyId: 0,
        field: 0,
      },
    ],
  };
}

export function demoScene(opts: DemoOptions): PreparedScene {
  return prepareScene(demoSceneSpec(opts));
}

export const BENCH_ROD_SPEED = 1.5;

/**
 * Нагрузка бенчмарка: эталонная сцена 120×250 мм из 2.1 целиком заполнена частицами с шагом
 * Δx = √(A/N), так что частиц ≈ N. Плита из стали 4340 (Джонсон–Кук, Ми–Грюнайзен) и «стержень»
 * 10×60 мм в своём поле контакта со скоростью 1,5 км/с вниз: ударная волна, пластика, контакт полей.
 */
export function benchSceneSpec(n: number): SceneSpec {
  const { w, h } = REFERENCE_SCENE_MM;
  const dx = particleSpacing(w * h, n);
  const rodW = 10;
  const rodH = 60;
  // Стержень выровнен по сетке частиц, чтобы тела не перекрывались
  const snap = (v: number) => Math.round(v / dx) * dx;
  const rx0 = snap((w - rodW) / 2);
  const rx1 = rx0 + snap(rodW);
  const ry0 = snap(h - rodH);
  const top = snap(h);
  const right = snap(w);
  const mat = 'steel_4340';
  return {
    mode: 'plane',
    domain: { xmin: 0, xmax: right, ymin: 0, ymax: top },
    dx,
    bc: { left: Bc.Open, right: Bc.Open, bottom: Bc.Open, top: Bc.Open },
    bodies: [
      // плита под стержнем
      { rect: { x0: 0, y0: 0, x1: right, y1: ry0 }, material: mat, velocity: [0, 0], bodyId: 0, field: 0 },
      // по бокам от стержня
      { rect: { x0: 0, y0: ry0, x1: rx0, y1: top }, material: mat, velocity: [0, 0], bodyId: 0, field: 0 },
      { rect: { x0: rx1, y0: ry0, x1: right, y1: top }, material: mat, velocity: [0, 0], bodyId: 0, field: 0 },
      // стержень
      {
        rect: { x0: rx0, y0: ry0, x1: rx1, y1: top },
        material: mat,
        velocity: [0, -BENCH_ROD_SPEED],
        bodyId: 1,
        field: 1,
      },
    ],
  };
}

export function benchScene(n: number): PreparedScene {
  return prepareScene(benchSceneSpec(n));
}
