import { describe, expect, it } from 'vitest';
import { CpuMpm } from '../src/cpu-ref/CpuMpm';
import { prepareScene, type SceneSpec } from '../src/scene/scene';
import { demoScene } from '../src/scene/scenes';
import { Bc, PLANE } from '../src/sim/layout';

/** Два медных бруска летят параллельно и не касаются друг друга и стенок. */
function freeFlightSpec(): SceneSpec {
  return {
    mode: 'plane',
    domain: { xmin: 0, xmax: 60, ymin: 0, ymax: 60 },
    dx: 0.5,
    bodies: [
      { rect: { x0: 10, y0: 20, x1: 20, y1: 40 }, material: 'copper_ofhc', velocity: [0.05, -0.02], bodyId: 0, field: 0 },
      { rect: { x0: 35, y0: 20, x1: 45, y1: 40 }, material: 'steel_4340', velocity: [-0.03, 0.04], bodyId: 1, field: 1 },
    ],
    bc: { left: Bc.Open, right: Bc.Open, bottom: Bc.Open, top: Bc.Open },
  };
}

describe('CPU-эталон MLS-MPM (M1)', () => {
  it('в свободном полёте сохраняет импульс и энергию', () => {
    const sim = new CpuMpm(prepareScene(freeFlightSpec()));
    const d0 = sim.diagnostics();
    sim.step(150);
    const d1 = sim.diagnostics();
    const p0 = Math.hypot(...d0.momentum);
    expect(Math.abs(d1.momentum[0] - d0.momentum[0]) / p0).toBeLessThan(1e-9);
    expect(Math.abs(d1.momentum[1] - d0.momentum[1]) / p0).toBeLessThan(1e-9);
    expect(Math.abs(d1.total - d0.total) / d0.total).toBeLessThan(1e-3);
  });

  it('Δt меняется по Куранту и время накапливается', () => {
    const sim = new CpuMpm(prepareScene(freeFlightSpec()));
    sim.step(10);
    expect(sim.stepCount).toBe(10);
    expect(sim.time).toBeGreaterThan(9 * sim.dtCur);
    expect(sim.dtCur).toBeGreaterThan(0);
  });

  it('демо: блок долетает до пола и отскакивает вверх', () => {
    const sim = new CpuMpm(demoScene({ across: 16 }));
    const v0 = sim.diagnostics().velocity;
    expect(v0[1]).toBeLessThan(0);
    let bounced = false;
    for (let k = 0; k < 200 && !bounced; k++) {
      sim.step(10);
      // Гипоупругая модель M1 при сжатии на 30 % отдаёт меньше энергии в отскок, чем неогуковская M0
      // (эластомеры — веха M3); здесь проверяем сам отскок
      bounced = sim.diagnostics().velocity[1] > 0.2 * Math.abs(v0[1]);
    }
    expect(bounced).toBe(true);
    let lowest = Infinity;
    for (let i = 0; i < sim.n; i++) lowest = Math.min(lowest, sim.get(PLANE.Y, i));
    expect(lowest).toBeGreaterThan(-0.5 * sim.scene.h);
  });

  it('детерминирован: два прогона совпадают побитово', () => {
    const a = new CpuMpm(demoScene({ across: 12 }));
    const b = new CpuMpm(demoScene({ across: 12 }));
    a.step(100);
    b.step(100);
    expect(Buffer.from(a.p.buffer).equals(Buffer.from(b.p.buffer))).toBe(true);
  });
});
