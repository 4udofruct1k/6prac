// Гейт M1 (14): прогон сценариев 12.1, 12.5, 12.7 с балансом энергии 12.2 на каждом и
// детерминизмом 12.10 — повторный прогон выбранных сценариев должен совпасть побитово.

import { diagnose } from '../sim/diagnostics';
import { GATE_CASES, GATE_PRESETS, type CaseOutcome, type GateCase, type GatePresetId, type GateTestId } from './cases';
import type { Engine, EngineFactory, EngineKind, Snapshot } from './engine';

export interface GateCaseResult extends CaseOutcome {
  id: string;
  test: GateCase['test'];
  label: string;
  reference: string;
  /** 12.2: (E_конец − E_0)/E_0, % — кинетическая + внутренняя + ушедшая */
  energyDrift: number;
  energyTolerance: number;
  energyPassed: boolean;
  /** Узел сетки подходил к пределу i32 фиксированной точки (только GPU) */
  overflow: boolean;
  n: number;
  steps: number;
  time: number;
  wallSeconds: number;
  /** Исключение при прогоне */
  failure?: string;
}

export interface DeterminismResult {
  id: string;
  label: string;
  identical: boolean;
  /** Сколько 32-битных слов снимка различается */
  differing: number;
  steps: number;
}

export interface GateTestSummary {
  test: GateTestId;
  title: string;
  ran: boolean;
  passed: boolean;
  detail: string;
}

export interface GateReport {
  preset: GatePresetId;
  presetLabel: string;
  dx: number;
  toleranceScale: number;
  engine: EngineKind;
  cases: GateCaseResult[];
  determinism: DeterminismResult[];
  tests: GateTestSummary[];
  passed: boolean;
  wallSeconds: number;
}

export interface GateOptions {
  preset: GatePresetId;
  engine: EngineFactory;
  /** id сценариев; по умолчанию все */
  cases?: string[];
  /** Сценарии для 12.10 — прогнать второй раз и сравнить снимки побитово */
  determinism?: string[];
  signal?: AbortSignal;
  onCase?(r: GateCaseResult): void;
  onStatus?(text: string): void;
}

export const DEFAULT_DETERMINISM = ['spall-cu-2', 'taylor-cu-190'];

export const GATE_TESTS: { test: GateTestId; title: string }[] = [
  { test: '12.1', title: 'Плоский удар медь по меди, 4 км/с: плато давления ±3 %' },
  { test: '12.2', title: 'Баланс энергии без источников: дрейф < 2 %' },
  { test: '12.5', title: 'Цилиндр Тейлора (медь, армко, 4340): длина ±5 %' },
  { test: '12.7', title: 'Откол при плоском ударе (металлы)' },
  { test: '12.10', title: 'Детерминизм: два прогона побитово равны' },
];

const now = () => performance.now();

function energyOf(engine: Engine, snap: Snapshot): number {
  return diagnose(engine.scene, snap).total;
}

/** Прогон одного сценария: метрика сценария и баланс энергии (12.2). */
export async function runGateCase(
  c: GateCase,
  presetId: GatePresetId,
  factory: EngineFactory,
  signal?: AbortSignal,
): Promise<{ result: GateCaseResult; snapshot?: Snapshot }> {
  const preset = GATE_PRESETS[presetId];
  const t0 = now();
  const base = { id: c.id, test: c.test, label: c.label, reference: c.reference };
  let engine: Engine | undefined;
  try {
    engine = await factory(c.build(preset.dx));
    const e0 = energyOf(engine, await engine.snapshot());
    const outcome = await c.measure(engine, { dx: preset.dx, toleranceScale: preset.toleranceScale, signal });
    const snapshot = await engine.snapshot();
    const drift = ((energyOf(engine, snapshot) - e0) / e0) * 100;
    const energyTolerance = 2 * preset.toleranceScale;
    const overflow = engine.overflow ?? false;
    const result: GateCaseResult = {
      ...base,
      ...outcome,
      passed: outcome.passed && !overflow,
      energyDrift: drift,
      energyTolerance,
      energyPassed: Math.abs(drift) < energyTolerance,
      overflow,
      n: engine.scene.n,
      steps: snapshot.steps,
      time: snapshot.time,
      wallSeconds: (now() - t0) / 1000,
    };
    return { result, snapshot };
  } catch (e) {
    const failure = e instanceof Error ? e.message : String(e);
    const result: GateCaseResult = {
      ...base,
      value: NaN,
      expected: NaN,
      unit: '',
      error: NaN,
      tolerance: NaN,
      errorUnit: '%',
      passed: false,
      energyDrift: NaN,
      energyTolerance: NaN,
      energyPassed: false,
      overflow: false,
      n: engine?.scene.n ?? 0,
      steps: 0,
      time: 0,
      wallSeconds: (now() - t0) / 1000,
      failure,
    };
    return { result };
  } finally {
    engine?.destroy();
  }
}

