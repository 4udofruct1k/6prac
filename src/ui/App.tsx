import { useEffect, useMemo, useState } from 'preact/hooks';
import type { BenchResult } from '../bench/benchmark';
import { isGpuContext, sharedGpu, type GpuContext, type GpuReport } from '../sim/gpu';
import type { SelfTestReport } from '../sim/selftest';
import type { GateReport } from '../validation/gate';
import { BenchView } from './BenchView';
import { DemoView } from './DemoView';
import { DeviceView } from './DeviceView';
import { GateView } from './GateView';
import { ReportView } from './ReportView';

type Tab = 'demo' | 'gate' | 'bench' | 'device' | 'report';

const TABS: [Tab, string][] = [
  ['demo', 'Демо'],
  ['gate', 'Валидация'],
  ['bench', 'Бенчмарк'],
  ['device', 'Устройство'],
  ['report', 'Отчёт'],
];

/** Вкладка из адреса: `?tab=gate` или `?tab=bench` — сразу к гейту или бенчмарку на телефоне. */
function initialTab(): Tab {
  const t = new URLSearchParams(location.search).get('tab');
  return TABS.some(([id]) => id === t) ? (t as Tab) : 'demo';
}

export function App() {
  const [gpu, setGpu] = useState<GpuContext | null>(null);
  const [report, setReport] = useState<GpuReport | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [bench, setBench] = useState<BenchResult[]>([]);
  const [selfTest, setSelfTest] = useState<SelfTestReport | null>(null);
  const [gate, setGate] = useState<GateReport | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  useEffect(() => {
    sharedGpu().then((r) => {
      if (isGpuContext(r)) {
        setGpu(r);
        setReport(r.report);
        r.device.lost.then((info) => setDeviceError(`GPU-устройство потеряно: ${info.reason} ${info.message}`));
        r.device.addEventListener('uncapturederror', (e) => setDeviceError((e as GPUUncapturedErrorEvent).error.message));
      } else {
        setReport(r);
        setTab('device');
      }
    });
  }, []);

  const fullReport = useMemo(
    () => ({
      app: 'TERMINAL',
      milestone: 'M1',
      version: __APP_VERSION__,
      date: new Date().toISOString(),
      gpu: report,
      selfTest,
      gate,
      bench,
    }),
    [report, selfTest, gate, bench],
  );

  if (!report) return <div class="loading">Запрашиваю WebGPU…</div>;

  return (
    <div class="app">
      <header>
        <h1>
          TERMINAL <span class="dim">· M1 ядро металлов</span>
        </h1>
        <span class={`chip ${gpu ? 'ok' : 'bad'}`}>
          {gpu ? `WebGPU ${report.featureLevel}` : 'нет WebGPU'}
        </span>
      </header>
      <nav>
        {TABS.map(([id, label]) => (
          <button class={tab === id ? 'active' : ''} disabled={!gpu && id !== 'device' && id !== 'report'} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      {deviceError && <p class="error">{deviceError}</p>}
      <main>
        {tab === 'demo' && gpu && <DemoView gpu={gpu} />}
        {tab === 'gate' && gpu && <GateView gpu={gpu} report={gate} onReport={setGate} />}
        {tab === 'bench' && gpu && <BenchView gpu={gpu} results={bench} onResults={setBench} />}
        {tab === 'device' && <DeviceView report={report} gpu={gpu} selfTest={selfTest} onSelfTest={setSelfTest} />}
        {tab === 'report' && <ReportView report={fullReport} />}
      </main>
    </div>
  );
}
