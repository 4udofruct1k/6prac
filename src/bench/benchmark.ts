// Бенчмарк M0 «частиц × шагов в секунду» по пресетам 2.1 на нагрузке benchScene.
// Результат фиксирует финальные числа частиц пресетов (гейт M0).

import { benchScene } from '../scene/scenes';
import { GpuMpm } from '../sim/GpuMpm';
import { DEFAULT_STORAGE_MODE, PLANE, type StorageMode } from '../sim/layout';
import { errorText } from '../sim/gpu';

export interface BenchCase {
  id: string;
  label: string;
  n: number;
  /** Режим хранения частиц; по умолчанию DEFAULT_STORAGE_MODE */
  mode?: StorageMode;
}

export interface BenchResult {
  id: string;
  label: string;
  mode: StorageMode;
  nTarget: number;
  n: number;
  dxMm: number;
  gridNodes: number;
  /** Данные, которые шаг трогает в памяти (частицы по режиму + сетка), МБ — сравнивать с кэшем L2 */
  workingSetMB: number;
  dtNs: number;
  steps: number;
  seconds: number;
  stepsPerSec: number;
  msPerStep: number;
  /** Миллионов частице-шагов в секунду */
  mpsPerSec: number;
  /** Мкс события за секунду экрана */
  simUsPerSec: number;
  /** Секунд счёта на событие 100 и 300 мкс (2.2) */
  wallSecFor100us: number;
  wallSecFor300us: number;
  /** Все координаты конечны после прогона */
  finite: boolean;
  /** Узел сетки подходил к пределу i32 */
  fixedPointOverflow: boolean;
  error?: string;
}

export interface BenchOptions {
  /** Сколько секунд мерить каждый пресет */
  seconds: number;
  maxSteps?: number;
  signal?: AbortSignal;
}

const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

export async function runBenchCase(device: GPUDevice, c: BenchCase, opts: BenchOptions): Promise<BenchResult> {
  const base: BenchResult = {
    id: c.id,
    label: c.label,
    mode: c.mode ?? DEFAULT_STORAGE_MODE,
    nTarget: c.n,
    n: 0,
    dxMm: 0,
    gridNodes: 0,
    workingSetMB: 0,
    dtNs: 0,
    steps: 0,
    seconds: 0,
    stepsPerSec: 0,
    msPerStep: 0,
    mpsPerSec: 0,
    simUsPerSec: 0,
    wallSecFor100us: 0,
    wallSecFor300us: 0,
    finite: false,
    fixedPointOverflow: false,
  };
  let sim: GpuMpm | undefined;
  try {
    const scene = benchScene(c.n);
    Object.assign(base, { n: scene.n, dxMm: scene.dx, gridNodes: scene.gx * scene.gy, dtNs: scene.dt * 1000 });
    await yieldToUi();
    sim = await GpuMpm.create(device, scene, { mode: base.mode });
    base.workingSetMB = sim.workingSetBytes / 1e6;

    // Прогрев: компиляция конвейеров, первые выделения памяти
    sim.step(5);
    await device.queue.onSubmittedWorkDone();

    const maxSteps = opts.maxSteps ?? 1_000_000;
    let steps = 0;
    let batch = 4;
    const t0 = performance.now();
    let elapsed = 0;
    while (elapsed < opts.seconds * 1000 && steps < maxSteps && !opts.signal?.aborted) {
      const n = Math.min(batch, maxSteps - steps);
      // v, C и VIZ не нужны: проверка читает только x
      sim.step(n, false);
      await device.queue.onSubmittedWorkDone();
      steps += n;
      elapsed = performance.now() - t0;
      // Пачка ≈ 100 мс: накладные расходы submit малы, интерфейс отзывчив
      const msPerStep = elapsed / steps;
      batch = Math.max(1, Math.min(2000, Math.round(100 / msPerStep)));
    }

    const seconds = elapsed / 1000;
    const stepsPerSec = steps / seconds;
    // Плоскости X и Y идут первыми — читаем только их
    const snapshot = await sim.readParticles(PLANE.Y + 1);
    let finite = true;
    for (let i = 0; i < snapshot.length && finite; i++) finite = Number.isFinite(snapshot[i]);

    return {
      ...base,
      steps,
      seconds,
      stepsPerSec,
      msPerStep: 1000 / stepsPerSec,
      mpsPerSec: (stepsPerSec * scene.n) / 1e6,
      simUsPerSec: stepsPerSec * scene.dt,
      wallSecFor100us: 100 / scene.dt / stepsPerSec,
      wallSecFor300us: 300 / scene.dt / stepsPerSec,
      finite,
      fixedPointOverflow: (await sim.readStatus()) !== 0,
    };
  } catch (e) {
    return { ...base, error: errorText(e) };
  } finally {
    sim?.destroy();
  }
}

export async function runBenchmark(
  device: GPUDevice,
  cases: BenchCase[],
  opts: BenchOptions,
  onResult?: (r: BenchResult, index: number) => void,
): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  for (const [i, c] of cases.entries()) {
    if (opts.signal?.aborted) break;
    const r = await runBenchCase(device, c, opts);
    results.push(r);
    onResult?.(r, i);
  }
  return results;
}
