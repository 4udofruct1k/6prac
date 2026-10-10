// CPU-эталон (4.6, 13): тот же алгоритм, что в sim/kernels.ts, но во float64 и с обычными суммами.
// Порядок совпадает с GPU: первый P2G, затем на шаге — сетка (контакт, границы), проход по частицам
// (G2P, материал, перенос, P2G следующего шага) и финализация Δt. Любое изменение физики в WGSL
// повторяется здесь, иначе самопроверка GPU ↔ CPU разойдётся.
//
// Энергия (4.6, 12.2): кинетическая энергия, которую сетка убирает выравниванием скоростей — контакт полей,
// стенки, проекция сетка → частица, — не пропадает, а становится теплом частиц. Так же искусственная
// вязкость превращает кинетическую энергию ударной волны в тепло. Сумма сходится точно: узел раздаёт
// удельную потерю λ = ΔK/m по весам, а Σ_p m_p·Σ_i w_ip·λ_i = Σ_i ΔK_i.

import { T_ROOM } from '../materials/models';
import type { PreparedScene } from '../scene/scene';
import { particleMass } from '../scene/scene';
import { diagnose, type Diagnostics } from '../sim/diagnostics';
import {
  Bc,
  FIELDS,
  GRID_ACC_PER_FIELD,
  GRID_PAD,
  GRID_V_STRIDE,
  PLANE,
  TAG_REMOVED,
  tagField,
  tagMaterial,
  tagRemoved,
} from '../sim/layout';
import { hasShear, pressureOf, updateMaterial, type MatState } from './physics';

export type { Diagnostics };


/** Накопители P2G поля: масса, импульс (с толчком напряжений), сам толчок, кинетическая энергия частиц, «градиент» массы. */
const ACC = { M: 0, PX: 1, PY: 2, IX: 3, IY: 4, K: 5, GX: 6, GY: 7 } as const;

export class CpuMpm {
  readonly n: number;
  readonly gx: number;
  readonly gy: number;
  readonly gn: number;
  /** PLANE_COUNT плоскостей по n значений, float64; плоскость TAG не используется */
  readonly p: Float64Array;
  readonly tags: Uint32Array;
  stepCount = 0;
  time = 0;
  dtCur: number;
  dtNext: number;

  private readonly acc: Float64Array;
  private readonly gv: Float64Array;
  private maxSignal = 0;
  private primed = false;

  constructor(readonly scene: PreparedScene) {
    this.n = scene.n;
    this.gx = scene.gx;
    this.gy = scene.gy;
    this.gn = scene.gx * scene.gy;
    this.p = Float64Array.from(scene.planes);
    this.tags = new Uint32Array(scene.planes.buffer, scene.planes.byteOffset + PLANE.TAG * this.n * 4, this.n).slice();
    this.acc = new Float64Array(FIELDS * GRID_ACC_PER_FIELD * this.gn);
    this.gv = new Float64Array(GRID_V_STRIDE * this.gn);
    this.dtCur = scene.dt0;
    this.dtNext = scene.dt0;
  }

  get(plane: number, i: number): number {
    return this.p[plane * this.n + i];
  }

  private at(plane: number, i: number): number {
    return plane * this.n + i;
  }

  step(count = 1): void {
    if (!this.primed) {
      this.acc.fill(0);
      for (let i = 0; i < this.n; i++) {
        if (tagRemoved(this.tags[i])) continue;
        const mat = this.scene.materials[tagMaterial(this.tags[i])];
        const pr = pressureOf(mat, this.get(PLANE.J, i), this.get(PLANE.E, i), this.get(PLANE.D, i));
        this.scatter(
          i,
          this.get(PLANE.X, i),
          this.get(PLANE.Y, i),
          this.get(PLANE.VX, i),
          this.get(PLANE.VY, i),
          [this.get(PLANE.C00, i), this.get(PLANE.C01, i), this.get(PLANE.C10, i), this.get(PLANE.C11, i)],
          this.get(PLANE.SXX, i),
          this.get(PLANE.SYY, i),
          this.get(PLANE.SXY, i),
          pr,
          this.dtCur,
        );
      }
      this.primed = true;
    }
    for (let k = 0; k < count; k++) {
      this.gridUpdate();
      this.g2p2g();
      this.finalize();
    }
  }

