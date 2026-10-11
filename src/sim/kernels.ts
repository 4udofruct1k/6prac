// WGSL-ядра явного 2D MLS-MPM (раздел 4), веха M1: Ми–Грюнайзен, Джонсон–Кук с разрушением, откол (пористость),
// искусственная вязкость, температура, контакт двух полей, осесимметричный режим, Δt по Куранту на GPU.
//
// Шаг: gridUpdate (скорости полей, контакт, границы) → g2p2g (G2P этого шага, материал, перенос и сразу
// P2G следующего) → finalize (время, Δt следующего шага). Первый P2G делает p2g. Порядок и формулы
// повторяют CPU-эталон (src/cpu-ref) построчно — меняешь здесь, меняй там.
//
// Энергия (12.2): кинетическая энергия, которую сетка гасит выравниванием скоростей (сведение частиц
// в узел, контакт полей, стенки — по скоростям без толчка напряжений) и проекцией сетка → частица,
// возвращается частицам теплом.
//
// Детерминизм (4.6): накопители P2G — i32 с фиксированной точкой, максимум скорости сигнала — atomicMax
// по битам f32 (для положительных чисел порядок бит = порядок значений).
//
// Режим совместимости WebGPU: workgroup 64, не больше 4 storage-буферов на ядро, в вершинном шейдере их нет.

import {
  Bc,
  FIXED_POINT_GUARD,
  GRID_ACC_PER_FIELD,
  GRID_PAD,
  GRID_V_STRIDE,
  MAX_MATERIALS,
  PLANE,
  STEP,
  TAG_REMOVED,
  VizMode,
  WORKGROUP_SIZE,
} from './layout';
import {
  DamageModel,
  EPS_RATE_0,
  GURSON_Q1,
  GURSON_Q2,
  PHI_MAX,
  POROSITY_BISECT,
  SpallModel,
  StrengthModel,
} from '../materials/models';

/** Material в uniform: 28 × f32 (шаг массива uniform кратен 16 байтам) */
export const MATERIAL_FLOATS = 28;
export const PARAMS_HEADER_WORDS = 36;
/** Размер uniform-структуры Params в байтах (должен совпадать с packParams в GpuMpm). */
export const PARAMS_BYTES = PARAMS_HEADER_WORDS * 4 + MAX_MATERIALS * MATERIAL_FLOATS * 4;

const consts = [
  ...Object.entries(PLANE).map(([k, v]) => `const P_${k}: u32 = ${v}u;`),
  ...Object.entries(STEP).map(([k, v]) => `const S_${k}: u32 = ${v}u;`),
].join('\n');

