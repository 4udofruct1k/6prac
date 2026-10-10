// CPU-эталон (4.6, 13): тот же алгоритм, что в sim/kernels.ts, но в float64 и с обычными суммами.
// Нужен для отладки ядер и для headless-тестов без GPU. Любое изменение физики в WGSL
// повторяется здесь, иначе самопроверка GPU ↔ CPU разойдётся.

import { PLANE, tagMaterial } from '../sim/layout';
import type { PreparedScene } from '../scene/scene';

export class CpuMpm {
  readonly n: number;
  readonly gx: number;
  readonly gy: number;
  /** PLANE_COUNT плоскостей по n значений, float64; плоскость TAG не используется */
  readonly p: Float64Array;
  readonly tags: Uint32Array;
  stepCount = 0;

  private readonly gm: Float64Array;
  private readonly gpx: Float64Array;
  private readonly gpy: Float64Array;
  private readonly gvx: Float64Array;
  private readonly gvy: Float64Array;

  constructor(readonly scene: PreparedScene) {
    this.n = scene.n;
    this.gx = scene.gx;
    this.gy = scene.gy;
    this.p = Float64Array.from(scene.planes);
    this.tags = new Uint32Array(scene.planes.buffer, scene.planes.byteOffset + PLANE.TAG * this.n * 4, this.n).slice();
    const gn = this.gx * this.gy;
    this.gm = new Float64Array(gn);
    this.gpx = new Float64Array(gn);
    this.gpy = new Float64Array(gn);
    this.gvx = new Float64Array(gn);
    this.gvy = new Float64Array(gn);
  }

  get time(): number {
    return this.stepCount * this.scene.dt;
  }

  get(plane: number, i: number): number {
    return this.p[plane * this.n + i];
  }

  step(count = 1): void {
    for (let k = 0; k < count; k++) {
      this.p2g();
      this.gridUpdate();
      this.g2p();
      this.stepCount++;
    }
  }

