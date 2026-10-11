import { describe, expect, it } from 'vitest';
import { cpuEngine } from '../../src/validation/engine';
import { runGate } from '../../src/validation/gate';
import { gateSuite } from './suite';

gateSuite('Гейт M1: плоский удар и откол', [
  'plate-cu-4',
  'spall-bless-80',
  'spall-bless-103',
  'spall-bless-168',
  'spall-bless-244',
  'spall-peng-94',
  'spall-peng-138',
  'spall-thomas-308',
  'spall-smith-3',
  'spall-smith-1.5',
]);

describe('Гейт M1: детерминизм CPU-эталона (12.10)', () => {
  it('два прогона откола с контактом полей совпадают побитово', async () => {
    const r = await runGate({ preset: 'pc_high', engine: cpuEngine, cases: ['spall-bless-168'], determinism: ['spall-bless-168'] });
    expect(r.determinism).toHaveLength(1);
    expect(r.determinism[0].identical).toBe(true);
    expect(r.tests.find((t) => t.test === '12.10')?.passed).toBe(true);
  });
});
