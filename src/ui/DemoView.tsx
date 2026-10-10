import { useEffect, useRef, useState } from 'preact/hooks';
import { ParticleRenderer } from '../render/ParticleRenderer';
import { DEMOS } from '../scene/demos';
import { GpuMpm } from '../sim/GpuMpm';
import { errorText, type GpuContext } from '../sim/gpu';
import { VizMode } from '../sim/layout';

const VIZ_FIELDS: { mode: VizMode; label: string; unit: string }[] = [
  { mode: VizMode.Speed, label: 'Скорость |v|', unit: 'км/с' },
  { mode: VizMode.Pressure, label: 'Давление', unit: 'ГПа' },
  { mode: VizMode.Temperature, label: 'Температура (средняя по частице)', unit: 'K' },
  { mode: VizMode.PlasticStrain, label: 'Пластическая деформация ε̄p', unit: '' },
  { mode: VizMode.Damage, label: 'Повреждение D', unit: '' },
  { mode: VizMode.VonMises, label: 'Напряжение по Мизесу', unit: 'ГПа' },
  { mode: VizMode.Body, label: 'Тело', unit: '' },
];

const fmt = (v: number) => v.toLocaleString('ru', { maximumSignificantDigits: 3 });

interface Hud {
  t: number;
  steps: number;
  fps: number;
  n: number;
  dtNs: number;
  dx: number;
}

