// Засев частиц и подготовка сцены для ядра (GPU) и CPU-эталона (M1).
//
// Плоский режим: частица на мм толщины, V0 = Δx². Осесимметричный (4.4): x = r, y = z, частица —
// кольцо, V0 = Δx²·r (на радиан). Масса частицы m = ρ0·V0 — в буфере не хранится, ядро считает её
// из материала тем же выражением (см. particleMass).

import { kernelMaterial } from '../materials';
import { T_ROOM, soundSpeed, type KernelMaterial } from '../materials/models';
import { Bc, GRID_PAD, MAX_MATERIALS, PLANE, PLANE_COUNT, packTag } from '../sim/layout';
import { C_CFL } from './presets';

export type GeometryMode = 'plane' | 'axisym';

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface BodySpec {
  /** Прямоугольник; в осесимметричном режиме — r0…r1 × z0…z1 (цилиндр или кольцо) */
  rect: Rect;
  /** id материала в базе (src/materials/db.json) */
  material: string;
  /** Начальная скорость, км/с (= мм/мкс) */
  velocity: [number, number];
  /** Угловая скорость вокруг центра прямоугольника, рад/мкс (только плоский режим) */
  omega?: number;
  /** Номер тела для цвета и метрик */
  bodyId: number;
  /** Поле скоростей контакта (4.5): 0 — мишень, 1 — снаряд */
  field: 0 | 1;
}

