// Обновление материала частицы (4.3, шаг 5) во float64. WGSL (sim/kernels.ts, fn updateMaterial)
// повторяет этот код построчно — меняешь здесь, меняй там.

import {
  DamageModel,
  EPS_RATE_0,
  PHI_MAX,
  POROSITY_BISECT,
  SpallModel,
  StrengthModel,
  jcFractureStrain,
  jcYield,
  matrixJ,
  mgHugoniotPart,
  porousPressure,
  soundSpeed,
  voidThreshold,
  type KernelMaterial,
} from '../materials/models';
import { signalSpeed } from '../scene/scene';

export interface MatState {
  J: number;
  sxx: number;
  syy: number;
  sxy: number;
  eps: number;
  e: number;
  T: number;
  D: number;
  /** Пористость φ (откол) */
  phi: number;
}

export interface MatResult extends MatState {
  /** Давление EOS после шага, ГПа */
  p: number;
  /** Искусственная вязкость, ГПа (входит в напряжение следующего P2G и в энергию) */
  q: number;
  /** Скорость сигнала частицы без |v|, км/с — для Δt */
  signal: number;
}

/**
 * Давление из состояния: EOS пористой частицы P = (1 − φ)·P_MG(J_s, e) (у материала без модели пористости
 * φ = φ0 = 0, и это просто P_MG), а у разрушенного материала растяжение не держится (5.5).
 */
export function pressureOf(mat: KernelMaterial, J: number, e: number, D: number, phi: number): number {
  const p = porousPressure(mat, J, e, phi);
  return D >= 1 && p < 0 ? 0 : p;
}

/**
 * Перенапряжение роста пор: растяжение σ_m = −P сверх порога σ_eq(φ) открывает поры, давление сверх того же
 * порога схлопывает их. Разрушенный материал растяжения не держит.
 */
function poreOverstress(mat: KernelMaterial, phi: number, P: number, fractured: boolean): number {
  const seq = voidThreshold(mat, phi);
  const pc = fractured ? Math.max(P, 0) : P;
  return Math.max(-pc - seq, 0) - Math.max(pc - seq, 0);
}

/**
 * Пористость на конце шага (модифицированная Tepla, Nguyen et al. 2026, ур. 2.11 и 2.18):
 * φ̇ = (φ/η)·[⟨σ_m − σ_eq(φ)⟩ − ⟨P − σ_eq(φ)⟩]. Жёсткая (время релаксации η/(K·φ) — наносекунды), поэтому
 * неявный Эйлер по x = ln φ: R(x) = x − x_n − (dt/η)·g(e^x). R монотонно растёт по x (поры разгружают матрицу),
 * корень единственный — бисекция с фиксированным числом шагов, одинаковая на CPU и GPU.
 * pAt(φ) — давление частицы на конце шага при пористости φ.
 */
export function solvePorosity(
  mat: KernelMaterial,
  phiN: number,
  fractured: boolean,
  dt: number,
  pAt: (phi: number) => number,
): number {
  const g0 = poreOverstress(mat, phiN, pAt(phiN), fractured);
  // Нет перенапряжения — пористость та же; схлопывать уже нечего, если φ = φ0
  if (g0 === 0 || (g0 < 0 && phiN <= mat.phi0)) return phiN;
  const xn = Math.log(phiN);
  let lo = g0 > 0 ? xn : Math.log(mat.phi0);
  let hi = g0 > 0 ? Math.log(PHI_MAX) : xn;
  const k = dt / mat.etaV;
  for (let it = 0; it < POROSITY_BISECT; it++) {
    const x = 0.5 * (lo + hi);
    const phi = Math.exp(x);
    const r = x - xn - k * poreOverstress(mat, phi, pAt(phi), fractured);
    if (r > 0) hi = x;
    else lo = x;
  }
  return Math.exp(0.5 * (lo + hi));
}

export function hasShear(mat: KernelMaterial, D: number, T: number): boolean {
  if (mat.strength === StrengthModel.None || D >= 1) return false;
  return !(mat.strength === StrengthModel.JohnsonCook && T >= mat.Tm);
}

/**
 * Шаг материала: J, девиатор (гипоупругость с производной Яуманна + радиальный возврат по JC),
 * повреждение и откол, искусственная вязкость, энергия и давление (EOS), температура.
 * c = (C00, C01, C10, C11) — градиент скорости L ≈ C; dzz — скорость деформации вне плоскости
 * (0 в плоском режиме, v_r/r в осесимметричном). L — длина вязкости (шаг сетки), dxp — шаг частиц.
 */
