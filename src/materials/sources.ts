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
  li_ecf19: {
    title: 'Li et al., ECF19 — Experimental observations to the spall of metal tubes under inward sliding detonation',
    url: 'https://gruppofrattura.it/ocs/index.php/esis/ECF19/paper/download/8963/5737',
    note: 'Откольная прочность OFHC-меди 1,9 ГПа, «в согласии с плоскими ударами» Koller et al., J. Appl. Phys. 98, 103518 (2005)',
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