  // Квадратичный B-сплайн относительно начала сетки
  private stencil(x: number, y: number) {
    const s = this.scene;
    const invH = 1 / s.h;
    const xg = (x - s.origin[0]) * invH;
    const yg = (y - s.origin[1]) * invH;
    const bx = clamp(Math.floor(xg - 0.5), 0, this.gx - 3);
    const by = clamp(Math.floor(yg - 0.5), 0, this.gy - 3);
    const fx = xg - bx;
    const fy = yg - by;
    return {
      bx,
      by,
      fx,
      fy,
      wx: [0.5 * (1.5 - fx) ** 2, 0.75 - (fx - 1) ** 2, 0.5 * (fx - 0.5) ** 2],
      wy: [0.5 * (1.5 - fy) ** 2, 0.75 - (fy - 1) ** 2, 0.5 * (fy - 0.5) ** 2],
    };
  }

  /** P2G одной частицы: масса, импульс (APIC + импульс напряжений за dt), «градиент» массы. */
  private scatter(
    i: number,
    x: number,
    y: number,
    vx: number,
    vy: number,
    c: readonly [number, number, number, number],
    sxx: number,
    syy: number,
    sxy: number,
    pq: number,
    dt: number,
  ): void {
    const s = this.scene;
    const tag = this.tags[i];
    const mat = s.materials[tagMaterial(tag)];
    const vol0 = this.get(PLANE.VOL0, i);
    const m = particleMass(mat, vol0);
    const V = vol0 * this.get(PLANE.J, i);
    const invH = 1 / s.h;
    // Напряжение Коши σ = s − (p + q)·I
    const s00 = sxx - pq;
    const s11 = syy - pq;
    const s01 = sxy;
    const k = -dt * V * 4 * invH * invH;
    // Осесимметричный режим: кольцевое напряжение даёт радиальную силу −V·σθθ·w/r
    let hoop = 0;
    if (s.mode === 'axisym') {
      const sTT = -(sxx + syy) - pq;
      hoop = (-dt * V * sTT) / Math.max(x, s.rmin);
    }
    const f = tagField(tag);
    const base = f * GRID_ACC_PER_FIELD * this.gn;
    const st = this.stencil(x, y);
    for (let b = 0; b < 3; b++) {
      for (let a = 0; a < 3; a++) {
        const w = st.wx[a] * st.wy[b];
        const dx = (a - st.fx) * s.h;
        const dy = (b - st.fy) * s.h;
        const node = st.bx + a + (st.by + b) * this.gx;
        // Скорость частицы в узле u = v + C·d; толчок напряжений — отдельно, чтобы видеть потери переноса
        const ux = vx + c[0] * dx + c[1] * dy;
        const uy = vy + c[2] * dx + c[3] * dy;
        const ix = k * (s00 * dx + s01 * dy) + hoop;
        const iy = k * (s01 * dx + s11 * dy);
        this.acc[base + ACC.M * this.gn + node] += w * m;
        this.acc[base + ACC.PX * this.gn + node] += w * (m * ux + ix);
        this.acc[base + ACC.PY * this.gn + node] += w * (m * uy + iy);
        this.acc[base + ACC.IX * this.gn + node] += w * ix;
        this.acc[base + ACC.IY * this.gn + node] += w * iy;
        this.acc[base + ACC.K * this.gn + node] += 0.5 * w * m * (ux * ux + uy * uy);
        this.acc[base + ACC.GX * this.gn + node] += w * m * dx;
        this.acc[base + ACC.GY * this.gn + node] += w * m * dy;
      }
    }
  }

