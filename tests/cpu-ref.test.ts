import { describe, expect, it } from 'vitest';
import { CpuMpm } from '../src/cpu-ref/CpuMpm';
import { DEMO_ELASTOMER } from '../src/scene/materials';
import { prepareScene, type SceneSpec } from '../src/scene/scene';
import { demoScene } from '../src/scene/scenes';
import { PLANE } from '../src/sim/layout';

/** Блок в центре большой области: за время теста до стенок не долетает. */
function freeFlightSpec(): SceneSpec {
  return {
    domain: { w: 100, h: 100 },
    dx: 1,
    ppcAxis: 2,
    vMax: 0.1,
    bodies: [
      {
        rect: { x0: 40, y0: 40, x1: 60, y1: 60 },
        material: DEMO_ELASTOMER,
        velocity: [0.02, -0.01],
        omega: 0.002,
        bodyId: 0,
      },
    ],
  };
}

describe('CPU-эталон MLS-MPM', () => {
  it('в свободном полёте сохраняет импульс и момент импульса', () => {
    const sim = new CpuMpm(prepareScene(freeFlightSpec()));
    const d0 = sim.diagnostics();
    sim.step(200);
    const d1 = sim.diagnostics();
    const p0 = Math.hypot(...d0.momentum);
    expect(Math.abs(d1.momentum[0] - d0.momentum[0]) / p0).toBeLessThan(1e-10);
    expect(Math.abs(d1.momentum[1] - d0.momentum[1]) / p0).toBeLessThan(1e-10);
    expect(Math.abs(d1.angularMomentum - d0.angularMomentum) / Math.abs(d0.angularMomentum)).toBeLessThan(1e-6);
  });

  it('в свободном полёте не набирает энергию', () => {
    const sim = new CpuMpm(prepareScene(freeFlightSpec()));
    const e0 = sim.diagnostics();
    sim.step(200);
    const e1 = sim.diagnostics();
    const total0 = e0.kinetic + e0.elastic;
    const total1 = e1.kinetic + e1.elastic;
    expect(total1).toBeLessThanOrEqual(total0 * (1 + 1e-3));
    expect(total1).toBeGreaterThan(total0 * 0.97);
  });

  it('демо: блок долетает до пола и отскакивает вверх', () => {
    const sim = new CpuMpm(demoScene({ across: 16 }));
    const v0 = sim.diagnostics().velocity;
    expect(v0[1]).toBeLessThan(0);
    let minY = Infinity;
    let bounced = false;
    for (let k = 0; k < 120 && !bounced; k++) {
      sim.step(10);
      const d = sim.diagnostics();
      minY = Math.min(minY, d.centerOfMass[1]);
      bounced = d.velocity[1] > 0.5 * Math.abs(v0[1]) && d.centerOfMass[1] > minY;
    }
    expect(bounced).toBe(true);
    // Пол не проходит насквозь: нижняя частица выше стенки
    let lowest = Infinity;
    for (let i = 0; i < sim.n; i++) lowest = Math.min(lowest, sim.get(PLANE.Y, i));
    expect(lowest).toBeGreaterThan(sim.scene.h);
  });

  it('детерминирован: два прогона совпадают побитово', () => {
    const a = new CpuMpm(demoScene({ across: 12 }));
    const b = new CpuMpm(demoScene({ across: 12 }));
    a.step(100);
    b.step(100);
    expect(Buffer.from(a.p.buffer).equals(Buffer.from(b.p.buffer))).toBe(true);
  });
});
