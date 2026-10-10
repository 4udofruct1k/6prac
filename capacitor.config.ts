import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.terminal.armorsim',
  appName: 'TERMINAL',
  webDir: 'dist',
  android: {
    // M0: на телефоне смотрим логи WebGPU через chrome://inspect.
    webContentsDebuggingEnabled: true,
  },
};

export default config;
