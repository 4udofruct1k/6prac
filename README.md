# TERMINAL — симулятор пробития брони

Игра-симулятор терминальной баллистики: 2D-разрез брони, частицы, физически честные числа.
Решатель — явный 2D MLS-MPM на WebGPU (compute-шейдеры WGSL), одна кодовая база для ПК и Android.

Спека: [ARMOR_SPEC v0.1 в Claude Docs](https://claude.ai/artifact/XTpFrjDVeTQ7sCFfkSQdRt) — источник правды по физике,
числам и вехам. В репо лежит её выгрузка в Markdown: [`docs/ARMOR_SPEC.md`](docs/ARMOR_SPEC.md).

## Статус: веха M0 — технический спайк

Что сделано и что осталось до гейта M0: [`docs/M0.md`](docs/M0.md).

- **Демо**: блок эластомера налетает на пол и отскакивает. Неогуковская упругость, APIC, P2G на i32-атомиках
  с фиксированной точкой (побитовый детерминизм, 4.6).
- **Бенчмарк** «частиц × шагов в секунду» по пресетам 2.1 + JSON-отчёт для переноса чисел с телефона.
- **Самопроверка ядра**: два прогона побитово равны; GPU совпадает с CPU-эталоном в float64.
- **Android**: Capacitor-проект в `android/`, CI собирает debug-APK.

## Запуск

```bash
npm ci
npm run dev          # http://localhost:5173 — нужен браузер с WebGPU (Chrome/Edge 113+, на Android — Chrome 121+)
```

Параметры адреса: `?tab=bench` — сразу бенчмарк, `?tab=device` — устройство и самопроверка,
`?compat` — принудительный режим совместимости WebGPU (как на старых Android с OpenGL ES 3.1).

## Тесты

```bash
npm run typecheck
npm test             # юнит-тесты и CPU-эталон (vitest, без GPU)
npm run test:e2e     # WGSL-ядра и рендер в Chromium на SwiftShader (Playwright)
```

Перед первым e2e: `npx playwright install chromium`. Браузер открывается в окне (в headless WebGPU-canvas
не работает); без дисплея — `xvfb-run -a npm run test:e2e`.

## Телефон (M0)

1. Скачать `terminal-m0-debug-apk` из артефактов последнего прогона CI (вкладка Actions) и установить.
   Или собрать локально: `npm run android:sync && npm run android:open` → Run в Android Studio (JDK 21).
2. В приложении: «Устройство» → «Самопроверка ядра», затем «Бенчмарк», затем «Отчёт» → «Скопировать JSON».
3. Отчёт с телефона и с ПК — основа для фиксации чисел пресетов (таблица в `docs/M0.md`).

Отладка WebView: `chrome://inspect` на ПК (в debug-сборке включено `webContentsDebuggingEnabled`).

## Структура

Модули по разделу 13 спеки; созданы те, что нужны M0.

| Папка | Что внутри |
| --- | --- |
| `src/sim/` | Ядро MPM: WGSL (`kernels.ts`), хост WebGPU (`GpuMpm.ts`), раскладка буферов, самопроверка |
| `src/cpu-ref/` | Тот же алгоритм на TypeScript в float64 |
| `src/scene/` | Пресеты качества, материалы M0, засев частиц, сцены демо и бенчмарка |
| `src/render/` | Рендер частиц сплэтами из буфера ядра |
| `src/bench/` | Бенчмарк M0 |
| `src/ui/` | Preact-интерфейс |
| `tests/` | Юнит-тесты (vitest) |
| `e2e/` | Headless-прогоны ядра и интерфейса (Playwright) |
| `android/` | Capacitor-обёртка |
