import { expect, test } from '@playwright/test';
import { openApp } from './armor';

for (const compat of [false, true]) {
  test.describe(compat ? 'режим совместимости' : 'core', () => {
    test('самопроверка ядра: детерминизм и совпадение с CPU-эталоном', async ({ page }) => {
      await openApp(page, compat ? '?tab=device&compat' : '?tab=device');
      const r = await page.evaluate(async () => {
        const ctx = await window.__armor.gpu();
        if (!('device' in ctx)) throw new Error(ctx.reason);
        const res = await window.__armor.runSelfTest(ctx.device);
        return { res, level: ctx.report.featureLevel, limits: ctx.report.limits };
      });
      console.log(JSON.stringify(r));
      for (const c of r.res.cases) {
        expect(c.deterministic, c.scene).toBe(true);
        expect(c.fixedPointOverflow, c.scene).toBe(false);
        // Режим L2 считает то же самое, что полный, бит в бит
        if (c.mode === 'l2') expect(c.sameAsFull, c.scene).toBe(true);
      }
      expect(r.res.passed).toBe(true);
    });
  });
}

for (const mode of ['full', 'l2'] as const) {
  test(`бенчмарк (${mode}): пресет «Минимум» считает конечные числа`, async ({ page }) => {
    // Не на вкладке «Демо»: демо считает на том же GPU и отнимает время у замера
    await openApp(page, '?tab=device');
    const r = await page.evaluate(async (mode) => {
      const ctx = await window.__armor.gpu();
      if (!('device' in ctx)) throw new Error(ctx.reason);
      return window.__armor.runBenchCase(ctx.device, { id: 'min', label: 'Минимум', n: 8000, mode }, { seconds: 1 });
    }, mode);
    console.log(JSON.stringify(r));
    expect(r.error).toBeUndefined();
    expect(r.mode).toBe(mode);
    expect(r.finite).toBe(true);
    expect(r.fixedPointOverflow).toBe(false);
    expect(r.steps).toBeGreaterThan(0);
    expect(Math.abs(r.n - 8000) / 8000).toBeLessThan(0.02);
  });
}

for (const compat of [false, true]) {
  test(`демо${compat ? ' (compat)' : ''}: симуляция идёт без ошибок устройства`, async ({ page }) => {
    const errors = await openApp(page, compat ? '?compat' : '');
    await expect(page.locator('.chip')).toContainText(compat ? 'WebGPU compatibility' : 'WebGPU core');
    const hud = page.locator('.hud');
    await expect(hud).toContainText('шаг');
    const stepsOf = async () => Number((await hud.innerText()).match(/шаг (\d+)/)![1]);
    const s0 = await stepsOf();
    await expect.poll(stepsOf, { timeout: 20_000 }).toBeGreaterThan(s0 + 20);
    // На холсте есть частицы: доля пикселей, заметно отличных от фона (цвет угла холста). Не «ярче фона»:
    // в начале удара поле ε̄p около нуля и частицы окрашены тёмным концом шкалы. Кадр WebGPU после показа
    // не читается из страницы, поэтому берём снимок экрана и декодируем его через <img>.
    const png = (await page.locator('.viewport canvas').screenshot()).toString('base64');
    const lit = await page.evaluate(async (data) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
      c.drawImage(img, 0, 0);
      const px = c.getImageData(0, 0, img.width, img.height).data;
      const [r0, g0, b0] = [px[0], px[1], px[2]];
      let n = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (Math.abs(px[i] - r0) + Math.abs(px[i + 1] - g0) + Math.abs(px[i + 2] - b0) > 40) n++;
      }
      return n / (px.length / 4);
    }, png);
    console.log(`доля пикселей частиц: ${lit.toFixed(3)}`);
    expect(lit).toBeGreaterThan(0.02);
    // Ошибки валидации и потерю устройства интерфейс выводит в .error
    await expect(page.locator('.error')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
