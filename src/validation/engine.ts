// Решатель для тестов раздела 12 за одним интерфейсом: CPU-эталон (vitest, CI) или ядро на GPU
// (e2e, вкладка «Валидация»). Сценарий гонит решатель до нужного времени и меряет снимок частиц.

import { CpuMpm } from '../cpu-ref/CpuMpm';
import type { PreparedScene } from '../scene/scene';
import type { ParticleView } from '../sim/diagnostics';

export interface Snapshot extends ParticleView {
  /** Время события, мкс */
  time: number;
  steps: number;
  /** Плоскости частиц: float64 у CPU-эталона, float32 с GPU */
  planes: Float64Array | Float32Array;
  tags: Uint32Array;
}

export type EngineKind = 'cpu' | 'gpu';

export interface Engine {
  readonly kind: EngineKind;
  readonly scene: PreparedScene;
  /** Узел сетки подходил к пределу i32 фиксированной точки (GPU) */
  readonly overflow?: boolean;
  /** Считать, пока время события не дойдёт до t, мкс (последний шаг может перейти t). */
  runTo(t: number): Promise<void>;
  snapshot(): Promise<Snapshot>;
  destroy(): void;
}

/** Фабрика решателя: сценарий строит сцену, раннер даёт ему движок. */
export type EngineFactory = (scene: PreparedScene) => Promise<Engine>;

export class CpuEngine implements Engine {
  readonly kind = 'cpu';
  readonly sim: CpuMpm;

  constructor(readonly scene: PreparedScene) {
    this.sim = new CpuMpm(scene);
  }

  async runTo(t: number): Promise<void> {
    while (this.sim.time < t) this.sim.step(1);
  }

  async snapshot(): Promise<Snapshot> {
    return {
      n: this.sim.n,
      time: this.sim.time,
      steps: this.sim.stepCount,
      planes: this.sim.p.slice(),
      tags: this.sim.tags.slice(),
    };
  }

  destroy(): void {}
}

export const cpuEngine: EngineFactory = async (scene) => new CpuEngine(scene);
