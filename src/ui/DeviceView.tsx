import { useState } from 'preact/hooks';
import { errorText, type GpuContext, type GpuReport } from '../sim/gpu';
import { SELFTEST_TOLERANCE, runSelfTest, type SelfTestReport } from '../sim/selftest';

export function DeviceView({
  report,
  gpu,
  selfTest,
  onSelfTest,
}: {
  report: GpuReport;
  gpu: GpuContext | null;
  selfTest: SelfTestReport | null;
  onSelfTest: (r: SelfTestReport) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!gpu) return;
    setBusy(true);
    setError(null);
    try {
      onSelfTest(await runSelfTest(gpu.device));
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  const rows: [string, string][] = [
    ['WebGPU', report.available ? 'есть' : `нет — ${report.reason ?? ''}`],
    ['Уровень', report.featureLevel ?? '—'],
    ['Программный адаптер', report.isFallbackAdapter ? 'да (fallback)' : 'нет'],
    ['Вендор', report.adapter?.vendor || '—'],
    ['Архитектура', report.adapter?.architecture || '—'],
    ['Устройство', report.adapter?.device || report.adapter?.description || '—'],
    ['Платформа', report.native ? `Capacitor (${report.platform})` : 'браузер'],
    ['User-Agent', report.userAgent],
    ...Object.entries(report.limits ?? {}).map(([k, v]): [string, string] => [k, v.toLocaleString('ru')]),
  ];

  return (
    <section class="device">
      <table class="kv">
        <tbody>
          {rows.map(([k, v]) => (
            <tr>
              <th>{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {gpu && (
        <div class="controls">
          <button class="primary" onClick={run} disabled={busy}>
            {busy ? 'Проверяю…' : 'Самопроверка ядра'}
          </button>
        </div>
      )}
      {error && <p class="error">{error}</p>}
      {selfTest && (
        <table class="kv">
          <tbody>
            <tr>
              <th>Итог</th>
              <td class={selfTest.passed ? 'ok' : 'bad'}>{selfTest.passed ? 'пройдена' : 'не пройдена'}</td>
            </tr>
            <tr>
              <th>Детерминизм (2 прогона, {selfTest.steps} шагов)</th>
              <td class={selfTest.deterministic ? 'ok' : 'bad'}>
                {selfTest.deterministic ? 'побитово равны' : 'различаются'}
              </td>
            </tr>
            <tr>
              <th>GPU ↔ CPU f64, положение</th>
              <td>
                {selfTest.maxPositionErrorCells.toExponential(2)} ячейки (допуск {SELFTEST_TOLERANCE.positionCells})
              </td>
            </tr>
            <tr>
              <th>GPU ↔ CPU f64, скорость</th>
              <td>
                {selfTest.maxVelocityErrorRel.toExponential(2)} от v_max (допуск {SELFTEST_TOLERANCE.velocityRel})
              </td>
            </tr>
            <tr>
              <th>Переполнение i32</th>
              <td class={selfTest.fixedPointOverflow ? 'bad' : 'ok'}>{selfTest.fixedPointOverflow ? 'да' : 'нет'}</td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}
