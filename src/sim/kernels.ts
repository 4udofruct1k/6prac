// WGSL-ядра явного 2D MLS-MPM (раздел 4): P2G → сетка → G2P + материал + перенос.
// M0: неогуковская упругость (плоская деформация). EOS, Джонсон–Кук, разрушение — M1.
//
// Детерминизм (4.6): P2G копит массу и импульс в i32 с фиксированной точкой. Целочисленная
// сумма не зависит от порядка атомиков, поэтому повторный прогон совпадает побитово.
//
// Режим совместимости WebGPU: workgroup 64 (≤ 128), не больше 3 storage-буферов на ядро (≤ 4),
// в вершинном шейдере storage-буферов нет.

import { FIXED_POINT_GUARD, MAX_MATERIALS, PLANE, VizMode, WORKGROUP_SIZE } from './layout';

/** Размер uniform-структуры Params в байтах (должен совпадать с writeParams в GpuMpm). */
export const PARAMS_BYTES = 64 + MAX_MATERIALS * 16;

const planeConsts = Object.entries(PLANE)
  .map(([k, v]) => `const P_${k}: u32 = ${v}u;`)
  .join('\n');

export const MPM_WGSL = /* wgsl */ `
struct Material {
  lambda: f32,
  mu: f32,
  rho: f32,
  c: f32,
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
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  _pad3: u32,
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

@compute @workgroup_size(${WORKGROUP_SIZE})
fn p2g(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) {
    return;
  }
  let x = vec2f(ld(P_X, i), ld(P_Y, i));
  let v = vec2f(ld(P_VX, i), ld(P_VY, i));
  let c00 = ld(P_C00, i);
  let c01 = ld(P_C01, i);
  let c10 = ld(P_C10, i);
  let c11 = ld(P_C11, i);
  let f00 = ld(P_F00, i);
  let f01 = ld(P_F01, i);
  let f10 = ld(P_F10, i);
  let f11 = ld(P_F11, i);
  let m = ld(P_MASS, i);
  let vol0 = ld(P_VOL0, i);
  let mat = material(i);

  // Напряжение Кирхгофа неогуковой модели: tau = mu (F F^T - I) + lambda ln J I
  let lnJ = log(max(f00 * f11 - f01 * f10, 1e-6));
  let b00 = f00 * f00 + f01 * f01;
  let b01 = f00 * f10 + f01 * f11;
  let b11 = f10 * f10 + f11 * f11;
  let t00 = mat.mu * (b00 - 1.0) + mat.lambda * lnJ;
  let t01 = mat.mu * b01;
  let t11 = mat.mu * (b11 - 1.0) + mat.lambda * lnJ;

  // MLS-MPM: аффинный импульс = -dt V0 (4/h^2) tau + m C
  let k = -P.dt * vol0 * 4.0 * P.invH * P.invH;
  let a00 = k * t00 + m * c00;
  let a01 = k * t01 + m * c01;
  let a10 = k * t01 + m * c10;
  let a11 = k * t11 + m * c11;

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

// Импульс → скорость, гравитация, стенки (скольжение, отрыв разрешён).
// Атомики обнуляются здесь же — отдельный проход очистки не нужен.
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

@compute @workgroup_size(${WORKGROUP_SIZE})
fn g2p(@builtin(global_invocation_id) gid: vec3u) {
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
  let n00 = (1.0 + dt * c.x) * f00 + dt * c.y * f10;
  let n01 = (1.0 + dt * c.x) * f01 + dt * c.y * f11;
  let n10 = dt * c.z * f00 + (1.0 + dt * c.w) * f10;
  let n11 = dt * c.z * f01 + (1.0 + dt * c.w) * f11;

  // Страховка: частица не покидает зону, где её шаблон 3×3 целиком в сетке
  x = clamp(x + dt * nv, vec2f(P.h), vec2f(f32(P.gx - 2u), f32(P.gy - 2u)) * P.h);

  st(P_X, i, x.x);
  st(P_Y, i, x.y);
  st(P_VX, i, nv.x);
  st(P_VY, i, nv.y);
  st(P_C00, i, c.x);
  st(P_C01, i, c.y);
  st(P_C10, i, c.z);
  st(P_C11, i, c.w);
  st(P_F00, i, n00);
  st(P_F01, i, n01);
  st(P_F10, i, n10);
  st(P_F11, i, n11);

  var viz = 0.0;
  if (P.vizMode == VIZ_SPEED) {
    viz = length(nv);
  } else if (P.vizMode == VIZ_PRESSURE) {
    // p = -tr(sigma)/3 с учётом tau_zz = lambda ln J при плоской деформации, ГПа
    let mat = material(i);
    let J = max(n00 * n11 - n01 * n10, 1e-6);
    let trB = n00 * n00 + n01 * n01 + n10 * n10 + n11 * n11;
    viz = -(mat.mu * (trB - 2.0) + 3.0 * mat.lambda * log(J)) / (3.0 * J);
  }
  st(P_VIZ, i, viz);
}
`;
