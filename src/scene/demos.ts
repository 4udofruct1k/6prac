// Демо-сцены для вкладки «Демо»: что видно глазами, с разумными диапазонами полей.

import { VizMode } from '../sim/layout';
import type { PreparedScene } from './scene';
import { demoScene, taylorScene } from './scenes';

export interface DemoScenario {
  id: string;
  label: string;
  /** Подпись к разрешению: что означает число */
  resolutionLabel: string;
  resolutions: number[];
  defaultResolution: number;
  build(resolution: number): PreparedScene;
  /** Мкс события за кадр по умолчанию */
  usPerFrame: number;
  /** Диапазоны полей для цветовой шкалы */
  ranges: Partial<Record<VizMode, [number, number]>>;
  defaultViz: VizMode;
  note: string;
}

export const DEMOS: DemoScenario[] = [
  {
    id: 'taylor',
    label: 'Цилиндр Тейлора: медь, 190 м/с',
    resolutionLabel: 'Частиц по радиусу',
    resolutions: [8, 14, 28],
    defaultResolution: 14,
    build: (k) => taylorScene('copper_ofhc', 0.19, 25.4, 3.81 / k),
    usPerFrame: 1,
    ranges: {
      [VizMode.Speed]: [0, 0.2],
      [VizMode.Pressure]: [-1, 1],
      [VizMode.Temperature]: [293, 600],
      [VizMode.PlasticStrain]: [0, 2],
      [VizMode.Damage]: [0, 1],
      [VizMode.VonMises]: [0, 0.4],
    },
    defaultViz: VizMode.PlasticStrain,
    note:
      'Медный цилиндр 25,4 × 7,62 мм бьётся о жёсткую стенку со скоростью 190 м/с (Johnson & Cook 1983, рис. 9). ' +
      'Осесимметричный режим, Ми–Грюнайзен и Джонсон–Кук. По опыту и расчёту авторов длина после удара — 0,678 L₀.',
  },
  {
    id: 'block',
    label: 'Упругий блок (M0)',
    resolutionLabel: 'Частиц по стороне',
    resolutions: [24, 48, 96, 160],
    defaultResolution: 48,
    build: (across) => demoScene({ across }),
    usPerFrame: 3,
    ranges: {
      [VizMode.Speed]: [0, 0.12],
      [VizMode.Pressure]: [-0.01, 0.01],
      [VizMode.Temperature]: [293, 294],
      [VizMode.PlasticStrain]: [0, 1],
      [VizMode.Damage]: [0, 1],
      [VizMode.VonMises]: [0, 0.01],
    },
    defaultViz: VizMode.Speed,
    note:
      'Блок демо-эластомера 40×40 мм (параметры tuned) налетает на жёсткий пол со скоростью 67 м/с с вращением ' +
      'и отскакивает. Ядро M1 считает его гипоупругим: при сжатии на 30 % блок отскакивает слабее и сильнее ' +
      'колеблется, чем неогуковский блок M0; модель эластомеров — веха M3. Гравитация не включена.',
  },
];
