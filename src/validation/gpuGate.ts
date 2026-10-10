// Гейт M1 на ядре GPU — для вкладки «Валидация» и e2e.

import type { StorageMode } from '../sim/layout';
import type { GatePresetId } from './cases';
import { runGate, type GateCaseResult, type GateReport } from './gate';
import { gpuEngine } from './gpuEngine';

export interface GpuGateOptions {
  preset: GatePresetId;
  mode?: StorageMode;
  cases?: string[];
  determinism?: string[];
  signal?: AbortSignal;
  onCase?(r: GateCaseResult): void;
  onStatus?(text: string): void;
}

export function runGpuGate(device: GPUDevice, opts: GpuGateOptions): Promise<GateReport> {
  return runGate({ ...opts, engine: gpuEngine(device, opts.mode) });
}