  /**
   * Импульс → скорость обоих полей, контакт полей (4.5), гравитация, границы. Накопители обнуляются.
   * Удельная потеря λ узла = (потеря сведения частиц в узел + потеря неупругого контакта) / масса узла;
   * обе считаются по скоростям без толчка напряжений, иначе реакция опор выглядела бы как потеря.
   */
  private gridUpdate(): void {
    const s = this.scene;
    const gn = this.gn;
    const A = (f: number, k: number, id: number) => this.acc[f * GRID_ACC_PER_FIELD * gn + k * gn + id];
    for (let id = 0; id < gn; id++) {
      const m0 = A(0, ACC.M, id);
      const m1 = A(1, ACC.M, id);
      // Полные скорости (с толчком) и скорости сведения частиц без толчка
      const v = [0, 0, 0, 0];
      const u = [0, 0, 0, 0];
      let loss = 0;
      for (let f = 0; f < 2; f++) {
        const m = f === 0 ? m0 : m1;
        if (m <= 0) continue;
        const px = A(f, ACC.PX, id);
        const py = A(f, ACC.PY, id);
        const ux = (px - A(f, ACC.IX, id)) / m;
        const uy = (py - A(f, ACC.IY, id)) / m;
        v[2 * f] = px / m;
        v[2 * f + 1] = py / m + this.dtCur * s.gravityY;
        u[2 * f] = ux;
        u[2 * f + 1] = uy;
        // Потеря P2G: Σ ½·w·m·|u_p|² − ½·M·|ū|² ≥ 0 (частицы в узле движутся по-разному). Без max(…, 0):
        // на GPU разность считается из сумм в фиксированной точке, шум округления двусторонний, и срезка
        // превратила бы его в систематический нагрев
        loss += A(f, ACC.K, id) - 0.5 * m * (ux * ux + uy * uy);
      }
      // Граница — по номеру узла, как на GPU: узел GRID_PAD стоит на нижней границе области,
      // узел g − 1 − GRID_PAD — первый на верхней или за ней
      const ix = id % this.gx;
      const iy = Math.floor(id / this.gx);
      const atL = ix <= GRID_PAD;
      const atR = ix >= this.gx - 1 - GRID_PAD;
      const atB = iy <= GRID_PAD;
      const atT = iy >= this.gy - 1 - GRID_PAD;
      if (m0 > 0 && m1 > 0) {
        // Нормаль из тела 1 (снаряд) в тело 0 (мишень): Σ m·w·(x_i − x_p) смотрит из тела наружу
        let gx = A(1, ACC.GX, id) - A(0, ACC.GX, id);
        let gy = A(1, ACC.GY, id) - A(0, ACC.GY, id);
        // На плоскости симметрии нет зеркальной половины массы — составляющая градиента поперёк
        // плоскости ложная; в 1D (lockX) движения по x нет вовсе
        if (s.lockX || (atL && s.bc.left === Bc.Symmetry) || (atR && s.bc.right === Bc.Symmetry)) gx = 0;
        if ((atB && s.bc.bottom === Bc.Symmetry) || (atT && s.bc.top === Bc.Symmetry)) gy = 0;
        const len = Math.hypot(gx, gy);
        if (len > 0) {
          const nx = gx / len;
          const ny = gy / len;
          const k0 = 0.5 * (m0 * (u[0] ** 2 + u[1] ** 2) + m1 * (u[2] ** 2 + u[3] ** 2));
          contact(u, m0, m1, nx, ny, s.friction);
          loss += Math.max(k0 - 0.5 * (m0 * (u[0] ** 2 + u[1] ** 2) + m1 * (u[2] ** 2 + u[3] ** 2)), 0);
          contact(v, m0, m1, nx, ny, s.friction);
        }
      }
      for (let f = 0; f < 2; f++) {
        const m = f === 0 ? m0 : m1;
        if (m <= 0) continue;
        // Стенка неподвижна и работы не совершает: кинетическая энергия, которую она гасит у частиц
        // (по скорости без толчка напряжений), остаётся в теле теплом
        const ku = 0.5 * m * (u[2 * f] ** 2 + u[2 * f + 1] ** 2);
        [u[2 * f]] = applyBc(u[2 * f], atL, atR, s.bc.left, s.bc.right);
        [u[2 * f + 1]] = applyBc(u[2 * f + 1], atB, atT, s.bc.bottom, s.bc.top);
        if (s.lockX) u[2 * f] = 0;
        loss += Math.max(ku - 0.5 * m * (u[2 * f] ** 2 + u[2 * f + 1] ** 2), 0);
        [v[2 * f]] = applyBc(v[2 * f], atL, atR, s.bc.left, s.bc.right);
        [v[2 * f + 1]] = applyBc(v[2 * f + 1], atB, atT, s.bc.bottom, s.bc.top);
        if (s.lockX) v[2 * f] = 0;
      }
      const g = GRID_V_STRIDE * id;
      this.gv[g] = v[0];
      this.gv[g + 1] = v[1];
      this.gv[g + 2] = v[2];
      this.gv[g + 3] = v[3];
      this.gv[g + 4] = m0 + m1 > 0 ? loss / (m0 + m1) : 0;
    }
    this.acc.fill(0);
  }

