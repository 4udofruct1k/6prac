import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [preact()],
  // Относительные пути: одна сборка работает на GitHub Pages (/6prac/) и в Capacitor WebView
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { target: 'es2022' },
  test: {
    environment: 'node',
    // unit — быстрые тесты без GPU; gate — сценарии раздела 12 на CPU-эталоне (гейт вехи, минуты)
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/*.test.ts'] } },
      { extends: true, test: { name: 'gate', include: ['tests/gate/*.test.ts'] } },
    ],
  },
});
