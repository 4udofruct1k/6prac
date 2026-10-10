import { defineConfig } from '@playwright/test';

// WebGPU без GPU — через программный Vulkan (SwiftShader).
// Браузер запускается НЕ в headless: в headless Chromium активный WebGPU-canvas роняет устройство
// («A valid external Instance reference no longer exists») и ничего не выводит. В CI — под xvfb-run.
const WEBGPU_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--use-webgpu-adapter=swiftshader',
  '--disable-vulkan-surface',
];

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'list' : 'line',
  use: {
    baseURL: 'http://localhost:4173',
    browserName: 'chromium',
    headless: false,
    launchOptions: { args: WEBGPU_ARGS },
  },
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
