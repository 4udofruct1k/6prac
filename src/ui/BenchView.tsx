import { useRef, useState } from 'preact/hooks';
import { runBenchmark, type BenchCase, type BenchResult } from '../bench/benchmark';
import { QUALITY_PRESETS } from '../scene/presets';
import type { GpuContext } from '../sim/gpu';

const fmt = (v: number, digits = 1) =>
  Number.isFinite(v) ? v.toLocaleString('ru', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';

export function BenchView({
  gpu,
  results,
  onResults,
}: {
  gpu: GpuContext;
  results: BenchResult[];
  onResults: (r: BenchResult[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(QUALITY_PRESETS.map((p) => p.id)));
  const [customOn, setCustomOn] = useState(false);
  const [customN, setCustomN] = useState(200_000);
  const [seconds, setSeconds] = useState(3);
  const [running, setRunning] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const start = async () => {
    const cases: BenchCase[] = QUALITY_PRESETS.filter((p) => selected.has(p.id)).map((p) => ({
      id: p.id,
      label: p.label,
      n: p.n,
    }));
    if (customOn) cases.push({ id: 'custom', label: 'Свои', n: Math.max(1000, Math.round(customN)) });
    if (cases.length === 0) return;
    abort.current = new AbortController();
    const acc: BenchResult[] = [];
    onResults([]);
    setRunning(cases[0].label);
    await runBenchmark(gpu.device, cases, { seconds, signal: abort.current.signal }, (r, i) => {
      acc.push(r);
      onResults([...acc]);
      setRunning(cases[i + 1]?.label ?? null);
    });
    setRunning(null);
  };

  return (
    <section class="bench">
      <p class="note">
        Нагрузка: сцена 120×250 мм из 2.1 целиком заполнена частицами с шагом Δx = √(A/N); стальная плита и стержень
        1,5 км/с. Шаг сетки 2·Δx, Δt по Куранту с Δx частиц (4.3). Меряется полный шаг: P2G → сетка → G2P.
      </p>
      <div class="presets">
        {QUALITY_PRESETS.map((p) => (
          <label class="check">
            <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} disabled={!!running} />
            {p.label} · {p.n.toLocaleString('ru')} <span class="dim">({p.where})</span>
          </label>
        ))}
        <label class="check">
          <input type="checkbox" checked={customOn} onChange={() => setCustomOn(!customOn)} disabled={!!running} />
          Свои ·
          <input
            type="number"
            min={1000}
            step={1000}
            value={customN}
            disabled={!!running}
            onInput={(e) => setCustomN(Number(e.currentTarget.value))}
          />
        </label>
      </div>
      <div class="controls">
        <label>
          Секунд на пресет
          <select value={seconds} onChange={(e) => setSeconds(Number(e.currentTarget.value))} disabled={!!running}>
            {[1, 2, 3, 5, 10].map((s) => (
              <option value={s}>{s}</option>
            ))}
          </select>
        </label>
        {running ? (
          <button onClick={() => abort.current?.abort()}>Стоп ({running}…)</button>
        ) : (
          <button class="primary" onClick={start}>
            Запустить бенчмарк
          </button>
        )}
      </div>
      {results.length > 0 && (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Пресет</th>
                <th>N</th>
                <th>Δx, мм</th>
                <th>Δt, нс</th>
                <th>мс/шаг</th>
                <th>шаг/с</th>
                <th>млн част·шаг/с</th>
                <th>100 мкс, с</th>
                <th>300 мкс, с</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr>
                  <td>{r.label}</td>
                  <td>{r.n.toLocaleString('ru')}</td>
                  <td>{fmt(r.dxMm, 2)}</td>
                  <td>{fmt(r.dtNs, 1)}</td>
                  <td>{fmt(r.msPerStep, 2)}</td>
                  <td>{fmt(r.stepsPerSec, 0)}</td>
                  <td>{fmt(r.mpsPerSec, 1)}</td>
                  <td>{fmt(r.wallSecFor100us, 1)}</td>
                  <td>{fmt(r.wallSecFor300us, 1)}</td>
                  <td class={r.error || !r.finite || r.fixedPointOverflow ? 'bad' : 'ok'}>
                    {r.error ?? (!r.finite ? 'NaN' : r.fixedPointOverflow ? 'переполнение i32' : 'ok')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
