import { describe, expect, it } from 'vitest';
import { cpuEngine } from '../../src/validation/engine';
import { runGate } from '../../src/validation/gate';
import { gateSuite } from './suite';

gateSuite('Гейт M1: плоский удар и откол', ['plate-cu-4', 'spall-cu-0.8', 'spall-cu-2']);

describe('Гейт M1: детерминизм CPU-эталона (12.10)', () => {
  it('два прогона откола с контактом полей совпадают побитово', async () => {
    const r = await runGate({ preset: 'pc_high', engine: cpuEngine, cases: ['spall-cu-2'], determinism: ['spall-cu-2'] });
    expect(r.determinism).toHaveLength(1);
    expect(r.determinism[0].identical).toBe(true);
    expect(r.tests.find((t) => t.test === '12.10')?.passed).toBe(true);
  });
});
