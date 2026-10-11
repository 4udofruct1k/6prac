// Энергия и импульс по снимку частиц (12.2). Одна функция для CPU-эталона и для снимков с GPU:
// баланс считается одинаково, чем бы ни был получен снимок.

import { pressureOf } from '../cpu-ref/physics';
import { particleMass, type PreparedScene } from '../scene/scene';
import { PLANE, tagMaterial, tagRemoved } from './layout';

export interface Diagnostics {
  /** Кинетическая энергия частиц в счёте, Дж (плоский режим — на мм толщины, осесимм. — на радиан) */
  kinetic: number;
  /** Внутренняя энергия m·e частиц в счёте */
  internal: number;
  /** Кинетическая + внутренняя энергия удалённых частиц («ушедшая за границу») */
  lost: number;
  total: number;
  mass: number;
  momentum: [number, number];
  centerOfMass: [number, number];
  velocity: [number, number];
}

/** Снимок частиц: плоскости в раскладке PreparedScene.planes, метки — отдельно (плоскость TAG не читается). */
export interface ParticleView {
  readonly n: number;
  readonly planes: ArrayLike<number>;
  readonly tags: ArrayLike<number>;
}

export function diagnose(scene: PreparedScene, view: ParticleView): Diagnostics {
  const { n, planes: p, tags } = view;
  const mats = scene.materials;
  let kinetic = 0;
  let internal = 0;
  let lost = 0;
  let mass = 0;
  let px = 0;
  let py = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    const m = particleMass(mats[tagMaterial(tags[i])], p[PLANE.VOL0 * n + i]);
    const vx = p[PLANE.VX * n + i];
    const vy = p[PLANE.VY * n + i];
    const ke = 0.5 * m * (vx * vx + vy * vy);
    const ie = m * p[PLANE.E * n + i];
    if (tagRemoved(tags[i])) {
      lost += ke + ie;
      continue;
    }
    kinetic += ke;
    internal += ie;
    mass += m;
    px += m * vx;
    py += m * vy;
    mx += m * p[PLANE.X * n + i];
    my += m * p[PLANE.Y * n + i];
  }
  return {
    kinetic,
    internal,
    lost,
    total: kinetic + internal + lost,
    mass,
    momentum: [px, py],
    centerOfMass: [mx / mass, my / mass],
    velocity: [px / mass, py / mass],
  };
}

/** Давление частицы по EOS (без q), ГПа. */
export function particlePressure(scene: PreparedScene, view: ParticleView, i: number): number {
  const { n, planes: p } = view;
  const mat = scene.materials[tagMaterial(view.tags[i])];
  return pressureOf(mat, p[PLANE.J * n + i], p[PLANE.E * n + i], p[PLANE.D * n + i], p[PLANE.PHI * n + i]);
}
