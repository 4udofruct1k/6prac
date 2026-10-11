// Источники параметров материалов (раздел 16 спеки + найденные в M1). Ключ — поле source в базе.

export interface Source {
  title: string;
  url: string;
  /** Что именно взято из источника */
  note?: string;
}

export const SOURCES: Record<string, Source> = {
  jc1983: {
    title: 'Johnson & Cook, 1983 — A constitutive model and data for metals',
    url: 'https://ia800406.us.archive.org/4/items/AConstitutiveModelAndDataForMetals/A%20constitutive%20model%20and%20data%20for%20metals_text.pdf',
    note: 'Таблица 1: ρ, cp, Tm, A, B, n, C, m; рисунок 9: цилиндры Тейлора',
  },
  bertarelli: {
    title: 'Bertarelli, CERN — Beam-Induced Damage Mechanisms (таблицы JC, теплофизика)',
    url: 'https://arxiv.org/pdf/1608.03056',
  },
  batra: {
    title: 'Batra — 4340 в Dyna2D (K, G, cp)',
    url: 'https://rkriz.net/ftp/crcd/mmcmurtr/batra/batra.htm',
  },
  mech_ind_2017: {
    title: 'Mechanics & Industry, 2017 — Ми–Грюнайзен для 4340',
    url: 'https://www.mechanics-industry.org/articles/meca/full_html/2017/06/mi170176/T3.html',
  },
  chemie_de: {
    title: 'chemie.de — уравнение Ми–Грюнайзена (сталь, медь, вода)',
    url: 'https://www.chemie.de/lexikon/Mie-Gr%C3%BCneisen-Zustandsgleichung.html',
  },
  cjsm: {
    title: 'Chinese Journal of Solid Mechanics — JC-разрушение, D1–D3',
    url: 'https://www.cpsjournals.cn/article/id/5d721bb9e218cb111369a29c',
  },
  banerjee2005: {
    title: 'Banerjee, 2005 — The Mechanical Threshold Stress model for various tempers of AISI 4340 steel',
    url: 'https://arxiv.org/pdf/cond-mat/0510330',
    note: 'Раздел 3.4: C0 = 3935 м/с, Sα = 1,578 для железа по Brown et al. 2000, Γ0 = 1,69 по Gust; таблица 2: G = 81,9 ГПа (Guinan & Steinberg)',
  },
  nguyen2026: {
    title:
      'Nguyen, Luscher, Buechler, Prime, Fensin — Reformulating a Gurson-based dynamic damage model and demonstrating improved predictive power and numerical robustness, Int. J. Solids Struct. (2026), LA-UR-25-23638',
    url: 'https://www.osti.gov/biblio/3013803',
    note: 'Ур. 2.6–2.18 (модифицированная Tepla: τ_r = η(1 − φ)/φ, только гидростатическая вязкость); табл. 3, с. 19: полутвёрдая медь φ0 = 8,19·10⁻⁴, Y_sat = 193 МПа, η = 6,05·10⁻⁴ Мбар·мкс, φ_f = 0,25, q1 = 1, q2 = 1,5, q3 = 2,25',
  },
  bless1981: {
    title: 'Bless — Spall criteria for several metals, AFWAL-TR-81-4040 (University of Dayton Research Institute, 1981)',
    url: 'https://apps.dtic.mil/sti/pdfs/ADA112445.pdf',
    note:
      'Табл. 4, с. 37: удары Cu по Cu (OFHC, RF48) — толщины ударника и мишени, скорость, результат (нет пор / слой пор / отделение). ' +
      'Табл. 11, с. 82: удары 4340 Rc30 по 4340 (1/5 и 2/4 мм) — нет повреждений / отдельные поры / связанные поры / отделение; ' +
      'табл. 12, с. 83: VISAR, спад скорости тыла 198 ± 5 м/с при 356 м/с и 220 ± 10 м/с при 408 м/с (2/4 мм); с. 80: порог 345 ± 10 м/с (2/4 мм)',
  },
  thomas2018: {
    title:
      'Thomas, Hawkins, Matthes, Gray, Hixson — Dynamic strength properties and alpha-phase shock Hugoniot of iron and steel, J. Appl. Phys. 123, 175902 (2018)',
    url: 'https://www.osti.gov/servlets/purl/1735933',
    note: 'Табл. II–V: железо высокой чистоты (в табл. I — «Armco»), симметричный удар 3,99/7,92–7,98 мм при 195, 298 и 396 м/с: спад скорости тыла 110, 101 и 101 м/с (откольная прочность 1,99, 1,83, 1,85 ГПа)',
  },
  seaman1975: {
    title:
      'Seaman, Curran, Shockey et al. — Models for ductile and brittle fracture for two-dimensional wave propagation calculations, SRI для AMMRC, AD-A008992 (1975)',
    url: 'https://apps.dtic.mil/sti/pdfs/ADA008992.pdf',
    note: 'Табл. V, с. 57: модель SRI для армко-железа (хрупкое разрушение) — вязкость η = 417 П = 0,0417 ГПа·мкс, рост трещин Ṙ/R = Δσ/(4η)',
  },
  peng2015: {
    title: 'Peng, Pei, Li, He, Bai — Micro-damage characteristics of incipient spall in high-purity copper, Acta Phys. Sin. 64, 216201 (2015)',
    url: 'https://wulixb.iphy.ac.cn/en/article/doi/10.7498/aps.64.216201',
    note: 'Табл. 1: удары Cu по Cu, толщины, скорость, длительность растяжения; повреждение без отделения (до 0,096)',
  },
  spec: {
    title: 'ARMOR_SPEC — значение задано спекой',
    url: 'docs/ARMOR_SPEC.md',
  },
  m0_demo: {
    title: 'Демо M0 — подобрано под картинку',
    url: 'docs/M0.md',
  },
};
