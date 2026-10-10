// Точка входа window.__armor (src/main.tsx) для e2e: ядро без интерфейса.

import type { Page } from '@playwright/test';
import type { runBenchCase } from '../src/bench/benchmark';
import type { sharedGpu } from '../src/sim/gpu';
import type { runSelfTest } from '../src/sim/selftest';
import type { runGpuGate } from '../src/validation/gpuGate';

export interface ArmorApi {
  gpu: typeof sharedGpu;
  runSelfTest: typeof runSelfTest;
  runBenchCase: typeof runBenchCase;
  runGpuGate: typeof runGpuGate;
}

declare global {
  interface Window {
    __armor: ArmorApi;
  }
}

/** Открыть приложение и дождаться __armor; ошибки страницы и консоли копятся в массиве. */
export async function openApp(page: Page, query = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/' + query);
  await page.waitForFunction(() => !!window.__armor);
  return errors;
}
