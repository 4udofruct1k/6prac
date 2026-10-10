import { useState } from 'preact/hooks';
import { errorText, type GpuContext, type GpuReport } from '../sim/gpu';
import { STORAGE_MODES } from '../sim/layout';
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
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Сцена</th>
                <th>Режим хранения</th>
                <th>Детерминизм</th>
                <th>GPU ↔ CPU, положение, ячейки</th>
                <th>GPU ↔ CPU, скорость, от v_max</th>
                <th>Переполнение i32</th>
                <th>Равен полному</th>
                <th>Итог</th>
              </tr>
            </thead>
            <tbody>
              {selfTest.cases.map((m) => (
                <tr>
                  <td>{m.scene}</td>
                  <td>{STORAGE_MODES[m.mode].label}</td>
                  <td class={m.deterministic ? 'ok' : 'bad'}>{m.deterministic ? 'побитово' : 'различаются'}</td>
                  <td>{m.maxPositionErrorCells.toExponential(2)}</td>
                  <td>{m.maxVelocityErrorRel.toExponential(2)}</td>
                  <td class={m.fixedPointOverflow ? 'bad' : 'ok'}>{m.fixedPointOverflow ? 'да' : 'нет'}</td>
                  <td class={m.sameAsFull === false ? 'bad' : 'ok'}>
                    {m.sameAsFull === undefined ? '—' : m.sameAsFull ? 'побитово' : 'нет'}
                  </td>
                  <td class={m.passed ? 'ok' : 'bad'}>{m.passed ? 'пройдена' : 'не пройдена'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p class="note">
            {selfTest.steps} шагов на сцену, два прогона на режим. Допуски: положение{' '}
            {SELFTEST_TOLERANCE.positionCells} ячейки, скорость {SELFTEST_TOLERANCE.velocityRel} от v_max.
          </p>
        </div>
      )}
    </section>
  );
}
