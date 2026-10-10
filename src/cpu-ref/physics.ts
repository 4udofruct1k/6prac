// Обновление материала частицы (4.3, шаг 5) во float64. WGSL (sim/kernels.ts, fn updateMaterial)
// повторяет этот код построчно — меняешь здесь, меняй там.

import {
  DamageModel,
  EPS_RATE_0,
  StrengthModel,
  jcFractureStrain,
  jcYield,
  mgHugoniotPart,
  mgPressure,
  soundSpeed,
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
}

export interface MatResult extends MatState {
  /** Давление EOS после шага, ГПа */
  p: number;
  /** Искусственная вязкость, ГПа (входит в напряжение следующего P2G и в энергию) */
  q: number;
  /** Скорость сигнала частицы без |v|, км/с — для Δt */
  signal: number;
}

/** Давление из состояния: EOS, а у разрушенного материала растяжение не держится (5.5). */
export function pressureOf(mat: KernelMaterial, J: number, e: number, D: number): number {
  const p = mgPressure(mat, J, e);
  return D >= 1 && p < 0 ? 0 : p;
}

export function hasShear(mat: KernelMaterial, D: number, T: number): boolean {
  if (mat.strength === StrengthModel.None || D >= 1) return false;
  return !(mat.strength === StrengthModel.JohnsonCook && T >= mat.Tm);
}

/**
 * Шаг материала: J, девиатор (гипоупругость с производной Яуманна + радиальный возврат по JC),
 * повреждение и откол, искусственная вязкость, энергия и давление (EOS), температура.
 * c = (C00, C01, C10, C11) — градиент скорости L ≈ C; dzz — скорость деформации вне плоскости
 * (0 в плоском режиме, v_r/r в осесимметричном). L — длина вязкости (шаг сетки).
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

  const pOld = pressureOf(mat, Jold, s0.e, s0.D);
  const shear = hasShear(mat, s0.D, s0.T);
  const cOld = soundSpeed(mat, Jold, pOld, shear);

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
    const G = mat.G;
    sxx = s0.sxx + dt * (2 * G * exx + 2 * w * s0.sxy);
    syy = s0.syy + dt * (2 * G * eyy - 2 * w * s0.sxy);
    sxy = s0.sxy + dt * (2 * G * dxy + w * (s0.syy - s0.sxx));
    if (mat.strength === StrengthModel.JohnsonCook) {
      const szz = -(sxx + syy);
      const seq = Math.sqrt(1.5 * (sxx * sxx + syy * syy + szz * szz + 2 * sxy * sxy));
      const rateStar = Math.sqrt((2 / 3) * (exx * exx + eyy * eyy + ezz * ezz + 2 * dxy * dxy)) / EPS_RATE_0;
      sigmaY = jcYield(mat, s0.eps, rateStar, s0.T);
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
  let p = (mgHugoniotPart(mat, 1 - J).a + B * eStar) / (1 + 0.5 * B * dv);
  let e = eStar - 0.5 * p * dv;

  // Откол: растяжение ниже p_min — мгновенное разрушение (5.5)
  if (p < mat.pmin) D = 1;
  if (D >= 1) {
    sxx = 0;
    syy = 0;
    sxy = 0;
    if (p < 0) {
      p = 0;
      e = eStar;
    }
  }

  // Температура: доля β пластической работы + нагрев искусственной вязкостью (ударный, 5.6)
  const heat = (mat.beta * sigmaY * dEps) / rho + q * Math.max(-dv, 0);
  const T = s0.T + heat / mat.cp;

  const cNew = soundSpeed(mat, J, p, hasShear(mat, D, T));
  return {
    J,
    sxx,
    syy,
    sxy,
    eps: s0.eps + dEps,
    e,
    T,
    D,
    p,
    q,
    signal: signalSpeed(cNew, trD, L, c1, c2),
  };
}
