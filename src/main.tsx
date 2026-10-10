import { render } from 'preact';
import { runBenchCase } from './bench/benchmark';
import { sharedGpu } from './sim/gpu';
import { runSelfTest } from './sim/selftest';
import { App } from './ui/App';
import { runGpuGate } from './validation/gpuGate';
import './ui/styles.css';

// Точка входа для headless-тестов (e2e/): ядро доступно без интерфейса
Object.assign(window, { __armor: { gpu: sharedGpu, runSelfTest, runBenchCase, runGpuGate } });

render(<App />, document.getElementById('app')!);
