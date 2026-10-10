// Ядро на GPU за интерфейсом Engine: пачки шагов до нужного времени, снимок — чтение буфера частиц.

import type { PreparedScene } from '../scene/scene';
import { GpuMpm } from '../sim/GpuMpm';
import { PLANE, type StorageMode } from '../sim/layout';
import type { Engine, EngineFactory, Snapshot } from './engine';

/** Шагов в одной отправке: пачка короткая для сторожевого таймера GPU и отзывчивого интерфейса. */
const MAX_BATCH = 400;

export class GpuEngine implements Engine {
  readonly kind = 'gpu';
  /** Узел сетки подходил к пределу i32 фиксированной точки хотя бы раз */
  overflow = false;

  private constructor(readonly sim: GpuMpm) {}

  get scene(): PreparedScene {
    return this.sim.scene;
  }

  static async create(device: GPUDevice, scene: PreparedScene, mode?: StorageMode): Promise<GpuEngine> {
    return new GpuEngine(await GpuMpm.create(device, scene, { mode }));
  }

  async runTo(t: number): Promise<void> {
    let info = this.sim.info;
    while (info.time < t) {
      // Δt меняется по Куранту — пачка по последнему прочитанному, ближе к t пачки короче
      const steps = Math.max(1, Math.min(MAX_BATCH, Math.floor((t - info.time) / info.dt)));
      // v, C и VIZ пишутся в конце каждой пачки: снимок в любой момент полный и в режиме l2
      this.sim.step(steps, true);
      info = await this.sim.readStep();
      this.overflow ||= info.overflow;
    }
  }

  async snapshot(): Promise<Snapshot> {
    const info = await this.sim.readStep();
    const planes = await this.sim.readParticles();
    const n = this.sim.n;
    return {
      n,
      time: info.time,
      steps: info.steps,
      planes,
      tags: new Uint32Array(planes.buffer, PLANE.TAG * n * 4, n).slice(),
    };
  }

  destroy(): void {
    this.sim.destroy();
  }
}

export function gpuEngine(device: GPUDevice, mode?: StorageMode): EngineFactory {
  return (scene) => GpuEngine.create(device, scene, mode);
}
