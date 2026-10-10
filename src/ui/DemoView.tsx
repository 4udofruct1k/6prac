import { useEffect, useRef, useState } from 'preact/hooks';
import { ParticleRenderer, type ViewRange } from '../render/ParticleRenderer';
import { DEMO_ELASTOMER } from '../scene/materials';
import { demoScene } from '../scene/scenes';
import { GpuMpm } from '../sim/GpuMpm';
import { errorText, type GpuContext } from '../sim/gpu';
import { VizMode } from '../sim/layout';

const RESOLUTIONS = [24, 48, 96, 160];

const VIZ: Record<VizMode, { label: string; range: ViewRange; legend: string }> = {
  [VizMode.Speed]: { label: 'Скорость |v|', range: { min: 0, max: 0.12 }, legend: '0 … 0,12 км/с' },
  [VizMode.Pressure]: {
    label: 'Давление',
    range: { min: -0.01, max: 0.01 },
    legend: 'растяжение −0,01 … сжатие +0,01 ГПа',
  },
  [VizMode.Body]: { label: 'Тело', range: { min: 0, max: 1 }, legend: 'цвет тела' },
};

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
  const [across, setAcross] = useState(48);
  const [running, setRunning] = useState(true);
  const [viz, setViz] = useState<VizMode>(VizMode.Speed);
  const [usPerFrame, setUsPerFrame] = useState(3);
  const [resetKey, setResetKey] = useState(0);
  const [hud, setHud] = useState<Hud | null>(null);
  const [error, setError] = useState<string | null>(null);

  const live = useRef({ running, viz, usPerFrame, stepOnce: false });
  live.current.running = running;
  live.current.viz = viz;
  live.current.usPerFrame = usPerFrame;

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
        const scene = demoScene({ across });
        sim = await GpuMpm.create(device, scene);
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
        const l = live.current;
        sim.setVizMode(l.viz);
        const encoder = device.createCommandEncoder();
        // Кадр продвигает событие на фиксированное время, а не на число шагов: шаг Δt ∝ Δx,
        // иначе на мелкой сетке анимация идёт медленнее и выглядит иначе
        const steps = l.running ? Math.max(1, Math.round(l.usPerFrame / sim.dt)) : l.stepOnce ? 1 : 0;
        l.stepOnce = false;
        sim.encodeSteps(encoder, steps);
        renderer.encode(encoder, sim, l.viz, VIZ[l.viz].range);
        device.queue.submit([encoder.finish()]);
        frames++;
        const now = performance.now();
        if (now - fpsT0 > 500) {
          fps = (frames * 1000) / (now - fpsT0);
          frames = 0;
          fpsT0 = now;
        }
        if (now - hudT > 100) {
          hudT = now;
          setHud({ t: sim.time, steps: sim.stepCount, fps, n: sim.n, dtNs: sim.dt * 1000, dx: sim.scene.dx });
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
  }, [gpu, across, resetKey]);

  return (
    <section class="demo">
      <div class="viewport">
        <canvas ref={canvasRef} />
        {hud && (
          <div class="hud">
            <div>T+ {hud.t.toFixed(1)} мкс</div>
            <div>шаг {hud.steps}</div>
            <div>Δt {hud.dtNs.toFixed(0)} нс</div>
            <div>
              N {hud.n.toLocaleString('ru')} · Δx {hud.dx.toFixed(2)} мм
            </div>
            <div>{hud.fps.toFixed(0)} кадр/с</div>
          </div>
        )}
      </div>
      <div class="legend">{VIZ[viz].legend}</div>
      {error && <p class="error">{error}</p>}
      <div class="controls">
        <button onClick={() => setRunning(!running)}>{running ? 'Пауза' : 'Пуск'}</button>
        <button disabled={running} onClick={() => (live.current.stepOnce = true)}>
          Шаг
        </button>
        <button onClick={() => setResetKey(resetKey + 1)}>Сброс</button>
        <label>
          Поле
          <select value={viz} onChange={(e) => setViz(Number(e.currentTarget.value) as VizMode)}>
            {[VizMode.Speed, VizMode.Pressure, VizMode.Body].map((m) => (
              <option value={m}>{VIZ[m].label}</option>
            ))}
          </select>
        </label>
        <label>
          Частиц по стороне
          <select value={across} onChange={(e) => setAcross(Number(e.currentTarget.value))}>
            {RESOLUTIONS.map((r) => (
              <option value={r}>
                {r} ({(r * r).toLocaleString('ru')})
              </option>
            ))}
          </select>
        </label>
        <label>
          Мкс за кадр
          <select value={usPerFrame} onChange={(e) => setUsPerFrame(Number(e.currentTarget.value))}>
            {[0.5, 1, 2, 3, 5, 10].map((s) => (
              <option value={s}>{s.toLocaleString('ru')}</option>
            ))}
          </select>
        </label>
      </div>
      <p class="note">
        Технический спайк M0: блок «{DEMO_ELASTOMER.name}» 40×40 мм (параметры <code>{DEMO_ELASTOMER.status}</code>)
        налетает на жёсткий пол со скоростью 67 м/с с вращением и отскакивает. Неогуковская упругость, плоская
        деформация, явный MLS-MPM. Гравитация не включена: за сотни микросекунд она сдвигает блок на нанометры.
      </p>
    </section>
  );
}
