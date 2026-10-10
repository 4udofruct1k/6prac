// Общая часть тестов гейта M1 (14): каждый сценарий раздела 12 на CPU-эталоне в двух пресетах —
// «ПК-Высокий» с допуском спеки и «Телефон» как регрессия с удвоенным допуском.

import { describe, expect, it } from 'vitest';
import { GATE_PRESETS, gateCase, type GatePresetId } from '../../src/validation/cases';
import { cpuEngine } from '../../src/validation/engine';
import { runGateCase, type GateCaseResult } from '../../src/validation/gate';

const PRESETS: GatePresetId[] = ['pc_high', 'phone'];

function explain(r: GateCaseResult): string {
  return (
    `${r.label}: ${r.value} ${r.unit} при эталоне ${r.expected}, отклонение ${r.error} ${r.errorUnit} ` +
    `(допуск ${r.tolerance}), дрейф энергии ${r.energyDrift} % (допуск ${r.energyTolerance} %)` +
    (r.failure ? `, ошибка: ${r.failure}` : '')
  );
}

/** Тесты сценариев: метрика сценария (12.1, 12.5, 12.7) и баланс энергии на нём же (12.2). */
export function gateSuite(title: string, ids: string[], timeoutMs = 300_000): void {
  for (const preset of PRESETS) {
    const p = GATE_PRESETS[preset];
    describe(`${title} — ${p.label}, Δx = ${p.dx.toFixed(3)} мм`, () => {
      for (const id of ids) {
        const c = gateCase(id);
        it(
          `${c.test} · ${c.label}`,
          async () => {
            const { result } = await runGateCase(c, preset, cpuEngine);
            expect(result.failure, explain(result)).toBeUndefined();
            expect(result.passed, explain(result)).toBe(true);
            expect(result.energyPassed, explain(result)).toBe(true);
          },
          timeoutMs,
        );
      }
    });
  }
}
