// WGSL-ядра явного 2D MLS-MPM (раздел 4). M0: неогуковская упругость (плоская деформация).
// EOS, Джонсон–Кук, разрушение — M1.
//
// Шаг слит в два прохода: gridUpdate (импульс → скорость, стенки) и g2p2g — G2P этого шага,
// материал, перенос и сразу P2G следующего. Частица читается и пишется один раз за шаг.
// Первый P2G делает отдельное ядро p2g. Последовательность операций та же, что у CPU-эталона.
//
// Детерминизм (4.6): P2G копит массу и импульс в i32 с фиксированной точкой. Целочисленная
// сумма не зависит от порядка атомиков, поэтому повторный прогон совпадает побитово.
//
// Режим совместимости WebGPU: workgroup 64 (≤ 128), не больше 3 storage-буферов на ядро (≤ 4),
// в вершинном шейдере storage-буферов нет.

import { FIXED_POINT_GUARD, MAX_MATERIALS, PLANE, VizMode, WORKGROUP_SIZE } from './layout';

/** Material в uniform: 8 × f32 */
export const MATERIAL_BYTES = 32;

/** Размер uniform-структуры Params в байтах (должен совпадать с packParams в GpuMpm). */
export const PARAMS_BYTES = 64 + MAX_MATERIALS * MATERIAL_BYTES;

const planeConsts = Object.entries(PLANE)
  .map(([k, v]) => `const P_${k}: u32 = ${v}u;`)
  .join('\n');