export function updateMaterial(
  mat: KernelMaterial,
  s0: MatState,
  c: readonly [number, number, number, number],
  dzz: number,
  dt: number,
  L: number,
  c1: number,
  c2: number,
  dxp: number,
): MatResult {
  const [c00, c01, c10, c11] = c;
  const dxx = c00;
  const dyy = c11;
  const dxy = 0.5 * (c01 + c10);
  const w = 0.5 * (c01 - c10);
  const trD = dxx + dyy + dzz;

  const Jold = s0.J;
  const J = Jold * ((1 + dt * c00) * (1 + dt * c11) - dt * dt * c01 * c10) * (1 + dt * dzz);

  const third = trD / 3;
  const exx = dxx - third;
  const eyy = dyy - third;
  const ezz = dzz - third;

  const pOld = pressureOf(mat, Jold, s0.e, s0.D, s0.phi);
  const shear = hasShear(mat, s0.D, s0.T);
  const cOld = soundSpeed(mat, matrixJ(mat, Jold, s0.phi), pOld, shear);
  // Пористая частица: напряжение — доля (1 − φ) напряжения матрицы (Nguyen et al. 2026, ур. 2.6)
  const solid = 1 - s0.phi;

  // Искусственная вязкость фон Неймана–Рихтмайера (4.3), только при сжатии
  const rho = mat.rho0 / J;
  const q = trD < 0 ? rho * L * (c1 * L * trD * trD - c2 * cOld * trD) : 0;

  // Девиатор: s' = s + dt·(2G·D' + W·s − s·W)
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let dEps = 0;
  let D = s0.D;
  let sigmaY = 0;
  if (shear) {
    const G = solid * mat.G;
    sxx = s0.sxx + dt * (2 * G * exx + 2 * w * s0.sxy);
    syy = s0.syy + dt * (2 * G * eyy - 2 * w * s0.sxy);
    sxy = s0.sxy + dt * (2 * G * dxy + w * (s0.syy - s0.sxx));
    if (mat.strength === StrengthModel.JohnsonCook) {
      const szz = -(sxx + syy);
      const seq = Math.sqrt(1.5 * (sxx * sxx + syy * syy + szz * szz + 2 * sxy * sxy));
      const rateStar = Math.sqrt((2 / 3) * (exx * exx + eyy * eyy + ezz * ezz + 2 * dxy * dxy)) / EPS_RATE_0;
      sigmaY = solid * jcYield(mat, s0.eps, rateStar, s0.T);
      if (seq > sigmaY) {
        dEps = (seq - sigmaY) / (3 * G);
        const k = seq > 0 ? sigmaY / seq : 0;
        sxx *= k;
        syy *= k;
        sxy *= k;
        if (mat.damage === DamageModel.JohnsonCook) {
          const triax = -pOld / Math.max(sigmaY, 1e-9);
          D = Math.min(D + dEps / jcFractureStrain(mat, triax, rateStar, s0.T), 1);
        }
      }
    }
  }
  const szz0 = -(s0.sxx + s0.syy);
  const szz = -(sxx + syy);

  // Энергия: работа девиатора (среднее s) и объёмная работа (p + q) со схемой трапеций;
  // Ми–Грюнайзен линеен по e, поэтому p_new находится явно.
  const vMid = (0.5 * (Jold + J)) / mat.rho0;
  const wDev =
    0.5 *
    ((s0.sxx + sxx) * dxx + (s0.syy + syy) * dyy + (szz0 + szz) * dzz + 2 * (s0.sxy + sxy) * dxy);
  const dv = (J - Jold) / mat.rho0;
  const eStar = s0.e + dt * wDev * vMid - (0.5 * pOld + q) * dv;
  const B = mat.gamma0 * mat.rho0;
  // Давление на конце шага при пористости φ: P = (1 − φ)·(A(η_s) + B·e), e = e* − ½·P·dv
  const pAt = (phi: number) => {
    const k = 1 - phi;
    return (k * (mgHugoniotPart(mat, 1 - matrixJ(mat, J, phi)).a + B * eStar)) / (1 + 0.5 * k * B * dv);
  };
  // Откол (5.5): поры растут под растяжением сверх порога и разгружают его; разрушение при φ ≥ φ_f
  let phi = s0.phi;
  if (mat.spall === SpallModel.Porosity) phi = solvePorosity(mat, s0.phi, s0.D >= 1, dt, pAt);
  let p = pAt(phi);
  let e = eStar - 0.5 * p * dv;
  // Разрушение: φ ≥ φ_f или раскрытие φ·Δx ≥ δ_c — откол локализуется в один ряд частиц, на шаге
  // 0,17–1,9 мм пористость ряда мала, а раскрытие от шага почти не зависит
  if (mat.spall === SpallModel.Porosity && (phi >= mat.phiF || phi * dxp >= mat.deltaC)) D = 1;
  if (D >= 1) {
    sxx = 0;
    syy = 0;
    sxy = 0;
    if (p < 0) {
      p = 0;
      e = eStar;
    }
  }

  // Температура: доля β пластической работы (сдвиг и рост/схлопывание пор) + нагрев искусственной
  // вязкостью (ударный, 5.6)
  const dPhi = phi - s0.phi;
  const poreWork = (Math.max(-p, 0) * Math.max(dPhi, 0) + Math.max(p, 0) * Math.max(-dPhi, 0)) / (1 - phi);
  const heat = (mat.beta * (sigmaY * dEps + poreWork)) / rho + q * Math.max(-dv, 0);
  const T = s0.T + heat / mat.cp;

  const cNew = soundSpeed(mat, matrixJ(mat, J, phi), p, hasShear(mat, D, T));
  return {
    J,
    sxx,
    syy,
    sxy,
    eps: s0.eps + dEps,
    e,
    T,
    D,
    phi,
    p,
    q,
    signal: signalSpeed(cNew, trD, L, c1, c2),
  };
}
