// Самопроверка ядра на устройстве: детерминизм (12.10) и совпадение GPU с CPU-эталоном
// в каждом режиме хранения частиц. Полный гейт M1 — относительный допуск 1e-4 на малых сценах;
// в M0 смотрим порядок расхождения.

import { CpuMpm } from '../cpu-ref/CpuMpm';
import { demoScene } from '../scene/scenes';
import type { PreparedScene } from '../scene/scene';
import { GpuMpm } from './GpuMpm';
import { PLANE, type StorageMode } from './layout';

export interface SelfTestModeResult {
  mode: StorageMode;
  /** Два GPU-прогона одного сценария совпали побитово */
  deterministic: boolean;
  /** Максимальное расхождение положений GPU (f32 + фиксированная точка) и CPU (f64), в шагах сетки */
  maxPositionErrorCells: number;
  /** То же для скорости, относительно максимальной скорости в сцене */
  maxVelocityErrorRel: number;
  fixedPointOverflow: boolean;
  /** Режим l2: результат побитово равен полному режиму (качество счёта то же) */
  sameAsFull?: boolean;
  passed: boolean;
}

export interface SelfTestReport {
  steps: number;
  n: number;
  modes: SelfTestModeResult[];
  passed: boolean;
}

/**
 * Допуски самопроверки M0. На SwiftShader наблюдается 4,5e-5 ячейки и 2,8e-6 от v_max,
 * на телефоне (Mali) — 9,2e-5 и 1,5e-5; запас на FMA и пониженную точность log() мобильных GPU.
 */
export const SELFTEST_TOLERANCE = { positionCells: 1e-3, velocityRel: 1e-3 };

const MODES: StorageMode[] = ['full', 'l2'];

export async function runSelfTest(device: GPUDevice, steps = 300, across = 16): Promise<SelfTestReport> {
  const scene = demoScene({ across });
  const cpu = new CpuMpm(scene);
  cpu.step(steps);
  const modes: SelfTestModeResult[] = [];
  let fullData: Float32Array | undefined;
  for (const mode of MODES) {
    const { result, data } = await checkMode(device, scene, cpu, steps, mode);
    if (mode === 'full') fullData = data;
    else if (fullData) {
      result.sameAsFull = bytesEqual(data, fullData);
      result.passed &&= result.sameAsFull;
    }
    modes.push(result);
  }
  return { steps, n: scene.n, modes, passed: modes.every((m) => m.passed) };
}

async function checkMode(
  device: GPUDevice,
  scene: PreparedScene,
  cpu: CpuMpm,
  steps: number,
  mode: StorageMode,
): Promise<{ result: SelfTestModeResult; data: Float32Array }> {
  const runGpu = async () => {
    const sim = await GpuMpm.create(device, scene, { mode });
    // Последний шаг пишет v — его сравниваем с эталоном
    sim.step(steps, true);
    const data = await sim.readParticles();
    const status = await sim.readStatus();
    sim.destroy();
    return { data, status };
  };
  const a = await runGpu();
  const b = await runGpu();
  const deterministic = bytesEqual(a.data, b.data);

  const n = scene.n;
  let posErr = 0;
  let velErr = 0;
  let vMax = 0;
  for (let i = 0; i < n; i++) {
    posErr = Math.max(
      posErr,
      Math.abs(a.data[PLANE.X * n + i] - cpu.get(PLANE.X, i)),
      Math.abs(a.data[PLANE.Y * n + i] - cpu.get(PLANE.Y, i)),
    );
    velErr = Math.max(
      velErr,
      Math.abs(a.data[PLANE.VX * n + i] - cpu.get(PLANE.VX, i)),
      Math.abs(a.data[PLANE.VY * n + i] - cpu.get(PLANE.VY, i)),
    );
    vMax = Math.max(vMax, Math.hypot(cpu.get(PLANE.VX, i), cpu.get(PLANE.VY, i)));
  }
  const maxPositionErrorCells = posErr / scene.h;
  const maxVelocityErrorRel = velErr / vMax;
  const fixedPointOverflow = (a.status | b.status) !== 0;
  return {
    data: a.data,
    result: {
      mode,
      deterministic,
      maxPositionErrorCells,
      maxVelocityErrorRel,
      fixedPointOverflow,
      passed:
        deterministic &&
        !fixedPointOverflow &&
        maxPositionErrorCells < SELFTEST_TOLERANCE.positionCells &&
        maxVelocityErrorRel < SELFTEST_TOLERANCE.velocityRel,
    },
  };
}

function bytesEqual(a: Float32Array, b: Float32Array): boolean {
  const ua = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const ub = new Uint32Array(b.buffer, b.byteOffset, b.length);
  if (ua.length !== ub.length) return false;
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}
