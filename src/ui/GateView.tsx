import { useRef, useState } from 'preact/hooks';
import { errorText, type GpuContext } from '../sim/gpu';
import { GATE_CASES, GATE_PRESETS, type GatePresetId } from '../validation/cases';
import type { GateCaseResult, GateReport } from '../validation/gate';
import { runGpuGate } from '../validation/gpuGate';

const num = (v: number, digits: number) =>
  Number.isFinite(v) ? v.toLocaleString('ru', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';

/** Знаков после запятой для величины сценария */
function digitsOf(unit: string): number {
  if (unit === 'L/L0') return 3;
  if (unit === 'ГПа') return 1;
  if (unit.startsWith('мм')) return 2;
  return 0;
}

function errorText12(c: GateCaseResult): string {
  if (c.errorUnit === 'шт.') return `${num(c.error, 0)} шт. (допуск 0)`;
  const sign = c.error > 0 ? '+' : '';
  return `${sign}${num(c.error, 2)} ${c.errorUnit} (±${num(c.tolerance, c.errorUnit === '%' ? 0 : 1)})`;
}

export function GateView({
  gpu,
  report,
  onReport,
}: {
  gpu: GpuContext;
  report: GateReport | null;
  onReport: (r: GateReport | null) => void;
}) {
  const [preset, setPreset] = useState<GatePresetId>('pc_high');
  const [status, setStatus] = useState<string | null>(null);
  const [partial, setPartial] = useState<GateCaseResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const running = status !== null;

  const start = async () => {
    abort.current = new AbortController();
    const acc: GateCaseResult[] = [];
    setPartial([]);
    setError(null);
    onReport(null);
    setStatus('Запуск…');
    try {
      const r = await runGpuGate(gpu.device, {
        preset,
        signal: abort.current.signal,
        onCase: (c) => {
          acc.push(c);
          setPartial([...acc]);
        },
        onStatus: setStatus,
      });
      onReport(r);
    } catch (e) {
      setError(errorText(e));
    }
    setStatus(null);
  };

  const cases = report?.cases ?? partial;
  const p = GATE_PRESETS[preset];

  return (
    <section class="gate">
      <p class="note">
        Гейт вехи M1 (раздел 14): тесты 12.1, 12.2, 12.5, 12.7 и 12.10 на ядре GPU этого устройства. Решатель
        принимается на «ПК-Высоком» с допусками спеки; на «Телефоне» те же тесты — регрессия с удвоенным допуском.
        Энергия (12.2) проверяется на каждом сценарии, детерминизм (12.10) — повтором откола и цилиндра Тейлора.
        Всего {GATE_CASES.length} сценариев; на ПК — меньше минуты, на телефоне — несколько минут.
      </p>
      <div class="controls">
        <label>
          Пресет
          <select value={preset} onChange={(e) => setPreset(e.currentTarget.value as GatePresetId)} disabled={running}>
            {Object.values(GATE_PRESETS).map((g) => (
              <option value={g.id}>
                {g.label} · Δx {num(g.dx, 2)} мм{g.toleranceScale > 1 ? ' · допуск ×2' : ''}
              </option>
            ))}
          </select>
        </label>
        {running ? (
          <button onClick={() => abort.current?.abort()}>Стоп</button>
        ) : (
          <button class="primary" onClick={start}>
            Запустить гейт
          </button>
        )}
        {status && <span class="dim">{status}</span>}
      </div>
      {error && <p class="error">{error}</p>}

      {report && (
        <ul class="gate-summary">
          {report.tests.map((t) => (
            <li>
              <span class="dim">
                {t.test} · {t.title}
              </span>
              <span class={!t.ran ? 'dim' : t.passed ? 'ok' : 'bad'}>
                {!t.ran ? 'не запускался' : t.passed ? 'пройден' : 'не пройден'} — {t.detail}
              </span>
            </li>
          ))}
          <li class="total">
            <span>Итог гейта M1</span>
            <span class={report.passed ? 'ok' : 'bad'}>
              {report.passed ? 'пройден' : 'не пройден'} · {report.presetLabel}, Δx = {num(report.dx, 3)} мм ·{' '}
              {num(report.wallSeconds, 0)} с
            </span>
          </li>
        </ul>
      )}

      {cases.length > 0 && (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Сценарий</th>
                <th>Тест</th>
                <th>Измерено</th>
                <th>Эталон</th>
                <th>Отклонение (допуск)</th>
                <th>Дрейф энергии</th>
                <th>Частиц</th>
                <th>Шагов</th>
                <th>Время, с</th>
                <th>Итог</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr title={c.reference}>
                  <td>{c.label}</td>
                  <td>{c.test}</td>
                  <td>
                    {num(c.value, digitsOf(c.unit))} <span class="dim">{c.unit}</span>
                  </td>
                  <td>{num(c.expected, digitsOf(c.unit))}</td>
                  <td class={c.passed ? 'ok' : 'bad'}>{errorText12(c)}</td>
                  <td class={c.energyPassed ? 'ok' : 'bad'}>
                    {num(c.energyDrift, 2)} % <span class="dim">(&lt; {num(c.energyTolerance, 0)} %)</span>
                  </td>
                  <td>{c.n.toLocaleString('ru')}</td>
                  <td>{c.steps.toLocaleString('ru')}</td>
                  <td>{num(c.wallSeconds, 1)}</td>
                  <td class={c.passed && c.energyPassed ? 'ok' : 'bad'}>
                    {c.failure ? c.failure : c.passed && c.energyPassed ? 'пройден' : 'не пройден'}
                    {c.overflow ? ' · переполнение i32' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report && report.determinism.length > 0 && (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>12.10 · повторный прогон</th>
                <th>Шагов</th>
                <th>Результат</th>
              </tr>
            </thead>
            <tbody>
              {report.determinism.map((d) => (
                <tr>
                  <td>{d.label}</td>
                  <td>{d.steps.toLocaleString('ru')}</td>
                  <td class={d.identical ? 'ok' : 'bad'}>
                    {d.identical ? 'побитово' : `различаются ${d.differing.toLocaleString('ru')} слов`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p class="note">
        Эталоны: 12.1 — плато ρ0(C0 + s·up)·up по параметрам меди из базы; 12.5 — длины цилиндров после удара из
        Johnson & Cook 1983, рис. 9; 12.7 — откол меди при 0,8 и 2 порогах скорости (p_min = −1,9 ГПа), плоскость откола
        на глубине толщины ударника. Геометрия 12.1 и 12.7 задана в шагах частиц, цилиндры Тейлора — в мм. Тот же гейт на
        CPU-эталоне гоняет CI. {p.toleranceScale > 1 ? 'Допуски этого пресета удвоены.' : ''} Отчёт — на вкладке «Отчёт».
      </p>
    </section>
  );
}