export const MPM_WGSL = /* wgsl */ `
struct Material {
  rho0: f32, C0: f32, s: f32, gamma0: f32,
  G: f32, A: f32, B: f32, n: f32,
  C: f32, m: f32, Tm: f32, cp: f32,
  beta: f32, D1: f32, D2: f32, D3: f32,
  D4: f32, D5: f32, strength: f32, damage: f32,
  etaMax: f32, spall: f32, phi0: f32, ysat: f32,
  etaV: f32, phiF: f32, deltaC: f32, _p0: f32,
}

struct Params {
  n: u32, gx: u32, gy: u32, gn: u32,
  h: f32, invH: f32, dx: f32, cfl: f32,
  massScale: f32, momScale: f32, gradScale: f32, kScale: f32,
  originX: f32, originY: f32, c1: f32, c2: f32,
  xmin: f32, xmax: f32, ymin: f32, ymax: f32,
  friction: f32, rmin: f32, gravityY: f32, tRoom: f32,
  vizMode: u32, storeAux: u32, axisym: u32, lockX: u32,
  bcLeft: u32, bcRight: u32, bcBottom: u32, bcTop: u32,
  // Объём частицы в плоском режиме Δx² — тем же f32, что засеян в плоскость VOL0
  vol0: f32,
  // Осесимметричный режим: радиус приведения массы узла (PreparedScene.nodeRefRadius), 0 — без приведения
  nodeRefR: f32,
  _h1: f32, _h2: f32,
  mats: array<Material, ${MAX_MATERIALS}>,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> part: array<f32>;
@group(0) @binding(2) var<storage, read_write> grid: array<atomic<i32>>;
@group(0) @binding(3) var<storage, read_write> gridV: array<f32>;
@group(0) @binding(4) var<storage, read_write> stepState: array<atomic<u32>, 8>;

${consts}
const ACC_N: u32 = ${GRID_ACC_PER_FIELD}u;
const A_M: u32 = 0u;
const A_PX: u32 = 1u;
const A_PY: u32 = 2u;
const A_IX: u32 = 3u;
const A_IY: u32 = 4u;
const A_K: u32 = 5u;
const A_GX: u32 = 6u;
const A_GY: u32 = 7u;
const GV_STRIDE: u32 = ${GRID_V_STRIDE}u;
const TAG_REMOVED: u32 = ${TAG_REMOVED}u;
const GUARD: i32 = ${FIXED_POINT_GUARD};
const BC_WALL: u32 = ${Bc.Wall}u;
const BC_SYM: u32 = ${Bc.Symmetry}u;
// Узел GRID_PAD стоит на нижней границе области, узел g − 1 − GRID_PAD — первый на верхней или за ней
const GRID_PAD: u32 = ${GRID_PAD}u;
const ST_NONE: f32 = ${StrengthModel.None}.0;
const ST_JC: f32 = ${StrengthModel.JohnsonCook}.0;
const DM_JC: f32 = ${DamageModel.JohnsonCook}.0;
const SP_POROSITY: f32 = ${SpallModel.Porosity}.0;
const GURSON_Q1: f32 = ${GURSON_Q1};
const GURSON_Q2: f32 = ${GURSON_Q2};
const POROSITY_BISECT: i32 = ${POROSITY_BISECT};
const PHI_MAX: f32 = ${PHI_MAX};
const EPS_RATE_0: f32 = ${EPS_RATE_0};
const VIZ_SPEED: u32 = ${VizMode.Speed}u;
const VIZ_PRESSURE: u32 = ${VizMode.Pressure}u;
const VIZ_TEMPERATURE: u32 = ${VizMode.Temperature}u;
const VIZ_EPS: u32 = ${VizMode.PlasticStrain}u;
const VIZ_DAMAGE: u32 = ${VizMode.Damage}u;
const VIZ_MISES: u32 = ${VizMode.VonMises}u;
const VIZ_POROSITY: u32 = ${VizMode.Porosity}u;

fn ld(plane: u32, i: u32) -> f32 {
  return part[plane * P.n + i];
}

fn st(plane: u32, i: u32, v: f32) {
  part[plane * P.n + i] = v;
}

fn tagOf(i: u32) -> u32 {
  return bitcast<u32>(ld(P_TAG, i));
}

fn stepF(k: u32) -> f32 {
  return bitcast<f32>(atomicLoad(&stepState[k]));
}

fn accIndex(field: u32, k: u32, node: u32) -> u32 {
  return (field * ACC_N + k) * P.gn + node;
}

fn toFixed(v: f32, scale: f32) -> i32 {
  return i32(round(v * scale));
}

// Хеш PCG: детерминированный «случайный» сдвиг для округления без смещения
fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

// Округление вниз со сдвигом u ∈ [0, 1): E[floor(x + u)] = x — без смещения и для вкладов меньше кванта
fn toFixedDither(v: f32, scale: f32, u: f32) -> i32 {
  return i32(floor(v * scale + u));
}

// ---------- Модели материалов (src/materials/models.ts, src/cpu-ref/physics.ts) ----------

// Ми–Грюнайзен: A(η) и A'(η)
fn mgPart(mat: Material, eta: f32) -> vec2f {
  let k = mat.rho0 * mat.C0 * mat.C0;
  if (eta < 0.0) {
    return vec2f(k * eta, k);
  }
  let x = min(eta, mat.etaMax);
  let den = 1.0 - mat.s * x;
  let a = k * x * (1.0 - 0.5 * mat.gamma0 * x) / (den * den);
  let da = k * ((1.0 - mat.gamma0 * x) * den + 2.0 * mat.s * x * (1.0 - 0.5 * mat.gamma0 * x)) / (den * den * den);
  return vec2f(a, da);
}

// Порог роста пор при всестороннем растяжении σ_eq(φ) (модифицированная Tepla)
fn voidThreshold(mat: Material, phi: f32) -> f32 {
  return (2.0 * mat.ysat) / (3.0 * GURSON_Q2) * log(1.0 / (GURSON_Q1 * phi));
}

// Объём матрицы пористой частицы J_s = J·(1 − φ)/(1 − φ0)
fn matrixJ(mat: Material, J: f32, phi: f32) -> f32 {
  return J * (1.0 - phi) / (1.0 - mat.phi0);
}

// EOS пористой частицы P = (1 − φ)·P_MG(J_s, e); разрушенный материал растяжения не держит
fn pressureOf(mat: Material, J: f32, e: f32, D: f32, phi: f32) -> f32 {
  let p = (1.0 - phi) * (mgPart(mat, 1.0 - matrixJ(mat, J, phi)).x + mat.gamma0 * mat.rho0 * e);
  if (D >= 1.0 && p < 0.0) {
    return 0.0;
  }
  return p;
}

fn hasShear(mat: Material, D: f32, T: f32) -> bool {
  if (mat.strength == ST_NONE || D >= 1.0) {
    return false;
  }
  return !(mat.strength == ST_JC && T >= mat.Tm);
}

fn soundSpeed(mat: Material, J: f32, p: f32, shear: bool) -> f32 {
  let da = mgPart(mat, 1.0 - J).y;
  let k0 = mat.rho0 * mat.C0 * mat.C0;
  let ks = max(J * (da + mat.gamma0 * max(p, 0.0)), 0.1 * k0);
  var g = 0.0;
  if (shear) {
    g = mat.G;
  }
  return sqrt((ks + (4.0 / 3.0) * g) * J / mat.rho0);
}

fn homologousT(mat: Material, T: f32) -> f32 {
  return clamp((T - P.tRoom) / (mat.Tm - P.tRoom), 0.0, 1.0);
}

fn jcYield(mat: Material, eps: f32, rateStar: f32, T: f32) -> f32 {
  if (T >= mat.Tm) {
    return 0.0;
  }
  var hard = mat.A;
  if (eps > 0.0) {
    hard += mat.B * pow(eps, mat.n);
  }
  let rate = 1.0 + mat.C * log(max(rateStar, 1.0));
  let ts = homologousT(mat, T);
  var therm = 1.0;
  if (ts > 0.0) {
    therm = 1.0 - pow(ts, mat.m);
  }
  return hard * rate * therm;
}

fn jcFractureStrain(mat: Material, triax: f32, rateStar: f32, T: f32) -> f32 {
  let ef = (mat.D1 + mat.D2 * exp(mat.D3 * triax)) * (1.0 + mat.D4 * log(max(rateStar, 1.0)))
    * (1.0 + mat.D5 * homologousT(mat, T));
  return max(ef, 1e-3);
}

fn signalSpeed(c: f32, divV: f32) -> f32 {
  let q = P.c2 * c + P.c1 * P.h * max(-divV, 0.0);
  return q + sqrt(q * q + c * c);
}

struct MatState {
  J: f32, sxx: f32, syy: f32, sxy: f32,
  eps: f32, e: f32, T: f32, D: f32,
  phi: f32,
}

struct MatResult {
  s: MatState,
  p: f32,
  q: f32,
  signal: f32,
}

// Давление на конце шага при пористости φ: P = (1 − φ)·(A(η_s) + B·e), e = e* − ½·P·dv
fn pressureAt(mat: Material, J: f32, eStar: f32, dv: f32, phi: f32) -> f32 {
  let k = 1.0 - phi;
  let B = mat.gamma0 * mat.rho0;
  return k * (mgPart(mat, 1.0 - matrixJ(mat, J, phi)).x + B * eStar) / (1.0 + 0.5 * k * B * dv);
}

// Перенапряжение роста пор: растяжение сверх σ_eq(φ) открывает поры, давление сверх него схлопывает
fn poreOverstress(mat: Material, phi: f32, p: f32, fractured: bool) -> f32 {
  let seq = voidThreshold(mat, phi);
  var pc = p;
  if (fractured) {
    pc = max(p, 0.0);
  }
  return max(-pc - seq, 0.0) - max(pc - seq, 0.0);
}

// Пористость на конце шага: неявный Эйлер по x = ln φ, бисекция с фиксированным числом шагов
// (см. solvePorosity в src/cpu-ref/physics.ts)
fn solvePorosity(mat: Material, phiN: f32, fractured: bool, dt: f32, J: f32, eStar: f32, dv: f32) -> f32 {
  let g0 = poreOverstress(mat, phiN, pressureAt(mat, J, eStar, dv, phiN), fractured);
  if (g0 == 0.0 || (g0 < 0.0 && phiN <= mat.phi0)) {
    return phiN;
  }
  let xn = log(phiN);
  var lo = xn;
  var hi = log(PHI_MAX);
  if (g0 < 0.0) {
    lo = log(mat.phi0);
    hi = xn;
  }
  let k = dt / mat.etaV;
  for (var it = 0; it < POROSITY_BISECT; it++) {
    let x = 0.5 * (lo + hi);
    let phi = exp(x);
    let r = x - xn - k * poreOverstress(mat, phi, pressureAt(mat, J, eStar, dv, phi), fractured);
    if (r > 0.0) {
      hi = x;
    } else {
      lo = x;
    }
  }
  return exp(0.5 * (lo + hi));
}

// Шаг материала (4.3, шаг 5): см. updateMaterial в src/cpu-ref/physics.ts
fn updateMaterial(mat: Material, s0: MatState, c: vec4f, dzz: f32, dt: f32) -> MatResult {
  let dxx = c.x;
  let dyy = c.w;
  let dxy = 0.5 * (c.y + c.z);
  let w = 0.5 * (c.y - c.z);
  let trD = dxx + dyy + dzz;

  let Jold = s0.J;
  let J = Jold * ((1.0 + dt * c.x) * (1.0 + dt * c.w) - dt * dt * c.y * c.z) * (1.0 + dt * dzz);

  let third = trD / 3.0;
  let exx = dxx - third;
  let eyy = dyy - third;
  let ezz = dzz - third;

  let pOld = pressureOf(mat, Jold, s0.e, s0.D, s0.phi);
  let shear = hasShear(mat, s0.D, s0.T);
  let cOld = soundSpeed(mat, matrixJ(mat, Jold, s0.phi), pOld, shear);
  // Пористая частица: напряжение — доля (1 − φ) напряжения матрицы
  let solid = 1.0 - s0.phi;

  let rho = mat.rho0 / J;
  var q = 0.0;
  if (trD < 0.0) {
    q = rho * P.h * (P.c1 * P.h * trD * trD - P.c2 * cOld * trD);
  }

  var sxx = 0.0;
  var syy = 0.0;
  var sxy = 0.0;
  var dEps = 0.0;
  var D = s0.D;
  var sigmaY = 0.0;
  if (shear) {
    let G = solid * mat.G;
    sxx = s0.sxx + dt * (2.0 * G * exx + 2.0 * w * s0.sxy);
    syy = s0.syy + dt * (2.0 * G * eyy - 2.0 * w * s0.sxy);
    sxy = s0.sxy + dt * (2.0 * G * dxy + w * (s0.syy - s0.sxx));
    if (mat.strength == ST_JC) {
      let szz = -(sxx + syy);
      let seq = sqrt(1.5 * (sxx * sxx + syy * syy + szz * szz + 2.0 * sxy * sxy));
      let rateStar = sqrt((2.0 / 3.0) * (exx * exx + eyy * eyy + ezz * ezz + 2.0 * dxy * dxy)) / EPS_RATE_0;
      sigmaY = solid * jcYield(mat, s0.eps, rateStar, s0.T);
      if (seq > sigmaY) {
        dEps = (seq - sigmaY) / (3.0 * G);
        var k = 0.0;
        if (seq > 0.0) {
          k = sigmaY / seq;
        }
        sxx *= k;
        syy *= k;
        sxy *= k;
        if (mat.damage == DM_JC) {
          let triax = -pOld / max(sigmaY, 1e-9);
          D = min(D + dEps / jcFractureStrain(mat, triax, rateStar, s0.T), 1.0);
        }
      }
    }
  }
  let szz0 = -(s0.sxx + s0.syy);
  let szz = -(sxx + syy);

  let vMid = 0.5 * (Jold + J) / mat.rho0;
  let wDev = 0.5 * ((s0.sxx + sxx) * dxx + (s0.syy + syy) * dyy + (szz0 + szz) * dzz + 2.0 * (s0.sxy + sxy) * dxy);
  let dv = (J - Jold) / mat.rho0;
  let eStar = s0.e + dt * wDev * vMid - (0.5 * pOld + q) * dv;
  // Откол (5.5): поры растут под растяжением сверх порога и разгружают его
  var phi = s0.phi;
  if (mat.spall == SP_POROSITY) {
    phi = solvePorosity(mat, s0.phi, s0.D >= 1.0, dt, J, eStar, dv);
  }
  var p = pressureAt(mat, J, eStar, dv, phi);
  var e = eStar - 0.5 * p * dv;
  // Разрушение: φ ≥ φ_f или раскрытие φ·Δx ≥ δ_c
  if (mat.spall == SP_POROSITY && (phi >= mat.phiF || phi * P.dx >= mat.deltaC)) {
    D = 1.0;
  }
  if (D >= 1.0) {
    sxx = 0.0;
    syy = 0.0;
    sxy = 0.0;
    if (p < 0.0) {
      p = 0.0;
      e = eStar;
    }
  }

  // Температура: доля β пластической работы (сдвиг и рост/схлопывание пор) + нагрев вязкостью
  let dPhi = phi - s0.phi;
  let poreWork = (max(-p, 0.0) * max(dPhi, 0.0) + max(p, 0.0) * max(-dPhi, 0.0)) / (1.0 - phi);
  let heat = mat.beta * (sigmaY * dEps + poreWork) / rho + q * max(-dv, 0.0);
  let T = s0.T + heat / mat.cp;

  let cNew = soundSpeed(mat, matrixJ(mat, J, phi), p, hasShear(mat, D, T));
  var r: MatResult;
  r.s = MatState(J, sxx, syy, sxy, s0.eps + dEps, e, T, D, phi);
  r.p = p;
  r.q = q;
  r.signal = signalSpeed(cNew, trD);
  return r;
}

// ---------- Перенос ----------

struct Stencil {
  base: vec2i,
  fx: vec2f,
  wx: vec3f,
  wy: vec3f,
}

// Квадратичный B-сплайн относительно начала сетки: узлы base..base+2
fn stencil(x: vec2f) -> Stencil {
  let xg = (x - vec2f(P.originX, P.originY)) * P.invH;
  let base = clamp(vec2i(floor(xg - vec2f(0.5))), vec2i(0), vec2i(i32(P.gx) - 3, i32(P.gy) - 3));
  let f = xg - vec2f(base);
  let w0 = 0.5 * (1.5 - f) * (1.5 - f);
  let w1 = 0.75 - (f - 1.0) * (f - 1.0);
  let w2 = 0.5 * (f - 0.5) * (f - 0.5);
  return Stencil(base, f, vec3f(w0.x, w1.x, w2.x), vec3f(w0.y, w1.y, w2.y));
}

fn particleVol0(i: u32) -> f32 {
  if (P.axisym != 0u) {
    return ld(P_VOL0, i);
  }
  return P.vol0;
}

// P2G одной частицы: масса, импульс (APIC + толчок напряжений за dt), толчок отдельно,
// кинетическая энергия частицы в узлах, «градиент» массы
fn scatter(i: u32, tag: u32, x: vec2f, v: vec2f, c: vec4f, sxx: f32, syy: f32, sxy: f32, pq: f32, J: f32, dt: f32) {
  let mat = P.mats[tag & 0xffu];
  let vol0 = particleVol0(i);
  let m = mat.rho0 * vol0;
  let V = vol0 * J;
  let s00 = sxx - pq;
  let s11 = syy - pq;
  let s01 = sxy;
  let k = -dt * V * 4.0 * P.invH * P.invH;
  var hoop = 0.0;
  if (P.axisym != 0u) {
    let sTT = -(sxx + syy) - pq;
    hoop = -dt * V * sTT / max(x.x, P.rmin);
  }
  let field = (tag >> 16u) & 1u;
  let s = stencil(x);
  // Сдвиг округления K: от частицы и шага, свой для каждого узла шаблона
  let seed = pcg(i ^ pcg(atomicLoad(&stepState[S_STEPS])));
  for (var b = 0; b < 3; b++) {
    for (var a = 0; a < 3; a++) {
      // Осесимметричный режим: масса узла ∝ r — приводим к nodeRefR, чтобы у оси хватало разрядов
      // фиксированной точки. В gridUpdate всё — отношения накопителей одного узла: результат тот же.
      var w = s.wx[a] * s.wy[b];
      if (P.nodeRefR > 0.0) {
        w *= P.nodeRefR / max(P.originX + f32(s.base.x + a) * P.h, P.h);
      }
      let d = (vec2f(f32(a), f32(b)) - s.fx) * P.h;
      let u = v + vec2f(c.x * d.x + c.y * d.y, c.z * d.x + c.w * d.y);
      let imp = vec2f(k * (s00 * d.x + s01 * d.y) + hoop, k * (s01 * d.x + s11 * d.y));
      let node = u32(s.base.x + a) + u32(s.base.y + b) * P.gx;
      atomicAdd(&grid[accIndex(field, A_M, node)], toFixed(w * m, P.massScale));
      atomicAdd(&grid[accIndex(field, A_PX, node)], toFixed(w * (m * u.x + imp.x), P.momScale));
      atomicAdd(&grid[accIndex(field, A_PY, node)], toFixed(w * (m * u.y + imp.y), P.momScale));
      atomicAdd(&grid[accIndex(field, A_IX, node)], toFixed(w * imp.x, P.momScale));
      atomicAdd(&grid[accIndex(field, A_IY, node)], toFixed(w * imp.y, P.momScale));
      // K копит положительные вклады, хвосты шаблона меньше кванта: обычное округление всегда давало бы 0
      // и занижало K — потеря P2G уходила бы в минус. Сдвиг из хеша делает округление несмещённым.
      let du = f32(pcg(seed + u32(a + 3 * b)) >> 8u) * (1.0 / 16777216.0);
      atomicAdd(&grid[accIndex(field, A_K, node)], toFixedDither(0.5 * w * m * dot(u, u), P.kScale, du));
      atomicAdd(&grid[accIndex(field, A_GX, node)], toFixed(w * m * d.x, P.gradScale));
      atomicAdd(&grid[accIndex(field, A_GY, node)], toFixed(w * m * d.y, P.gradScale));
    }
  }
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn p2g(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) {
    return;
  }
  let tag = tagOf(i);
  if ((tag & TAG_REMOVED) != 0u) {
    return;
  }
  let mat = P.mats[tag & 0xffu];
  let J = ld(P_J, i);
  let pr = pressureOf(mat, J, ld(P_E, i), ld(P_D, i), ld(P_PHI, i));
  scatter(
    i, tag,
    vec2f(ld(P_X, i), ld(P_Y, i)),
    vec2f(ld(P_VX, i), ld(P_VY, i)),
    vec4f(ld(P_C00, i), ld(P_C01, i), ld(P_C10, i), ld(P_C11, i)),
    ld(P_SXX, i), ld(P_SYY, i), ld(P_SXY, i), pr, J, stepF(S_DT_CUR),
  );
}

// ---------- Сетка ----------

fn takeAcc(field: u32, k: u32, node: u32) -> i32 {
  return atomicExchange(&grid[accIndex(field, k, node)], 0);
}

// Контакт полей (4.5): при сближении — убрать нормальную относительную скорость, касательную — трением
fn contact(v: vec4f, m0: f32, m1: f32, n: vec2f) -> vec4f {
  let mt = m0 + m1;
  let cm = (m0 * v.xy + m1 * v.zw) / mt;
  let dd = v.zw - cm;
  let dn = dot(dd, n);
  if (dn <= 0.0) {
    return v;
  }
  let t = dd - dn * n;
  let tl = length(t);
  var kt = 0.0;
  if (tl > 0.0) {
    kt = min(P.friction * dn / tl, 1.0);
  }
  let v1 = v.zw - (dn * n + kt * t);
  let v0 = (mt * cm - m1 * v1) / m0;
  return vec4f(v0, v1);
}

fn bcAxis(v: f32, atMin: bool, atMax: bool, bcMin: u32, bcMax: u32) -> f32 {
  var r = v;
  if (atMin) {
    if (bcMin == BC_WALL && r < 0.0) { r = 0.0; }
    if (bcMin == BC_SYM) { r = 0.0; }
  }
  if (atMax) {
    if (bcMax == BC_WALL && r > 0.0) { r = 0.0; }
    if (bcMax == BC_SYM) { r = 0.0; }
  }
  return r;
}

// Граница — по номеру узла, а не по координате: origin + i·h во float32 не попадает точно в границу
fn atLeft(ix: u32) -> bool { return ix <= GRID_PAD; }
fn atRight(ix: u32) -> bool { return ix >= P.gx - 1u - GRID_PAD; }
fn atBottom(iy: u32) -> bool { return iy <= GRID_PAD; }
fn atTop(iy: u32) -> bool { return iy >= P.gy - 1u - GRID_PAD; }

fn applyBc(v: vec2f, ix: u32, iy: u32) -> vec2f {
  var r = vec2f(
    bcAxis(v.x, atLeft(ix), atRight(ix), P.bcLeft, P.bcRight),
    bcAxis(v.y, atBottom(iy), atTop(iy), P.bcBottom, P.bcTop),
  );
  if (P.lockX != 0u) {
    r.x = 0.0;
  }
  return r;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn gridUpdate(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid.x;
  if (id >= P.gn) {
    return;
  }
  var raw: array<i32, ${2 * GRID_ACC_PER_FIELD}>;
  var big = 0;
  for (var f = 0u; f < 2u; f++) {
    for (var k = 0u; k < ACC_N; k++) {
      let r = takeAcc(f, k, id);
      raw[f * ACC_N + k] = r;
      big = max(big, abs(r));
    }
  }
  if (big >= GUARD) {
    atomicOr(&stepState[S_FLAGS], 1u);
  }
  let dt = stepF(S_DT_CUR);
  var v = vec4f(0.0);
  var u = vec4f(0.0);
  var m = vec2f(0.0);
  var loss = 0.0;
  for (var f = 0u; f < 2u; f++) {
    let mf = f32(raw[f * ACC_N + A_M]) / P.massScale;
    m[f] = mf;
    if (mf <= 0.0) {
      continue;
    }
    let pv = vec2f(f32(raw[f * ACC_N + A_PX]), f32(raw[f * ACC_N + A_PY])) / P.momScale;
    let iv = vec2f(f32(raw[f * ACC_N + A_IX]), f32(raw[f * ACC_N + A_IY])) / P.momScale;
    let uf = (pv - iv) / mf;
    let vf = pv / mf + vec2f(0.0, dt * P.gravityY);
    v[2u * f] = vf.x;
    v[2u * f + 1u] = vf.y;
    u[2u * f] = uf.x;
    u[2u * f + 1u] = uf.y;
    let kp = f32(raw[f * ACC_N + A_K]) / P.kScale;
    // Без max(…, 0): шум округления фиксированной точки здесь двусторонний, срезка превратила бы его в нагрев
    loss += kp - 0.5 * mf * dot(uf, uf);
  }
  let ix = id % P.gx;
  let iy = id / P.gx;
  if (m.x > 0.0 && m.y > 0.0) {
    var g = vec2f(f32(raw[ACC_N + A_GX] - raw[A_GX]), f32(raw[ACC_N + A_GY] - raw[A_GY])) / P.gradScale;
    // На плоскости симметрии нет зеркальной половины массы — составляющая поперёк плоскости ложная;
    // в 1D (lockX) движения по x нет вовсе
    if (P.lockX != 0u || (atLeft(ix) && P.bcLeft == BC_SYM) || (atRight(ix) && P.bcRight == BC_SYM)) {
      g.x = 0.0;
    }
    if ((atBottom(iy) && P.bcBottom == BC_SYM) || (atTop(iy) && P.bcTop == BC_SYM)) {
      g.y = 0.0;
    }
    let len = length(g);
    if (len > 0.0) {
      let n = g / len;
      let k0 = 0.5 * (m.x * dot(u.xy, u.xy) + m.y * dot(u.zw, u.zw));
      u = contact(u, m.x, m.y, n);
      loss += max(k0 - 0.5 * (m.x * dot(u.xy, u.xy) + m.y * dot(u.zw, u.zw)), 0.0);
      v = contact(v, m.x, m.y, n);
    }
  }
  for (var f = 0u; f < 2u; f++) {
    if (m[f] <= 0.0) {
      continue;
    }
    let uf = vec2f(u[2u * f], u[2u * f + 1u]);
    let ku = 0.5 * m[f] * dot(uf, uf);
    let ub = applyBc(uf, ix, iy);
    loss += max(ku - 0.5 * m[f] * dot(ub, ub), 0.0);
    let vb = applyBc(vec2f(v[2u * f], v[2u * f + 1u]), ix, iy);
    v[2u * f] = vb.x;
    v[2u * f + 1u] = vb.y;
  }
  let g0 = GV_STRIDE * id;
  gridV[g0] = v.x;
  gridV[g0 + 1u] = v.y;
  gridV[g0 + 2u] = v.z;
  gridV[g0 + 3u] = v.w;
  var lambda = 0.0;
  if (m.x + m.y > 0.0) {
    lambda = loss / (m.x + m.y);
  }
  gridV[g0 + 4u] = lambda;
}

// ---------- Частицы: G2P + материал + перенос + P2G следующего шага ----------

@compute @workgroup_size(${WORKGROUP_SIZE})
fn g2p2g(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) {
    return;
  }
  var tag = tagOf(i);
  if ((tag & TAG_REMOVED) != 0u) {
    return;
  }
  let field = (tag >> 16u) & 1u;
  let x = vec2f(ld(P_X, i), ld(P_Y, i));
  let s = stencil(x);
  var nv = vec2f(0.0);
  var c = vec4f(0.0);
  var sumV2 = 0.0;
  var heatGrid = 0.0;
  for (var b = 0; b < 3; b++) {
    for (var a = 0; a < 3; a++) {
      let w = s.wx[a] * s.wy[b];
      let d = (vec2f(f32(a), f32(b)) - s.fx) * P.h;
      let g0 = GV_STRIDE * (u32(s.base.x + a) + u32(s.base.y + b) * P.gx);
      let gv = vec2f(gridV[g0 + 2u * field], gridV[g0 + 2u * field + 1u]);
      nv += w * gv;
      c += w * vec4f(gv.x * d.x, gv.x * d.y, gv.y * d.x, gv.y * d.y);
      sumV2 += w * dot(gv, gv);
      heatGrid += w * gridV[g0 + 4u];
    }
  }
  c *= 4.0 * P.invH * P.invH;

  let mat = P.mats[tag & 0xffu];
  let dt = stepF(S_DT_CUR);
  var dzz = 0.0;
  if (P.axisym != 0u) {
    dzz = nv.x / max(x.x, P.rmin);
  }
  // Потеря проекции сетка → частица (APIC) + удельные потери узлов — в тепло
  let heat = heatGrid + 0.5 * max(sumV2 - dot(nv, nv) - 0.25 * P.h * P.h * dot(c, c), 0.0);
  let s0 = MatState(
    ld(P_J, i), ld(P_SXX, i), ld(P_SYY, i), ld(P_SXY, i),
    ld(P_EPS, i), ld(P_E, i) + heat, ld(P_T, i) + heat / mat.cp, ld(P_D, i),
    ld(P_PHI, i),
  );
  let r = updateMaterial(mat, s0, c, dzz, dt);

  let nx = x + dt * nv;
  st(P_X, i, nx.x);
  st(P_Y, i, nx.y);
  st(P_J, i, r.s.J);
  st(P_SXX, i, r.s.sxx);
  st(P_SYY, i, r.s.syy);
  st(P_SXY, i, r.s.sxy);
  st(P_EPS, i, r.s.eps);
  st(P_E, i, r.s.e);
  st(P_T, i, r.s.T);
  st(P_D, i, r.s.D);
  st(P_PHI, i, r.s.phi);

  let margin = 1.5 * P.h;
  let out = nx.x < P.xmin - margin || nx.x > P.xmax + margin || nx.y < P.ymin - margin || nx.y > P.ymax + margin;
  if (P.storeAux != 0u || out) {
    st(P_VX, i, nv.x);
    st(P_VY, i, nv.y);
    st(P_C00, i, c.x);
    st(P_C01, i, c.y);
    st(P_C10, i, c.z);
    st(P_C11, i, c.w);
    var viz = 0.0;
    switch (P.vizMode) {
      case VIZ_SPEED: { viz = length(nv); }
      case VIZ_PRESSURE: { viz = r.p; }
      case VIZ_TEMPERATURE: { viz = r.s.T; }
      case VIZ_EPS: { viz = r.s.eps; }
      case VIZ_DAMAGE: { viz = r.s.D; }
      case VIZ_POROSITY: { viz = r.s.phi; }
      case VIZ_MISES: {
        let szz = -(r.s.sxx + r.s.syy);
        viz = sqrt(1.5 * (r.s.sxx * r.s.sxx + r.s.syy * r.s.syy + szz * szz + 2.0 * r.s.sxy * r.s.sxy));
      }
      default: {}
    }
    st(P_VIZ, i, viz);
  }
  if (out) {
    st(P_TAG, i, bitcast<f32>(tag | TAG_REMOVED));
    atomicAdd(&stepState[S_REMOVED], 1u);
    return;
  }
  atomicMax(&stepState[S_MAX_SIGNAL], bitcast<u32>(r.signal + length(nv)));
  scatter(i, tag, nx, nv, c, r.s.sxx, r.s.syy, r.s.sxy, r.p + r.q, r.s.J, stepF(S_DT_NEXT));
}

// ---------- Конец шага: время и Δt следующего шага по Куранту (4.3, шаг 7) ----------

@compute @workgroup_size(1)
fn finalize() {
  let dtCur = stepF(S_DT_CUR);
  // Время — сумма Кэхэна в f32
  let y = dtCur - stepF(S_TIME_C);
  let t0 = stepF(S_TIME);
  let t1 = t0 + y;
  atomicStore(&stepState[S_TIME_C], bitcast<u32>((t1 - t0) - y));
  atomicStore(&stepState[S_TIME], bitcast<u32>(t1));
  atomicStore(&stepState[S_DT_CUR], atomicLoad(&stepState[S_DT_NEXT]));
  let sig = bitcast<f32>(atomicLoad(&stepState[S_MAX_SIGNAL]));
  if (sig > 0.0) {
    atomicStore(&stepState[S_DT_NEXT], bitcast<u32>(P.cfl * P.dx / sig));
  }
  atomicStore(&stepState[S_MAX_SIGNAL], 0u);
  atomicAdd(&stepState[S_STEPS], 1u);
}
`;
