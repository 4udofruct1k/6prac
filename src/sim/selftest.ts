// Самопроверка ядра на устройстве: детерминизм (12.10) и совпадение GPU с CPU-эталоном.
// Полный гейт M1 — относительный допуск 1e-4 на малых сценах; в M0 смотрим порядок расхождения.

import { CpuMpm } from '../cpu-ref/CpuMpm';
import { demoScene } from '../scene/scenes';
import { GpuMpm } from './GpuMpm';
import { PLANE } from './layout';

export interface SelfTestReport {
  steps: number;
  n: number;
  /** Два GPU-прогона одного сценария совпали побитово */
  deterministic: boolean;
  /** Максимальное расхождение положений GPU (f32 + фиксированная точка) и CPU (f64), в шагах сетки */
  maxPositionErrorCells: number;
  /** То же для скорости, относительно максимальной скорости в сцене */
  maxVelocityErrorRel: number;
  fixedPointOverflow: boolean;
  passed: boolean;
}

/**
 * Допуски самопроверки M0. На SwiftShader наблюдается 4,5e-5 ячейки и 2,8e-6 от v_max;
 * запас на FMA и пониженную точность log() мобильных GPU.
 */
export const SELFTEST_TOLERANCE = { positionCells: 1e-3, velocityRel: 1e-3 };

export async function runSelfTest(device: GPUDevice, steps = 300, across = 16): Promise<SelfTestReport> {
  const scene = demoScene({ across });

  const runGpu = async () => {
    const sim = await GpuMpm.create(device, scene);
    sim.step(steps);
    const data = await sim.readParticles();
    const status = await sim.readStatus();
    sim.destroy();
    return { data, status };
  };
  const a = await runGpu();
  const b = await runGpu();
  const deterministic = bytesEqual(a.data, b.data);

  const cpu = new CpuMpm(scene);
  cpu.step(steps);

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
    steps,
    n,
    deterministic,
    maxPositionErrorCells,
    maxVelocityErrorRel,
    fixedPointOverflow,
    passed:
      deterministic &&
      !fixedPointOverflow &&
      maxPositionErrorCells < SELFTEST_TOLERANCE.positionCells &&
      maxVelocityErrorRel < SELFTEST_TOLERANCE.velocityRel,
  };
}

function bytesEqual(a: Float32Array, b: Float32Array): boolean {
  const ua = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const ub = new Uint32Array(b.buffer, b.byteOffset, b.length);
  if (ua.length !== ub.length) return false;
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}
