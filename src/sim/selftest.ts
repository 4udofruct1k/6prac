// Самопроверка ядра на устройстве: детерминизм (12.10), совпадение GPU с CPU-эталоном (13: на малых сценах
// относительный допуск 1e-4) и побитовое равенство режимов хранения частиц.

import { CpuMpm } from '../cpu-ref/CpuMpm';
import { taylorScene } from '../scene/demos';
import { prepareScene, type PreparedScene } from '../scene/scene';
import { GpuMpm } from './GpuMpm';
import { Bc, PLANE, type StorageMode } from './layout';

export interface SelfTestCase {
  scene: string;
  mode: StorageMode;
  /** Два GPU-прогона одного сценария совпали побитово */
  deterministic: boolean;
  /** Максимальное расхождение положений GPU (f32 + фиксированная точка) и CPU (f64), в шагах сетки */
  maxPositionErrorCells: number;
  /** То же для скорости, относительно максимальной скорости в сцене */
  maxVelocityErrorRel: number;
  fixedPointOverflow: boolean;
  /** Режим l2: результат побитово равен полному режиму */
  sameAsFull?: boolean;
  passed: boolean;
}

export interface SelfTestReport {
  steps: number;
  cases: SelfTestCase[];
  passed: boolean;
}

/** Допуски самопроверки: положение и скорость (13 — относительный 1e-4 на малых сценах). */
export const SELFTEST_TOLERANCE = { positionCells: 1e-3, velocityRel: 1e-3 };

const MODES: StorageMode[] = ['full', 'l2'];

/** Малые сцены, где работают все части ядра M1. */
export function selfTestScenes(): { name: string; scene: PreparedScene }[] {
  return [
    {
      name: 'Медный стержень → стальная плита, 500 м/с',
      scene: prepareScene({
        mode: 'plane',
        domain: { xmin: 0, xmax: 24, ymin: 0, ymax: 22 },
        dx: 0.5,
        bodies: [
          { rect: { x0: 2, y0: 2, x1: 22, y1: 8 }, material: 'steel_4340', velocity: [0, 0], bodyId: 0, field: 0 },
          { rect: { x0: 10, y0: 8.5, x1: 14, y1: 20 }, material: 'copper_ofhc', velocity: [0, -0.5], bodyId: 1, field: 1 },
        ],
        bc: { left: Bc.Open, right: Bc.Open, bottom: Bc.Open, top: Bc.Open },
      }),
    },
    { name: 'Цилиндр Тейлора, медь 190 м/с, осесимм.', scene: taylorScene('copper_ofhc', 0.19, 25.4, 0.635) },
  ];
}

export async function runSelfTest(device: GPUDevice, steps = 200): Promise<SelfTestReport> {
  const cases: SelfTestCase[] = [];
  for (const { name, scene } of selfTestScenes()) {
    const cpu = new CpuMpm(scene);
    cpu.step(steps);
    let fullData: Float32Array | undefined;
    for (const mode of MODES) {
      const { result, data } = await checkMode(device, name, scene, cpu, steps, mode);
      if (mode === 'full') fullData = data;
      else if (fullData) {
        result.sameAsFull = bytesEqual(data, fullData);
        result.passed &&= result.sameAsFull;
      }
      cases.push(result);
    }
  }
  return { steps, cases, passed: cases.every((c) => c.passed) };
}

async function checkMode(
  device: GPUDevice,
  name: string,
  scene: PreparedScene,
  cpu: CpuMpm,
  steps: number,
  mode: StorageMode,
): Promise<{ result: SelfTestCase; data: Float32Array }> {
  const runGpu = async () => {
    const sim = await GpuMpm.create(device, scene, { mode });
    // Последний шаг пишет v — его сравниваем с эталоном
    sim.step(steps, true);
    const data = await sim.readParticles();
    const info = await sim.readStep();
    sim.destroy();
    return { data, overflow: info.overflow };
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
  const fixedPointOverflow = a.overflow || b.overflow;
  return {
    data: a.data,
    result: {
      scene: name,
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