export const MPM_WGSL = /* wgsl */ `
struct Material {
  lambda: f32,
  mu: f32,
  rho: f32,
  c: f32,
  // Масса частицы ρ·Δx², посчитанная на CPU так же, как при засеве (режим l2)
  pmass: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
}

struct Params {
  n: u32,
  gx: u32,
  gy: u32,
  gn: u32,
  h: f32,
  invH: f32,
  dt: f32,
  gravityY: f32,
  massScale: f32,
  momScale: f32,
  bound: u32,
  vizMode: u32,
  // 1 — g2p2g пишет v, C и VIZ; 0 — только x и F (режим L2 между кадрами)
  storeAux: u32,
  // 1 — масса и объём частицы из материала и Δx сцены, плоскости MASS и VOL0 не читаются.
  // Значения побитово равны засеянным в плоскости, поэтому режимы дают одинаковый результат.
  compact: u32,
  vol0: f32,
  _pad: u32,
  mats: array<Material, ${MAX_MATERIALS}>,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> part: array<f32>;
@group(0) @binding(2) var<storage, read_write> grid: array<atomic<i32>>;
@group(0) @binding(3) var<storage, read_write> gridV: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> status: array<atomic<u32>>;

${planeConsts}
const VIZ_SPEED: u32 = ${VizMode.Speed}u;
const VIZ_PRESSURE: u32 = ${VizMode.Pressure}u;
const GUARD: i32 = ${FIXED_POINT_GUARD};

fn ld(plane: u32, i: u32) -> f32 {
  return part[plane * P.n + i];
}

fn st(plane: u32, i: u32, v: f32) {
  part[plane * P.n + i] = v;
}

fn material(i: u32) -> Material {
  return P.mats[bitcast<u32>(ld(P_TAG, i)) & 0xffffu];
}

struct Stencil {
  base: vec2i,
  fx: vec2f,
  wx: vec3f,
  wy: vec3f,
}

// Квадратичный B-сплайн: узлы base..base+2, fx — положение частицы в ячейках от base.
fn stencil(x: vec2f) -> Stencil {
  let xg = x * P.invH;
  let base = clamp(vec2i(floor(xg - vec2f(0.5))), vec2i(0), vec2i(i32(P.gx) - 3, i32(P.gy) - 3));
  let fx = xg - vec2f(base);
  let w0 = 0.5 * (1.5 - fx) * (1.5 - fx);
  let w1 = 0.75 - (fx - 1.0) * (fx - 1.0);
  let w2 = 0.5 * (fx - 0.5) * (fx - 0.5);
  return Stencil(base, fx, vec3f(w0.x, w1.x, w2.x), vec3f(w0.y, w1.y, w2.y));
}

// P2G одной частицы. c = (C00, C01, C10, C11), f = (F00, F01, F10, F11).
fn scatter(i: u32, x: vec2f, v: vec2f, c: vec4f, f: vec4f) {
  let mat = material(i);
  var m = mat.pmass;
  var vol0 = P.vol0;
  if (P.compact == 0u) {
    m = ld(P_MASS, i);
    vol0 = ld(P_VOL0, i);
  }

  // Напряжение Кирхгофа неогуковой модели: tau = mu (F F^T - I) + lambda ln J I
  let lnJ = log(max(f.x * f.w - f.y * f.z, 1e-6));
  let b00 = f.x * f.x + f.y * f.y;
  let b01 = f.x * f.z + f.y * f.w;
  let b11 = f.z * f.z + f.w * f.w;
  let t00 = mat.mu * (b00 - 1.0) + mat.lambda * lnJ;
  let t01 = mat.mu * b01;
  let t11 = mat.mu * (b11 - 1.0) + mat.lambda * lnJ;

  // MLS-MPM: аффинный импульс = -dt V0 (4/h^2) tau + m C
  let k = -P.dt * vol0 * 4.0 * P.invH * P.invH;
  let a00 = k * t00 + m * c.x;
  let a01 = k * t01 + m * c.y;
  let a10 = k * t01 + m * c.z;
  let a11 = k * t11 + m * c.w;

  let s = stencil(x);
  for (var b = 0; b < 3; b++) {
    for (var a = 0; a < 3; a++) {
      let w = s.wx[a] * s.wy[b];
      let d = (vec2f(f32(a), f32(b)) - s.fx) * P.h;
      let px = w * (m * v.x + a00 * d.x + a01 * d.y);
      let py = w * (m * v.y + a10 * d.x + a11 * d.y);
      let node = u32(s.base.x + a) + u32(s.base.y + b) * P.gx;
      atomicAdd(&grid[node], i32(round(w * m * P.massScale)));
      atomicAdd(&grid[P.gn + node], i32(round(px * P.momScale)));
      atomicAdd(&grid[2u * P.gn + node], i32(round(py * P.momScale)));
    }
  }
}

// Первый P2G из начального состояния частиц.
@compute @workgroup_size(${WORKGROUP_SIZE})
fn p2g(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) {
    return;
  }
  scatter(
    i,
    vec2f(ld(P_X, i), ld(P_Y, i)),
    vec2f(ld(P_VX, i), ld(P_VY, i)),
    vec4f(ld(P_C00, i), ld(P_C01, i), ld(P_C10, i), ld(P_C11, i)),
    vec4f(ld(P_F00, i), ld(P_F01, i), ld(P_F10, i), ld(P_F11, i)),
  );
}

// Импульс → скорость, гравитация, стенки (скольжение, отрыв разрешён).
// Атомики обнуляются здесь же — следующий P2G копит с нуля без отдельного прохода очистки.
@compute @workgroup_size(${WORKGROUP_SIZE})
fn gridUpdate(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid.x;
  if (id >= P.gn) {
    return;
  }
  let im = atomicExchange(&grid[id], 0);
  let ipx = atomicExchange(&grid[P.gn + id], 0);
  let ipy = atomicExchange(&grid[2u * P.gn + id], 0);
  if (max(abs(im), max(abs(ipx), abs(ipy))) >= GUARD) {
    atomicOr(&status[0], 1u);
  }
  var v = vec2f(0.0);
  if (im > 0) {
    let m = f32(im) / P.massScale;
    v = vec2f(f32(ipx), f32(ipy)) / (P.momScale * m);
    v.y = v.y + P.dt * P.gravityY;
    let ix = id % P.gx;
    let iy = id / P.gx;
    if (ix < P.bound && v.x < 0.0) { v.x = 0.0; }
    if (ix + P.bound >= P.gx && v.x > 0.0) { v.x = 0.0; }
    if (iy < P.bound && v.y < 0.0) { v.y = 0.0; }
    if (iy + P.bound >= P.gy && v.y > 0.0) { v.y = 0.0; }
  }
  gridV[id] = v;
}

// G2P этого шага + материал + перенос, затем P2G следующего шага.
@compute @workgroup_size(${WORKGROUP_SIZE})
fn g2p2g(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) {
    return;
  }
  var x = vec2f(ld(P_X, i), ld(P_Y, i));
  let s = stencil(x);
  var nv = vec2f(0.0);
  var c = vec4f(0.0);
  for (var b = 0; b < 3; b++) {
    for (var a = 0; a < 3; a++) {
      let w = s.wx[a] * s.wy[b];
      let d = (vec2f(f32(a), f32(b)) - s.fx) * P.h;
      let gv = gridV[u32(s.base.x + a) + u32(s.base.y + b) * P.gx];
      nv += w * gv;
      c += w * vec4f(gv.x * d.x, gv.x * d.y, gv.y * d.x, gv.y * d.y);
    }
  }
  c *= 4.0 * P.invH * P.invH;

  // F <- (I + dt C) F
  let dt = P.dt;
  let f00 = ld(P_F00, i);
  let f01 = ld(P_F01, i);
  let f10 = ld(P_F10, i);
  let f11 = ld(P_F11, i);
  let nf = vec4f(
    (1.0 + dt * c.x) * f00 + dt * c.y * f10,
    (1.0 + dt * c.x) * f01 + dt * c.y * f11,
    dt * c.z * f00 + (1.0 + dt * c.w) * f10,
    dt * c.z * f01 + (1.0 + dt * c.w) * f11,
  );

  // Страховка: частица не покидает зону, где её шаблон 3×3 целиком в сетке
  x = clamp(x + dt * nv, vec2f(P.h), vec2f(f32(P.gx - 2u), f32(P.gy - 2u)) * P.h);

  st(P_X, i, x.x);
  st(P_Y, i, x.y);
  st(P_F00, i, nf.x);
  st(P_F01, i, nf.y);
  st(P_F10, i, nf.z);
  st(P_F11, i, nf.w);

  if (P.storeAux != 0u) {
    st(P_VX, i, nv.x);
    st(P_VY, i, nv.y);
    st(P_C00, i, c.x);
    st(P_C01, i, c.y);
    st(P_C10, i, c.z);
    st(P_C11, i, c.w);
    var viz = 0.0;
    if (P.vizMode == VIZ_SPEED) {
      viz = length(nv);
    } else if (P.vizMode == VIZ_PRESSURE) {
      // p = -tr(sigma)/3 с учётом tau_zz = lambda ln J при плоской деформации, ГПа
      let mat = material(i);
      let J = max(nf.x * nf.w - nf.y * nf.z, 1e-6);
      let trB = dot(nf, nf);
      viz = -(mat.mu * (trB - 2.0) + 3.0 * mat.lambda * log(J)) / (3.0 * J);
    }
    st(P_VIZ, i, viz);
  }

  scatter(i, x, nv, c, nf);
}
`;