function countDiffering(a: Snapshot, b: Snapshot): number {
  if (a.planes.length !== b.planes.length || a.n !== b.n) return Infinity;
  const wa = new Uint32Array(a.planes.buffer, a.planes.byteOffset, a.planes.byteLength / 4);
  const wb = new Uint32Array(b.planes.buffer, b.planes.byteOffset, b.planes.byteLength / 4);
  let d = 0;
  for (let i = 0; i < wa.length; i++) if (wa[i] !== wb[i]) d++;
  for (let i = 0; i < a.n; i++) if (a.tags[i] !== b.tags[i]) d++;
  return d;
}

function summarize(cases: GateCaseResult[], determinism: DeterminismResult[], scale: number): GateTestSummary[] {
  const fmt = (v: number, d = 2) => v.toFixed(d).replace('.', ',');
  return GATE_TESTS.map(({ test, title }) => {
    if (test === '12.10') {
      const ok = determinism.filter((d) => d.identical).length;
      return {
        test,
        title,
        ran: determinism.length > 0,
        passed: determinism.length > 0 && ok === determinism.length,
        detail: `${ok} из ${determinism.length} сценариев побитово`,
      };
    }
    if (test === '12.2') {
      const worst = Math.max(...cases.map((c) => Math.abs(c.energyDrift)));
      const ok = cases.filter((c) => c.energyPassed).length;
      return {
        test,
        title,
        ran: cases.length > 0,
        passed: cases.length > 0 && ok === cases.length,
        detail: `${ok} из ${cases.length}; худший дрейф ${fmt(worst)} % при допуске ${fmt(2 * scale, 0)} %`,
      };
    }
    const mine = cases.filter((c) => c.test === test);
    const ok = mine.filter((c) => c.passed).length;
    const rel = mine.filter((c) => c.errorUnit === '%' && Number.isFinite(c.error));
    const worst = rel.length
      ? `; худшее отклонение ${fmt(Math.max(...rel.map((c) => Math.abs(c.error))))} % при допуске ${fmt(rel[0].tolerance, 0)} %`
      : '';
    return {
      test,
      title,
      ran: mine.length > 0,
      passed: mine.length > 0 && ok === mine.length,
      detail: `${ok} из ${mine.length}${worst}`,
    };
  });
}

export async function runGate(opts: GateOptions): Promise<GateReport> {
  const preset = GATE_PRESETS[opts.preset];
  const t0 = now();
  const selected = opts.cases ? GATE_CASES.filter((c) => opts.cases!.includes(c.id)) : GATE_CASES;
  const twice = new Set(opts.determinism ?? DEFAULT_DETERMINISM);
  const cases: GateCaseResult[] = [];
  const determinism: DeterminismResult[] = [];
  let engineKind: EngineKind = 'cpu';

  const factory: EngineFactory = async (scene) => {
    const e = await opts.engine(scene);
    engineKind = e.kind;
    return e;
  };

  for (const c of selected) {
    if (opts.signal?.aborted) break;
    opts.onStatus?.(`${c.test} · ${c.label}`);
    const { result, snapshot } = await runGateCase(c, opts.preset, factory, opts.signal);
    cases.push(result);
    opts.onCase?.(result);
    if (snapshot && twice.has(c.id) && !opts.signal?.aborted) {
      opts.onStatus?.(`12.10 · повтор: ${c.label}`);
      const again = await runGateCase(c, opts.preset, factory, opts.signal);
      const differing = again.snapshot ? countDiffering(snapshot, again.snapshot) : Infinity;
      determinism.push({ id: c.id, label: c.label, identical: differing === 0, differing, steps: snapshot.steps });
    }
  }

  const tests = summarize(cases, determinism, preset.toleranceScale);
  const ran = tests.filter((t) => t.ran);
  return {
    preset: preset.id,
    presetLabel: preset.label,
    dx: preset.dx,
    toleranceScale: preset.toleranceScale,
    engine: engineKind,
    cases,
    determinism,
    tests,
    passed: ran.length > 0 && ran.every((t) => t.passed),
    wallSeconds: (now() - t0) / 1000,
  };
}
