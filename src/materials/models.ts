// Модели материалов раздела 5 в float64. CPU-эталон считает ими же; WGSL в sim/kernels.ts
// повторяет формулы построчно — меняешь здесь, меняй там.
// Единицы ядра (4.6): г/см³, км/с, ГПа, мкс; удельная энергия e — в (км/с)² = Дж/мг.

/** Комнатная температура, K — T_r в Джонсоне–Куке и начальная температура частиц */
export const T_ROOM = 293;
/** ε̇0 = 1 с⁻¹ в мкс⁻¹ */
export const EPS_RATE_0 = 1e-6;

export enum StrengthModel {
  None = 0,
  Elastic = 1,
  JohnsonCook = 2,
}

export enum DamageModel {
  None = 0,
  JohnsonCook = 1,
}

/** Откол (5.5): нет или пористость с вязким ростом пор и релаксацией растяжения. */
export enum SpallModel {
  None = 0,
  Porosity = 1,
}

/**
 * Константы поверхности Гурсона в модели откола (модифицированная Tepla, Nguyen et al. 2026, табл. 3:
 * q1 = 1, q2 = 1,5, q3 = q1² — одни для меди и тантала).
 */
export const GURSON_Q1 = 1;
export const GURSON_Q2 = 1.5;

/** Шагов бисекции пористости: ширина ln(0,95/φ0) < 10 сходится до 10·2⁻²⁴ ≈ 6·10⁻⁷ — предел float32. */
export const POROSITY_BISECT = 24;
/** Верхняя граница пористости в решателе */
export const PHI_MAX = 0.95;

/** Параметры материала в единицах ядра — то, что уходит в uniform GPU. */
export interface KernelMaterial {
  rho0: number;
  C0: number;
  s: number;
  gamma0: number;
  G: number;
  A: number;
  B: number;
  n: number;
  C: number;
  m: number;
  Tm: number;
  /** Дж/(мг·K) */
  cp: number;
  beta: number;
  D: [number, number, number, number, number];
  strength: StrengthModel;
  damage: DamageModel;
  spall: SpallModel;
  /** Откол: начальная пористость φ0 */
  phi0: number;
  /** Откол: прочность матрицы при росте пор Y_sat, ГПа */
  ysat: number;
  /** Откол: вязкость роста пор η, ГПа·мкс */
  etaV: number;
  /** Откол: пористость разрушения φ_f */
  phiF: number;
  /** Откол: раскрытие разрушения δ_c = φ·Δx, мм (регуляризация «полосой трещины» на шаге частиц) */
  deltaC: number;
}

/** Предел сжатия для знаменателя (1 − sη)²: дальше линейная адиабата теряет смысл. */
export function etaMax(mat: KernelMaterial): number {
  return mat.s > 0 ? 0.9 / mat.s : 0.9;
}

/** Холодная/ударная часть Ми–Грюнайзена A(η) и её производная по η. */
export function mgHugoniotPart(mat: KernelMaterial, eta: number): { a: number; da: number } {
  const k = mat.rho0 * mat.C0 * mat.C0;
  if (eta < 0) return { a: k * eta, da: k };
  const x = Math.min(eta, etaMax(mat));
  const den = 1 - mat.s * x;
  const a = (k * x * (1 - 0.5 * mat.gamma0 * x)) / (den * den);
  const da = (k * ((1 - mat.gamma0 * x) * den + 2 * mat.s * x * (1 - 0.5 * mat.gamma0 * x))) / (den * den * den);
  return { a, da };
}

/** Давление Ми–Грюнайзена (5.1): p = A(η) + Γ0·ρ0·e, η = 1 − ρ0/ρ = 1 − J. */
export function mgPressure(mat: KernelMaterial, J: number, e: number): number {
  return mgHugoniotPart(mat, 1 - J).a + mat.gamma0 * mat.rho0 * e;
}

/**
 * Продольная скорость звука c = √((K_s + 4/3·G)/ρ), K_s = J·(A′(η) + Γ0·p) — изэнтропический модуль
 * уравнения Ми–Грюнайзена. Разрушенный или расплавленный материал теряет сдвиговую жёсткость.
 */
export function soundSpeed(mat: KernelMaterial, J: number, p: number, shear: boolean): number {
  const { da } = mgHugoniotPart(mat, 1 - J);
  const k0 = mat.rho0 * mat.C0 * mat.C0;
  const ks = Math.max(J * (da + mat.gamma0 * Math.max(p, 0)), 0.1 * k0);
  const rho = mat.rho0 / J;
  return Math.sqrt((ks + (shear ? (4 / 3) * mat.G : 0)) / rho);
}

/** Гомологическая температура T* ∈ [0, 1]. */
export function homologousT(mat: KernelMaterial, T: number): number {
  return Math.min(Math.max((T - T_ROOM) / (mat.Tm - T_ROOM), 0), 1);
}

/** Предел текучести Джонсона–Кука (5.2), ГПа. rateStar = ε̇/ε̇0 ≥ 1. */
export function jcYield(mat: KernelMaterial, epsP: number, rateStar: number, T: number): number {
  if (T >= mat.Tm) return 0;
  const hard = mat.A + (epsP > 0 ? mat.B * Math.pow(epsP, mat.n) : 0);
  const rate = 1 + mat.C * Math.log(Math.max(rateStar, 1));
  const tstar = homologousT(mat, T);
  const therm = 1 - (tstar > 0 ? Math.pow(tstar, mat.m) : 0);
  return hard * rate * therm;
}

/** Деформация разрушения Джонсона–Кука (5.5); triax = −p/σ_eq. */
export function jcFractureStrain(mat: KernelMaterial, triax: number, rateStar: number, T: number): number {
  const [D1, D2, D3, D4, D5] = mat.D;
  const ef =
    (D1 + D2 * Math.exp(D3 * triax)) * (1 + D4 * Math.log(Math.max(rateStar, 1))) * (1 + D5 * homologousT(mat, T));
  return Math.max(ef, 1e-3);
}

/**
 * Порог роста пор при всестороннем растяжении (Nguyen et al. 2026, ур. 2.8 при τ = 0 и q3 = q1²):
 * σ_eq(φ) = 2·Y_sat/(3·q2) · ln(1/(q1·φ)), ГПа, растяжение положительно. Тот же порог — для схлопывания
 * пор при сжатии.
 */
export function voidThreshold(mat: KernelMaterial, phi: number): number {
  return ((2 * mat.ysat) / (3 * GURSON_Q2)) * Math.log(1 / (GURSON_Q1 * phi));
}

/** Объём матрицы пористой частицы J_s = J·(1 − φ)/(1 − φ0): в начале J_s = 1. */
export function matrixJ(mat: KernelMaterial, J: number, phi: number): number {
  return (J * (1 - phi)) / (1 - mat.phi0);
}

/** Давление пористой частицы (Nguyen et al. 2026, ур. 2.7): P = (1 − φ)·P_MG(J_s, e). */
export function porousPressure(mat: KernelMaterial, J: number, e: number, phi: number): number {
  return (1 - phi) * mgPressure(mat, matrixJ(mat, J, phi), e);
}

/** Аналитическая ударная адиабата Us = C0 + s·up, p = ρ0·Us·up (5.1) — эталон теста 12.1. */
export function hugoniot(mat: KernelMaterial, up: number): { Us: number; p: number; eta: number } {
  const Us = mat.C0 + mat.s * up;
  return { Us, p: mat.rho0 * Us * up, eta: up / Us };
}
