import { expect, test } from '@playwright/test';
import { openApp } from './armor';

// Гейт M1 (14) на ядре GPU в пресете «ПК-Высокий»: 12.1, 12.2, 12.5, 12.7 и 12.10 — повторные прогоны
// откола с контактом полей и цилиндра Тейлора совпадают побитово
test('гейт M1 на GPU: ПК-Высокий', async ({ page }) => {
  test.setTimeout(900_000);
  // Не на вкладке «Демо»: демо считает на том же GPU
  await openApp(page, '?tab=device');
  const r = await page.evaluate(async () => {
    const ctx = await window.__armor.gpu();
    if (!('device' in ctx)) throw new Error(ctx.reason);
    return window.__armor.runGpuGate(ctx.device, { preset: 'pc_high' });
  });
  for (const c of r.cases) {
    console.log(
      `${c.test} ${c.id}: ${c.value.toFixed(4)} ${c.unit} (эталон ${c.expected.toFixed(4)}, ` +
        `${c.error.toFixed(2)} ${c.errorUnit}), дрейф ${c.energyDrift.toFixed(2)} %, ${c.steps} шагов, ${c.wallSeconds.toFixed(1)} с` +
        (c.failure ? ` — ${c.failure}` : ''),
    );
  }
  for (const d of r.determinism) console.log(`12.10 ${d.id}: ${d.identical ? 'побитово' : `различий ${d.differing}`}`);
  for (const t of r.tests) console.log(`${t.test} ${t.passed ? 'пройден' : 'НЕ пройден'}: ${t.detail}`);
  for (const t of r.tests) expect(t.passed, `${t.test}: ${t.detail}`).toBe(true);
  expect(r.engine).toBe('gpu');
  expect(r.passed).toBe(true);
});

// Вкладка «Валидация»: тот же гейт из интерфейса, пресет «Телефон» (мало частиц, удвоенный допуск)
test('вкладка «Валидация»: гейт в пресете «Телефон» проходит', async ({ page }) => {
  test.setTimeout(600_000);
  const errors = await openApp(page, '?tab=gate');
  await page.locator('section.gate select').selectOption('phone');
  await page.getByRole('button', { name: 'Запустить гейт' }).click();
  const verdict = page.locator('.gate-summary li.total span').last();
  await expect(verdict).toBeVisible({ timeout: 540_000 });
  console.log(await page.locator('.gate-summary').innerText());
  await expect(verdict).toHaveClass(/ok/);
  await expect(page.locator('.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});