  private g2p2g(): void {
    const s = this.scene;
    const { p, n } = this;
    const dt = this.dtCur;
    const invH = 1 / s.h;
    const axisym = s.mode === 'axisym';
    let maxSignal = 0;
    for (let i = 0; i < n; i++) {
      const tag = this.tags[i];
      if (tagRemoved(tag)) continue;
      const f = tagField(tag);
      const x = p[this.at(PLANE.X, i)];
      const y = p[this.at(PLANE.Y, i)];
      const st = this.stencil(x, y);
      let vx = 0;
      let vy = 0;
      const c = [0, 0, 0, 0];
      // Σ w·|v_i|² и Σ w·λ_i — для тепла от проекции и от ограничений сетки
      let sumV2 = 0;
      let heatGrid = 0;
      for (let b = 0; b < 3; b++) {
        for (let a = 0; a < 3; a++) {
          const w = st.wx[a] * st.wy[b];
          const dxp = (a - st.fx) * s.h;
          const dyp = (b - st.fy) * s.h;
          const node = st.bx + a + (st.by + b) * this.gx;
          const gvx = this.gv[GRID_V_STRIDE * node + 2 * f];
          const gvy = this.gv[GRID_V_STRIDE * node + 2 * f + 1];
          vx += w * gvx;
          vy += w * gvy;
          sumV2 += w * (gvx * gvx + gvy * gvy);
          heatGrid += w * this.gv[GRID_V_STRIDE * node + 4];
          c[0] += w * gvx * dxp;
          c[1] += w * gvx * dyp;
          c[2] += w * gvy * dxp;
          c[3] += w * gvy * dyp;
        }
      }
      for (let k = 0; k < 4; k++) c[k] *= 4 * invH * invH;
      const C = c as [number, number, number, number];

      const mat = s.materials[tagMaterial(tag)];
      const dzz = axisym ? vx / Math.max(x, s.rmin) : 0;
      // Потеря проекции сетка → частица (APIC): ½·Σ w·|v_i − v_p − C·d|² = ½·(Σ w|v_i|² − |v_p|² − h²/4·|C|²)
      const cc = C[0] * C[0] + C[1] * C[1] + C[2] * C[2] + C[3] * C[3];
      const heat = heatGrid + 0.5 * Math.max(sumV2 - vx * vx - vy * vy - 0.25 * s.h * s.h * cc, 0);
      const s0: MatState = {
        J: p[this.at(PLANE.J, i)],
        sxx: p[this.at(PLANE.SXX, i)],
        syy: p[this.at(PLANE.SYY, i)],
        sxy: p[this.at(PLANE.SXY, i)],
        eps: p[this.at(PLANE.EPS, i)],
        e: p[this.at(PLANE.E, i)] + heat,
        T: p[this.at(PLANE.T, i)] + heat / mat.cp,
        D: p[this.at(PLANE.D, i)],
      };
      const r = updateMaterial(mat, s0, C, dzz, dt, s.h, s.c1, s.c2);

      const nx = x + dt * vx;
      const ny = y + dt * vy;
      p[this.at(PLANE.X, i)] = nx;
      p[this.at(PLANE.Y, i)] = ny;
      p[this.at(PLANE.VX, i)] = vx;
      p[this.at(PLANE.VY, i)] = vy;
      p[this.at(PLANE.C00, i)] = C[0];
      p[this.at(PLANE.C01, i)] = C[1];
      p[this.at(PLANE.C10, i)] = C[2];
      p[this.at(PLANE.C11, i)] = C[3];
      p[this.at(PLANE.J, i)] = r.J;
      p[this.at(PLANE.SXX, i)] = r.sxx;
      p[this.at(PLANE.SYY, i)] = r.syy;
      p[this.at(PLANE.SXY, i)] = r.sxy;
      p[this.at(PLANE.EPS, i)] = r.eps;
      p[this.at(PLANE.E, i)] = r.e;
      p[this.at(PLANE.T, i)] = r.T;
      p[this.at(PLANE.D, i)] = r.D;

      // Частица за пределами области (с запасом 1,5h, пока шаблон в сетке) удаляется
      const m = 1.5 * s.h;
      const out =
        nx < s.domain.xmin - m || nx > s.domain.xmax + m || ny < s.domain.ymin - m || ny > s.domain.ymax + m;
      if (out) {
        this.tags[i] = tag | TAG_REMOVED;
        continue;
      }
      maxSignal = Math.max(maxSignal, r.signal + Math.hypot(vx, vy));
      this.scatter(i, nx, ny, vx, vy, C, r.sxx, r.syy, r.sxy, r.p + r.q, this.dtNext);
    }
    this.maxSignal = maxSignal;
  }

