// Засев частиц и подготовка сцены для ядра (GPU) и CPU-эталона.
// Плоская деформация, частицы на единицу толщины (1 мм): масса = ρ·Δx², объём = Δx².

import { MAX_MATERIALS, PLANE, PLANE_COUNT, packTag } from '../sim/layout';
import { lame, type ElasticMaterial } from './materials';
import { cflTimeStep, longitudinalSoundSpeed } from './presets';

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface BodySpec {
  rect: Rect;
  material: ElasticMaterial;
  /** Начальная скорость, км/с (= мм/мкс) */
  velocity: [number, number];
  /** Угловая скорость вокруг центра прямоугольника, рад/мкс */
  omega?: number;
  bodyId: number;
}

export interface SceneSpec {
  /** Расчётная область [0, w] × [0, h], мм */
  domain: { w: number; h: number };
  /** Шаг частиц Δx, мм */
  dx: number;
  /** Частиц на ячейку сетки по оси; шаг сетки h = ppcAxis·Δx */
  ppcAxis: number;
  bodies: BodySpec[];
  /** Оценка максимальной скорости в сцене, км/с — для Δt и масштаба импульса */
  vMax: number;
  /** Слоёв узлов-стенок у границы области */
  boundaryNodes?: number;
  /** Ускорение по y, мм/мкс² (земная гравитация на масштабе мкс пренебрежимо мала) */
  gravityY?: number;
}

export interface MaterialParams {
  lambda: number;
  mu: number;
  rho: number;
  c: number;
}

export interface PreparedScene {
  n: number;
  /** PLANE_COUNT плоскостей по n значений; TAG хранит биты u32 */
  planes: Float32Array;
  dx: number;
  h: number;
  gx: number;
  gy: number;
  dt: number;
  gravityY: number;
  boundaryNodes: number;
  massScale: number;
  momScale: number;
  materials: MaterialParams[];
  domain: { w: number; h: number };
}

/**
 * Масштабы фиксированной точки для P2G на i32-атомиках (4.6).
 * Узел с B-сплайном 2-го порядка набирает массу ≈ ppcAxis² частиц; запас ×4 на сжатие.
 * Импульс: m·v плюс вклад напряжений ≈ m·c·ε за шаг — граница m·(vMax + c), запас ×4.
 * Целимся в 2^30, чтобы до 2^31 оставался двукратный запас.
 */
export function fixedPointScales(
  maxParticleMass: number,
  ppcAxis: number,
  vMax: number,
  cMax: number,
): { massScale: number; momScale: number } {
  const nodeMass = ppcAxis * ppcAxis * maxParticleMass * 4;
  const nodeMomentum = nodeMass * (vMax + cMax) * 4;
  return { massScale: 2 ** 30 / nodeMass, momScale: 2 ** 30 / nodeMomentum };
}

export function prepareScene(spec: SceneSpec): PreparedScene {
  const { dx, ppcAxis, domain } = spec;
  const h = ppcAxis * dx;
  const gx = Math.ceil(domain.w / h) + 1;
  const gy = Math.ceil(domain.h / h) + 1;

  const materialIndex = new Map<string, number>();
  const materials: MaterialParams[] = [];
  for (const b of spec.bodies) {
    if (materialIndex.has(b.material.id)) continue;
    if (materials.length >= MAX_MATERIALS) throw new Error(`Больше ${MAX_MATERIALS} материалов в сцене`);
    const { lambda, mu } = lame(b.material);
    materialIndex.set(b.material.id, materials.length);
    materials.push({
      lambda,
      mu,
      rho: b.material.density,
      c: longitudinalSoundSpeed(b.material.K, b.material.G, b.material.density),
    });
  }

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
  spec.bodies.forEach((b, bi) => {
    const { nx, ny } = counts[bi];
    const mi = materialIndex.get(b.material.id)!;
    // То же выражение GpuMpm.packParams передаёт в режим l2 — не меняй одно без другого
    const mass = b.material.density * dx * dx;
    maxMass = Math.max(maxMass, mass);
    const omega = b.omega ?? 0;
    const cx = (b.rect.x0 + b.rect.x1) / 2;
    const cy = (b.rect.y0 + b.rect.y1) / 2;
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++, i++) {
        const x = b.rect.x0 + (ix + 0.5) * dx;
        const y = b.rect.y0 + (iy + 0.5) * dx;
        set(PLANE.X, i, x);
        set(PLANE.Y, i, y);
        // v = v0 + ω × r; APIC-матрица C = ∇v несёт вращение с первого шага
        set(PLANE.VX, i, b.velocity[0] - omega * (y - cy));
        set(PLANE.VY, i, b.velocity[1] + omega * (x - cx));
        set(PLANE.C01, i, -omega);
        set(PLANE.C10, i, omega);
        set(PLANE.F00, i, 1);
        set(PLANE.F11, i, 1);
        set(PLANE.MASS, i, mass);
        set(PLANE.VOL0, i, dx * dx);
        tags[i] = packTag(b.bodyId, mi);
      }
    }
  });

  const cMax = Math.max(...materials.map((m) => m.c));
  const { massScale, momScale } = fixedPointScales(maxMass, ppcAxis, spec.vMax, cMax);

  return {
    n,
    planes,
    dx,
    h,
    gx,
    gy,
    dt: cflTimeStep(dx, cMax + spec.vMax),
    gravityY: spec.gravityY ?? 0,
    boundaryNodes: spec.boundaryNodes ?? 3,
    massScale,
    momScale,
    materials,
    domain,
  };
}
