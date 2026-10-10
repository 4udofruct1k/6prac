import { expect, test, type Page } from '@playwright/test';
import type { BenchResult } from '../src/bench/benchmark';
import type { GpuContext, GpuReport } from '../src/sim/gpu';
import type { SelfTestReport } from '../src/sim/selftest';

interface ArmorApi {
  gpu(): Promise<GpuContext | GpuReport>;
  runSelfTest(device: GPUDevice, steps?: number, across?: number): Promise<SelfTestReport>;
  runBenchCase(
    device: GPUDevice,
    c: { id: string; label: string; n: number },
    opts: { seconds: number; maxSteps?: number },
  ): Promise<BenchResult>;
}

declare global {
  interface Window {
    __armor: ArmorApi;
  }
}

async function openApp(page: Page, query = '') {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/' + query);
  await page.waitForFunction(() => !!window.__armor);
  return errors;
}

for (const compat of [false, true]) {
  test.describe(compat ? 'режим совместимости' : 'core', () => {
    test('самопроверка ядра: детерминизм и совпадение с CPU-эталоном', async ({ page }) => {
      await openApp(page, compat ? '?compat' : '');
      const r = await page.evaluate(async () => {
        const ctx = await window.__armor.gpu();
        if (!('device' in ctx)) throw new Error(ctx.reason);
        const res = await window.__armor.runSelfTest(ctx.device);
        return { res, level: ctx.report.featureLevel, limits: ctx.report.limits };
      });
      console.log(JSON.stringify(r));
      expect(r.res.deterministic).toBe(true);
      expect(r.res.fixedPointOverflow).toBe(false);
      expect(r.res.passed).toBe(true);
    });
  });
}

test('бенчмарк: пресет «Минимум» считает конечные числа', async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(async () => {
    const ctx = await window.__armor.gpu();
    if (!('device' in ctx)) throw new Error(ctx.reason);
    return window.__armor.runBenchCase(ctx.device, { id: 'min', label: 'Минимум', n: 8000 }, { seconds: 1 });
  });
  console.log(JSON.stringify(r));
  expect(r.error).toBeUndefined();
  expect(r.finite).toBe(true);
  expect(r.fixedPointOverflow).toBe(false);
  expect(r.steps).toBeGreaterThan(0);
  expect(Math.abs(r.n - 8000) / 8000).toBeLessThan(0.02);
});

for (const compat of [false, true]) {
  test(`демо${compat ? ' (compat)' : ''}: симуляция идёт без ошибок устройства`, async ({ page }) => {
    const errors = await openApp(page, compat ? '?compat' : '');
    await expect(page.locator('.chip')).toContainText(compat ? 'WebGPU compatibility' : 'WebGPU core');
    const hud = page.locator('.hud');
    await expect(hud).toContainText('шаг');
    const stepsOf = async () => Number((await hud.innerText()).match(/шаг (\d+)/)![1]);
    const s0 = await stepsOf();
    await expect.poll(stepsOf, { timeout: 20_000 }).toBeGreaterThan(s0 + 20);
    // На холсте есть частицы: доля пикселей заметно ярче фона. Кадр WebGPU после показа не читается
    // из страницы, поэтому берём снимок экрана и декодируем его через <img>.
    const png = (await page.locator('.viewport canvas').screenshot()).toString('base64');
    const lit = await page.evaluate(async (data) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
      c.drawImage(img, 0, 0);
      const px = c.getImageData(0, 0, img.width, img.height).data;
      let n = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 120) n++;
      return n / (px.length / 4);
    }, png);
    console.log(`доля пикселей частиц: ${lit.toFixed(3)}`);
    expect(lit).toBeGreaterThan(0.01);
    // Ошибки валидации и потерю устройства интерфейс выводит в .error
    await expect(page.locator('.error')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