  /** Конец шага: время, Δt следующего шага по Куранту от состояния после шага (4.3, шаг 7). */
  private finalize(): void {
    this.time += this.dtCur;
    this.dtCur = this.dtNext;
    if (this.maxSignal > 0) this.dtNext = (this.scene.cfl * this.scene.dx) / this.maxSignal;
    this.maxSignal = 0;
    this.stepCount++;
  }

  /** Давление частицы по EOS (без q), ГПа. */
  pressure(i: number): number {
    const mat = this.scene.materials[tagMaterial(this.tags[i])];
    return pressureOf(mat, this.get(PLANE.J, i), this.get(PLANE.E, i), this.get(PLANE.D, i));
  }

  isRemoved(i: number): boolean {
    return tagRemoved(this.tags[i]);
  }

  /** Энергии и импульс (12.2): кинетическая + внутренняя + ушедшая за границу. */
  diagnostics(): Diagnostics {
    return diagnose(this.scene, { n: this.n, planes: this.p, tags: this.tags });
  }

  /** Сдвиговая жёсткость частицы есть (не разрушена, не расплавлена). */
  intact(i: number): boolean {
    const mat = this.scene.materials[tagMaterial(this.tags[i])];
    return hasShear(mat, this.get(PLANE.D, i), this.get(PLANE.T, i));
  }
}

/**
 * Контакт полей на узле (4.5): при сближении убирает нормальную относительную скорость, касательную
 * гасит трением Кулона; импульс узла сохраняется. v = [v0x, v0y, v1x, v1y], n — из тела 1 в тело 0.
 */
export function contact(v: number[], m0: number, m1: number, nx: number, ny: number, friction: number): void {
  const mt = m0 + m1;
  const cmx = (m0 * v[0] + m1 * v[2]) / mt;
  const cmy = (m0 * v[1] + m1 * v[3]) / mt;
  const ddx = v[2] - cmx;
  const ddy = v[3] - cmy;
  const dn = ddx * nx + ddy * ny;
  if (dn <= 0) return;
  const tx = ddx - dn * nx;
  const ty = ddy - dn * ny;
  const tl = Math.hypot(tx, ty);
  const kt = tl > 0 ? Math.min((friction * dn) / tl, 1) : 0;
  v[2] -= dn * nx + kt * tx;
  v[3] -= dn * ny + kt * ty;
  v[0] = (mt * cmx - m1 * v[2]) / m0;
  v[1] = (mt * cmy - m1 * v[3]) / m0;
}

/** Граница стороны: стенка не пускает наружу, симметрия обнуляет нормальную скорость. */
export function applyBc(v: number, atMin: boolean, atMax: boolean, bcMin: Bc, bcMax: Bc): [number] {
  if (atMin) {
    if (bcMin === Bc.Wall && v < 0) v = 0;
    if (bcMin === Bc.Symmetry) v = 0;
  }
  if (atMax) {
    if (bcMax === Bc.Wall && v > 0) v = 0;
    if (bcMax === Bc.Symmetry) v = 0;
  }
  return [v];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export { T_ROOM };