export function DemoView({ gpu }: { gpu: GpuContext }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [demoId, setDemoId] = useState(DEMOS[0].id);
  const demo = DEMOS.find((d) => d.id === demoId)!;
  const [resolution, setResolution] = useState(demo.defaultResolution);
  const [running, setRunning] = useState(true);
  const [viz, setViz] = useState<VizMode>(demo.defaultViz);
  const [usPerFrame, setUsPerFrame] = useState(demo.usPerFrame);
  const [resetKey, setResetKey] = useState(0);
  const [hud, setHud] = useState<Hud | null>(null);
  const [error, setError] = useState<string | null>(null);

  const live = useRef({ running, viz, usPerFrame, stepOnce: false });
  live.current.running = running;
  live.current.viz = viz;
  live.current.usPerFrame = usPerFrame;

  const pickDemo = (id: string) => {
    const d = DEMOS.find((x) => x.id === id)!;
    setDemoId(id);
    setResolution(d.defaultResolution);
    setViz(d.defaultViz);
    setUsPerFrame(d.usPerFrame);
  };

  const rangeOf = (mode: VizMode): [number, number] => demo.ranges[mode] ?? [0, 1];

  useEffect(() => {
    const canvas = canvasRef.current!;
    const context = canvas.getContext('webgpu');
    if (!context) {
      setError('Не удалось получить контекст webgpu у canvas');
      return;
    }
    const { device } = gpu;
    let disposed = false;
    let raf = 0;
    let sim: GpuMpm | undefined;
    let renderer: ParticleRenderer | undefined;
    let reading = false;
    // Не больше одного кадра в очереди GPU: если устройство не успевает за мкс/кадр, событие идёт
    // медленнее, а не копит работу в очереди
    let inFlight = false;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    (async () => {
      try {
        sim = await GpuMpm.create(device, demo.build(resolution));
        renderer = new ParticleRenderer(device, context);
      } catch (e) {
        setError(errorText(e));
        return;
      }
      if (disposed) {
        sim.destroy();
        renderer.destroy();
        return;
      }
      setError(null);
      let frames = 0;
      let fpsT0 = performance.now();
      let fps = 0;
      let hudT = 0;
      const frame = () => {
        if (disposed || !sim || !renderer) return;
        if (inFlight) {
          raf = requestAnimationFrame(frame);
          return;
        }
        const l = live.current;
        sim.setVizMode(l.viz);
        const encoder = device.createCommandEncoder();
        // Кадр продвигает событие на фиксированное время, а не на число шагов: Δt ∝ Δx и меняется по
        // Куранту; берём последний прочитанный с GPU
        const steps = l.running ? Math.max(1, Math.min(2000, Math.round(l.usPerFrame / sim.info.dt))) : l.stepOnce ? 1 : 0;
        l.stepOnce = false;
        sim.encodeSteps(encoder, steps);
        const [min, max] = rangeOf(l.viz);
        renderer.encode(encoder, sim, l.viz, { min, max });
        device.queue.submit([encoder.finish()]);
        inFlight = true;
        device.queue.onSubmittedWorkDone().then(
          () => (inFlight = false),
          () => (inFlight = false),
        );
        frames++;
        const now = performance.now();
        if (now - fpsT0 > 500) {
          fps = (frames * 1000) / (now - fpsT0);
          frames = 0;
          fpsT0 = now;
        }
        if (now - hudT > 100 && !reading) {
          hudT = now;
          reading = true;
          const s = sim;
          s.readStep()
            .then((info) => {
              if (disposed) return;
              setHud({ t: info.time, steps: info.steps, fps, n: s.n, dtNs: info.dt * 1000, dx: s.scene.dx });
            })
            .catch(() => {})
            .finally(() => (reading = false));
        }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      sim?.destroy();
      renderer?.destroy();
    };
  }, [gpu, demoId, resolution, resetKey]);

  const field = VIZ_FIELDS.find((f) => f.mode === viz)!;
  const [lo, hi] = rangeOf(viz);
  const legend =
    viz === VizMode.Body
      ? 'цвет тела'
      : viz === VizMode.Pressure
        ? `растяжение ${fmt(lo)} … сжатие ${fmt(hi)} ГПа`
        : `${fmt(lo)} … ${fmt(hi)}${field.unit ? ' ' + field.unit : ''}`;

  return (
    <section class="demo">
      <div class="viewport">
        <canvas ref={canvasRef} />
        {hud && (
          <div class="hud">
            <div>T+ {hud.t.toFixed(1)} мкс</div>
            <div>шаг {hud.steps}</div>
            <div>Δt {hud.dtNs.toFixed(1)} нс</div>
            <div>
              N {hud.n.toLocaleString('ru')} · Δx {hud.dx.toFixed(2)} мм
            </div>
            <div>{hud.fps.toFixed(0)} кадр/с</div>
          </div>
        )}
      </div>
      <div class="legend">{legend}</div>
      {error && <p class="error">{error}</p>}
      <div class="controls">
        <label>
          Сцена
          <select value={demoId} onChange={(e) => pickDemo(e.currentTarget.value)}>
            {DEMOS.map((d) => (
              <option value={d.id}>{d.label}</option>
            ))}
          </select>
        </label>
        <button onClick={() => setRunning(!running)}>{running ? 'Пауза' : 'Пуск'}</button>
        <button disabled={running} onClick={() => (live.current.stepOnce = true)}>
          Шаг
        </button>
        <button onClick={() => setResetKey(resetKey + 1)}>Сброс</button>
        <label>
          Поле
          <select value={viz} onChange={(e) => setViz(Number(e.currentTarget.value) as VizMode)}>
            {VIZ_FIELDS.map((f) => (
              <option value={f.mode}>{f.label}</option>
            ))}
          </select>
        </label>
        <label>
          {demo.resolutionLabel}
          <select value={resolution} onChange={(e) => setResolution(Number(e.currentTarget.value))}>
            {demo.resolutions.map((r) => (
              <option value={r}>{r}</option>
            ))}
          </select>
        </label>
        <label>
          Мкс за кадр
          <select value={usPerFrame} onChange={(e) => setUsPerFrame(Number(e.currentTarget.value))}>
            {[0.2, 0.5, 1, 2, 3, 5, 10].map((s) => (
              <option value={s}>{s.toLocaleString('ru')}</option>
            ))}
          </select>
        </label>
      </div>
      <p class="note">{demo.note}</p>
    </section>
  );
}