  private stencil(x: number, y: number) {
    const { invH, gx, gy } = this.consts();
    const xg = x * invH;
    const yg = y * invH;
    const bx = clamp(Math.floor(xg - 0.5), 0, gx - 3);
    const by = clamp(Math.floor(yg - 0.5), 0, gy - 3);
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

  private consts() {
    const s = this.scene;
    return { h: s.h, invH: 1 / s.h, dt: s.dt, gx: this.gx, gy: this.gy };
  }

  private p2g(): void {
    const { h, invH, dt, gx } = this.consts();
    const { p, n } = this;
    this.gm.fill(0);
    this.gpx.fill(0);
    this.gpy.fill(0);
    for (let i = 0; i < n; i++) {
      const x = p[PLANE.X * n + i];
      const y = p[PLANE.Y * n + i];
      const vx = p[PLANE.VX * n + i];
      const vy = p[PLANE.VY * n + i];
      const c00 = p[PLANE.C00 * n + i];
      const c01 = p[PLANE.C01 * n + i];
      const c10 = p[PLANE.C10 * n + i];
      const c11 = p[PLANE.C11 * n + i];
      const f00 = p[PLANE.F00 * n + i];
      const f01 = p[PLANE.F01 * n + i];
      const f10 = p[PLANE.F10 * n + i];
      const f11 = p[PLANE.F11 * n + i];
      const m = p[PLANE.MASS * n + i];
      const vol0 = p[PLANE.VOL0 * n + i];
      const mat = this.scene.materials[tagMaterial(this.tags[i])];

      const lnJ = Math.log(Math.max(f00 * f11 - f01 * f10, 1e-6));
      const b00 = f00 * f00 + f01 * f01;
      const b01 = f00 * f10 + f01 * f11;
      const b11 = f10 * f10 + f11 * f11;
      const t00 = mat.mu * (b00 - 1) + mat.lambda * lnJ;
      const t01 = mat.mu * b01;
      const t11 = mat.mu * (b11 - 1) + mat.lambda * lnJ;
      const k = -dt * vol0 * 4 * invH * invH;
      const a00 = k * t00 + m * c00;
      const a01 = k * t01 + m * c01;
      const a10 = k * t01 + m * c10;
      const a11 = k * t11 + m * c11;

      const s = this.stencil(x, y);
      for (let b = 0; b < 3; b++) {
        for (let a = 0; a < 3; a++) {
          const w = s.wx[a] * s.wy[b];
          const dxp = (a - s.fx) * h;
          const dyp = (b - s.fy) * h;
          const node = s.bx + a + (s.by + b) * gx;
          this.gm[node] += w * m;
          this.gpx[node] += w * (m * vx + a00 * dxp + a01 * dyp);
          this.gpy[node] += w * (m * vy + a10 * dxp + a11 * dyp);
        }
      }
    }
  }

  private gridUpdate(): void {
    const { dt, gx, gy } = this.consts();
    const bound = this.scene.boundaryNodes;
    const g = this.scene.gravityY;
    for (let id = 0; id < gx * gy; id++) {
      const m = this.gm[id];
      let vx = 0;
      let vy = 0;
      if (m > 0) {
        vx = this.gpx[id] / m;
        vy = this.gpy[id] / m + dt * g;
        const ix = id % gx;
        const iy = Math.floor(id / gx);
        if (ix < bound && vx < 0) vx = 0;
        if (ix + bound >= gx && vx > 0) vx = 0;
        if (iy < bound && vy < 0) vy = 0;
        if (iy + bound >= gy && vy > 0) vy = 0;
      }
      this.gvx[id] = vx;
      this.gvy[id] = vy;
    }
  }

  private g2p(): void {
    const { h, invH, dt, gx, gy } = this.consts();
    const { p, n } = this;
    for (let i = 0; i < n; i++) {
      const x = p[PLANE.X * n + i];
      const y = p[PLANE.Y * n + i];
      const s = this.stencil(x, y);
      let vx = 0;
      let vy = 0;
      let c00 = 0;
      let c01 = 0;
      let c10 = 0;
      let c11 = 0;
      for (let b = 0; b < 3; b++) {
        for (let a = 0; a < 3; a++) {
          const w = s.wx[a] * s.wy[b];
          const dxp = (a - s.fx) * h;
          const dyp = (b - s.fy) * h;
          const node = s.bx + a + (s.by + b) * gx;
          const gvx = this.gvx[node];
          const gvy = this.gvy[node];
          vx += w * gvx;
          vy += w * gvy;
          c00 += w * gvx * dxp;
          c01 += w * gvx * dyp;
          c10 += w * gvy * dxp;
          c11 += w * gvy * dyp;
        }
      }
      const cs = 4 * invH * invH;
      c00 *= cs;
      c01 *= cs;
      c10 *= cs;
      c11 *= cs;

      const f00 = p[PLANE.F00 * n + i];
      const f01 = p[PLANE.F01 * n + i];
      const f10 = p[PLANE.F10 * n + i];
      const f11 = p[PLANE.F11 * n + i];
      p[PLANE.F00 * n + i] = (1 + dt * c00) * f00 + dt * c01 * f10;
      p[PLANE.F01 * n + i] = (1 + dt * c00) * f01 + dt * c01 * f11;
      p[PLANE.F10 * n + i] = dt * c10 * f00 + (1 + dt * c11) * f10;
      p[PLANE.F11 * n + i] = dt * c10 * f01 + (1 + dt * c11) * f11;

      p[PLANE.X * n + i] = clamp(x + dt * vx, h, (gx - 2) * h);
      p[PLANE.Y * n + i] = clamp(y + dt * vy, h, (gy - 2) * h);
      p[PLANE.VX * n + i] = vx;
      p[PLANE.VY * n + i] = vy;
      p[PLANE.C00 * n + i] = c00;
      p[PLANE.C01 * n + i] = c01;
      p[PLANE.C10 * n + i] = c10;
      p[PLANE.C11 * n + i] = c11;
    }
  }

  /** Интегралы для проверок: импульс, момент импульса, кинетическая и упругая энергия (Дж на мм толщины). */
  diagnostics() {
    const { p, n } = this;
    let mass = 0;
    let px = 0;
    let py = 0;
    let mx = 0;
    let my = 0;
    let kinetic = 0;
    let elastic = 0;
    for (let i = 0; i < n; i++) {
      const m = p[PLANE.MASS * n + i];
      const x = p[PLANE.X * n + i];
      const y = p[PLANE.Y * n + i];
      const vx = p[PLANE.VX * n + i];
      const vy = p[PLANE.VY * n + i];
      mass += m;
      px += m * vx;
      py += m * vy;
      mx += m * x;
      my += m * y;
      kinetic += 0.5 * m * (vx * vx + vy * vy);
      const f00 = p[PLANE.F00 * n + i];
      const f01 = p[PLANE.F01 * n + i];
      const f10 = p[PLANE.F10 * n + i];
      const f11 = p[PLANE.F11 * n + i];
      const lnJ = Math.log(f00 * f11 - f01 * f10);
      const mat = this.scene.materials[tagMaterial(this.tags[i])];
      // ψ = μ/2 (tr FᵀF − 2) − μ ln J + λ/2 (ln J)², F33 = 1
      const trC = f00 * f00 + f01 * f01 + f10 * f10 + f11 * f11;
      elastic += p[PLANE.VOL0 * n + i] * (0.5 * mat.mu * (trC - 2) - mat.mu * lnJ + 0.5 * mat.lambda * lnJ * lnJ);
    }
    let angular = 0;
    const cx = mx / mass;
    const cy = my / mass;
    // APIC сохраняет момент вместе с «собственным» членом частицы m·(B_yx − B_xy), B = C·h²/4
    const d = (this.scene.h * this.scene.h) / 4;
    for (let i = 0; i < n; i++) {
      const m = p[PLANE.MASS * n + i];
      const rx = p[PLANE.X * n + i] - cx;
      const ry = p[PLANE.Y * n + i] - cy;
      angular += m * (rx * p[PLANE.VY * n + i] - ry * p[PLANE.VX * n + i]);
      angular += m * d * (p[PLANE.C10 * n + i] - p[PLANE.C01 * n + i]);
    }
    return {
      mass,
      momentum: [px, py] as [number, number],
      centerOfMass: [cx, cy] as [number, number],
      velocity: [px / mass, py / mass] as [number, number],
      angularMomentum: angular,
      kinetic,
      elastic,
    };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