export interface Domain {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

export interface SceneSpec {
  mode: GeometryMode;
  /** Расчётная область, мм; в осесимметричном режиме xmin = 0 — ось */
  domain: Domain;
  /** Шаг частиц Δx, мм */
  dx: number;
  /** Частиц на ячейку сетки по оси; шаг сетки h = ppcAxis·Δx */
  ppcAxis?: number;
  bodies: BodySpec[];
  bc: { left: Bc; right: Bc; bottom: Bc; top: Bc };
  /** 1D-режим: поперечная скорость узлов = 0 (одноосная деформация, тест 12.1) */
  lockX?: boolean;
  /** Ускорение по y, мм/мкс² */
  gravityY?: number;
  cfl?: number;
  /** Искусственная вязкость (4.3): квадратичный c1 и линейный c2 коэффициенты */
  c1?: number;
  c2?: number;
  /** Трение Кулона в контакте полей (4.5), tuned */
  friction?: number;
}

export interface PreparedScene {
  mode: GeometryMode;
  n: number;
  /** PLANE_COUNT плоскостей по n значений; TAG хранит биты u32 */
  planes: Float32Array;
  dx: number;
  h: number;
  gx: number;
  gy: number;
  /** Положение узла (0, 0), мм */
  origin: [number, number];
  domain: Domain;
  bc: SceneSpec['bc'];
  lockX: boolean;
  gravityY: number;
  cfl: number;
  c1: number;
  c2: number;
  friction: number;
  /** Минимальный радиус в членах σθθ/r и v_r/r (осесимметричный режим), мм */
  rmin: number;
  massScale: number;
  momScale: number;
  gradScale: number;
  kScale: number;
  /** Начальный Δt по Куранту, мкс */
  dt0: number;
  materials: KernelMaterial[];
  materialIds: string[];
}

/** Масса частицы m = ρ0·V0 — одно выражение для засева, CPU-эталона и GPU. */
export function particleMass(mat: KernelMaterial, vol0: number): number {
  return mat.rho0 * vol0;
}

/**
 * Скорость сигнала для Δt (4.3) с поправкой на искусственную вязкость (как в гидрокодах):
 * Q = c2·c + c1·L·max(−∇·v, 0), сигнал = Q + √(Q² + c²).
 */
export function signalSpeed(c: number, divV: number, L: number, c1: number, c2: number): number {
  const Q = c2 * c + c1 * L * Math.max(-divV, 0);
  return Q + Math.sqrt(Q * Q + c * c);
}

/**
 * Масштабы фиксированной точки для P2G на i32-атомиках (4.6).
 * Узел набирает массу ≈ ppcAxis² частиц; запас ×4 на сжатие. Импульс: m·v плюс импульс напряжений
 * за шаг — граница m·(vMax + 3·cMax), запас ×4; кинетическая энергия частиц в узле — ½·m·(vMax + 3·cMax)²,
 * запас ×4. «Градиент» массы Σ m·w·d ≤ масса узла·1,5h. Целимся в 2^30, до 2^31 — двукратный запас.
 */
/**
 * Граница скорости для накопителя кинетической энергии: в K входят только скорости частиц u = v + C·d,
 * без импульса напряжений, — им не нужен запас на скорость звука. Скорость за ударом не больше скорости
 * удара, разброс C·d в ячейке — того же порядка; 3·vMax с запасом на осколки, плюс 0,05·cMax на упругие
 * волны в сцене без начальной скорости. Узкая граница — мелкий шаг K: разность K − ½·M·|ū|² (потеря P2G)
 * считается без шума округления, который у узлов с малой массой иначе уходит в тепло.
 */
export function kineticVelocityBound(vMax: number, cMax: number): number {
  return 3 * vMax + 0.05 * cMax;
}

export function fixedPointScales(
  maxParticleMass: number,
  ppcAxis: number,
  vMax: number,
  cMax: number,
  h: number,
): { massScale: number; momScale: number; gradScale: number; kScale: number } {
  const nodeMass = ppcAxis * ppcAxis * maxParticleMass * 4;
  const vb = vMax + 3 * cMax;
  const vk = kineticVelocityBound(vMax, cMax);
  return {
    massScale: 2 ** 30 / nodeMass,
    momScale: 2 ** 30 / (nodeMass * vb * 4),
    gradScale: 2 ** 30 / (nodeMass * 2 * h),
    kScale: 2 ** 30 / (nodeMass * vk * vk * 2),
  };
}

export function prepareScene(spec: SceneSpec): PreparedScene {
  const ppc = spec.ppcAxis ?? 2;
  const { dx, domain, mode } = spec;
  const axisym = mode === 'axisym';
  if (axisym && domain.xmin !== 0) throw new Error('Осесимметричный режим: ось должна быть в x = 0');
  const h = ppc * dx;
  const origin: [number, number] = [domain.xmin - GRID_PAD * h, domain.ymin - GRID_PAD * h];
  const gx = Math.ceil((domain.xmax - domain.xmin) / h - 1e-9) + 1 + 2 * GRID_PAD;
  const gy = Math.ceil((domain.ymax - domain.ymin) / h - 1e-9) + 1 + 2 * GRID_PAD;

  const ids: string[] = [];
  for (const b of spec.bodies) if (!ids.includes(b.material)) ids.push(b.material);
  if (ids.length > MAX_MATERIALS) throw new Error(`Больше ${MAX_MATERIALS} материалов в сцене`);
  const materials = ids.map(kernelMaterial);

  const counts = spec.bodies.map((b) => ({
    nx: Math.max(0, Math.floor((b.rect.x1 - b.rect.x0) / dx + 1e-9)),
    ny: Math.max(0, Math.floor((b.rect.y1 - b.rect.y0) / dx + 1e-9)),
  }));
  const n = counts.reduce((s, c) => s + c.nx * c.ny, 0);
  if (n === 0) throw new Error('В сцене нет частиц');

  const planes = new Float32Array(PLANE_COUNT * n);
  const tags = new Uint32Array(planes.buffer, PLANE.TAG * n * 4, n);
  const set = (plane: number, i: number, v: number) => {
    planes[plane * n + i] = v;
  };

  let i = 0;
  let maxMass = 0;
  let vMax = 0;
  let maxSignal = 0;
  const cfl = spec.cfl ?? C_CFL;
  const c1 = spec.c1 ?? 1.5;
  const c2 = spec.c2 ?? 0.06;
  spec.bodies.forEach((b, bi) => {
    const { nx, ny } = counts[bi];
    const mi = ids.indexOf(b.material);
    const mat = materials[mi];
    const omega = axisym ? 0 : (b.omega ?? 0);
    const cx = (b.rect.x0 + b.rect.x1) / 2;
    const cy = (b.rect.y0 + b.rect.y1) / 2;
    const c = soundSpeed(mat, 1, 0, mat.strength !== 0);
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++, i++) {
        const x = b.rect.x0 + (ix + 0.5) * dx;
        const y = b.rect.y0 + (iy + 0.5) * dx;
        // f32 для VOL0 и масса из уже округлённого значения — как увидит GPU
        const vol0 = Math.fround(dx * dx * (axisym ? x : 1));
        const vx = b.velocity[0] - omega * (y - cy);
        const vy = b.velocity[1] + omega * (x - cx);
        set(PLANE.X, i, x);
        set(PLANE.Y, i, y);
        set(PLANE.VX, i, vx);
        set(PLANE.VY, i, vy);
        // APIC-матрица C = ∇v несёт вращение с первого шага
        set(PLANE.C01, i, -omega);
        set(PLANE.C10, i, omega);
        set(PLANE.J, i, 1);
        set(PLANE.T, i, T_ROOM);
        set(PLANE.VOL0, i, vol0);
        tags[i] = packTag(mi, b.bodyId, b.field);
        maxMass = Math.max(maxMass, particleMass(mat, vol0));
        const speed = Math.hypot(vx, vy);
        vMax = Math.max(vMax, speed);
        maxSignal = Math.max(maxSignal, signalSpeed(c, 0, h, c1, c2) + speed);
      }
    }
  });

  const cMax = Math.max(...materials.map((m) => soundSpeed(m, 1, 0, m.strength !== 0)));
  const scales = fixedPointScales(maxMass, ppc, vMax, cMax, h);

  return {
    mode,
    n,
    planes,
    dx,
    h,
    gx,
    gy,
    origin,
    domain,
    bc: spec.bc,
    lockX: spec.lockX ?? false,
    gravityY: spec.gravityY ?? 0,
    cfl,
    c1,
    c2,
    friction: spec.friction ?? 0,
    rmin: 0.25 * dx,
    ...scales,
    dt0: (cfl * dx) / maxSignal,
    materials,
    materialIds: ids,
  };
}
