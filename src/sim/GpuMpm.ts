// Хост-часть ядра MPM на WebGPU: буферы, конвейеры, шаги, чтение снимков.
// Ядро не знает об интерфейсе (13): на входе подготовленная сцена, на выходе буфер частиц.
// Шаг = gridUpdate + g2p2g + finalize (см. kernels.ts); перед первым шагом — отдельный p2g.
// Δt и время живут на GPU (буфер состояния шага): хост узнаёт их чтением readStep().

import { T_ROOM } from '../materials/models';
import type { PreparedScene } from '../scene/scene';
import { MATERIAL_FLOATS, MPM_WGSL, PARAMS_BYTES, PARAMS_HEADER_WORDS } from './kernels';
import {
  BYTES_PER_GRID_NODE,
  DEFAULT_STORAGE_MODE,
  FIELDS,
  GRID_ACC_PER_FIELD,
  GRID_V_STRIDE,
  MAX_MATERIALS,
  PLANE_COUNT,
  STEP,
  STEP_WORDS,
  STORAGE_MODES,
  VizMode,
  WORKGROUP_SIZE,
  type StorageMode,
} from './layout';

interface Pipelines {
  p2g: GPUComputePipeline;
  grid: GPUComputePipeline;
  g2p2g: GPUComputePipeline;
  finalize: GPUComputePipeline;
}

const pipelineCache = new WeakMap<GPUDevice, Promise<Pipelines>>();

function getPipelines(device: GPUDevice): Promise<Pipelines> {
  let p = pipelineCache.get(device);
  if (!p) {
    const module = device.createShaderModule({ label: 'mpm', code: MPM_WGSL });
    const make = (entryPoint: string) =>
      device.createComputePipelineAsync({ label: entryPoint, layout: 'auto', compute: { module, entryPoint } });
    p = Promise.all([make('p2g'), make('gridUpdate'), make('g2p2g'), make('finalize')]).then(
      ([p2g, grid, g2p2g, finalize]) => ({ p2g, grid, g2p2g, finalize }),
    );
    pipelineCache.set(device, p);
  }
  return p;
}

export interface StepInfo {
  /** Время события, мкс */
  time: number;
  dt: number;
  steps: number;
  /** Накопитель узла подходил к пределу i32 */
  overflow: boolean;
  /** Частиц ушло за границу области */
  removed: number;
}

export class GpuMpm {
  readonly n: number;
  readonly gridNodes: number;
  readonly particleBuffer: GPUBuffer;
  /** Шагов записано в команды (для HUD без чтения с GPU) */
  stepCount = 0;
  /** Последнее прочитанное состояние шага */
  info: StepInfo;

  /** Параметры шага; в режиме l2 g2p2g с ними не пишет v, C и VIZ */
  private readonly params: GPUBuffer;
  /** Те же параметры с записью v, C и VIZ — для последнего шага перед кадром или чтением */
  private readonly paramsAux: GPUBuffer;
  private readonly grid: GPUBuffer;
  private readonly gridV: GPUBuffer;
  private readonly stepState: GPUBuffer;
  private readonly bgP2g: GPUBindGroup;
  private readonly bgGrid: GPUBindGroup;
  private readonly bgStep: GPUBindGroup;
  private readonly bgStepAux: GPUBindGroup;
  private readonly bgFinalize: GPUBindGroup;
  private vizMode: VizMode = VizMode.Speed;
  /** Первый P2G уже записан */
  private primed = false;

  static async create(device: GPUDevice, scene: PreparedScene, opts: { mode?: StorageMode } = {}): Promise<GpuMpm> {
    return new GpuMpm(device, scene, await getPipelines(device), opts.mode ?? DEFAULT_STORAGE_MODE);
  }

  private constructor(
    readonly device: GPUDevice,
    readonly scene: PreparedScene,
    private readonly pipes: Pipelines,
    readonly mode: StorageMode,
  ) {
    const { n, gx, gy } = scene;
    this.n = n;
    this.gridNodes = gx * gy;
    this.info = { time: 0, dt: scene.dt0, steps: 0, overflow: false, removed: 0 };

    const particleBytes = PLANE_COUNT * n * 4;
    const gridBytes = FIELDS * GRID_ACC_PER_FIELD * this.gridNodes * 4;
    const maxBinding = device.limits.maxStorageBufferBindingSize;
    if (particleBytes > maxBinding || gridBytes > maxBinding) {
      throw new Error(
        `Сцена не помещается в лимит устройства: частицы ${mb(particleBytes)}, сетка ${mb(gridBytes)}, ` +
          `maxStorageBufferBindingSize ${mb(maxBinding)}`,
      );
    }
    if (Math.ceil(Math.max(n, this.gridNodes) / WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension) {
      throw new Error(`Слишком много частиц для одномерного dispatch: ${n}`);
    }

    const uniform = (label: string) =>
      device.createBuffer({ label, size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.params = uniform('params');
    this.paramsAux = uniform('params-aux');
    this.particleBuffer = device.createBuffer({
      label: 'particles',
      size: particleBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    // COPY_SRC — чтобы при переполнении фиксированной точки прочитать накопители и найти узел
    this.grid = device.createBuffer({
      label: 'grid-i32',
      size: gridBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.gridV = device.createBuffer({
      label: 'grid-v',
      size: GRID_V_STRIDE * this.gridNodes * 4,
      usage: GPUBufferUsage.STORAGE,
    });
    this.stepState = device.createBuffer({
      label: 'step-state',
      size: STEP_WORDS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    device.queue.writeBuffer(this.particleBuffer, 0, scene.planes as Float32Array<ArrayBuffer>);
    const st = new ArrayBuffer(STEP_WORDS * 4);
    const stf = new Float32Array(st);
    stf[STEP.DT_CUR] = scene.dt0;
    stf[STEP.DT_NEXT] = scene.dt0;
    device.queue.writeBuffer(this.stepState, 0, st);
    this.writeParams();

    const entries = (bindings: [number, GPUBuffer][]): GPUBindGroupEntry[] =>
      bindings.map(([binding, buffer]) => ({ binding, resource: { buffer } }));
    this.bgP2g = device.createBindGroup({
      layout: pipes.p2g.getBindGroupLayout(0),
      entries: entries([
        [0, this.params],
        [1, this.particleBuffer],
        [2, this.grid],
        [4, this.stepState],
      ]),
    });
    this.bgGrid = device.createBindGroup({
      layout: pipes.grid.getBindGroupLayout(0),
      entries: entries([
        [0, this.params],
        [2, this.grid],
        [3, this.gridV],
        [4, this.stepState],
      ]),
    });
    const stepGroup = (params: GPUBuffer) =>
      device.createBindGroup({
        layout: pipes.g2p2g.getBindGroupLayout(0),
        entries: entries([
          [0, params],
          [1, this.particleBuffer],
          [2, this.grid],
          [3, this.gridV],
          [4, this.stepState],
        ]),
      });
    this.bgStep = stepGroup(this.params);
    this.bgStepAux = stepGroup(this.paramsAux);
    this.bgFinalize = device.createBindGroup({
      layout: pipes.finalize.getBindGroupLayout(0),
      entries: entries([
        [0, this.params],
        [4, this.stepState],
      ]),
    });
  }

  /** Байт, которые шаг трогает в памяти: поля частиц по режиму + сетка. Сравнивать с кэшем L2. */
  get workingSetBytes(): number {
    const perParticle = STORAGE_MODES[this.mode].bytesPerParticle + (this.scene.mode === 'axisym' ? 4 : 0);
    return perParticle * this.n + BYTES_PER_GRID_NODE * this.gridNodes;
  }

  /** Время события по последнему чтению, мкс */
  get time(): number {
    return this.info.time;
  }

  setVizMode(mode: VizMode): void {
    if (mode === this.vizMode) return;
    this.vizMode = mode;
    this.writeParams();
  }

  private writeParams(): void {
    this.device.queue.writeBuffer(this.params, 0, this.packParams(this.mode === 'full'));
    this.device.queue.writeBuffer(this.paramsAux, 0, this.packParams(true));
  }

  private packParams(storeAux: boolean): ArrayBuffer {
    const s = this.scene;
    const buf = new ArrayBuffer(PARAMS_BYTES);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    u.set([s.n, s.gx, s.gy, s.gx * s.gy], 0);
    f.set([s.h, 1 / s.h, s.dx, s.cfl], 4);
    f.set([s.massScale, s.momScale, s.gradScale, s.kScale], 8);
    f.set([s.origin[0], s.origin[1], s.c1, s.c2], 12);
    f.set([s.domain.xmin, s.domain.xmax, s.domain.ymin, s.domain.ymax], 16);
    f.set([s.friction, s.rmin, s.gravityY, T_ROOM], 20);
    u.set([this.vizMode, storeAux ? 1 : 0, s.mode === 'axisym' ? 1 : 0, s.lockX ? 1 : 0], 24);
    u.set([s.bc.left, s.bc.right, s.bc.bottom, s.bc.top], 28);
    // Тот же f32, что засеян в плоскость VOL0 в плоском режиме
    f[32] = Math.fround(s.dx * s.dx);
    for (let m = 0; m < Math.min(s.materials.length, MAX_MATERIALS); m++) {
      const mat = s.materials[m];
      const etaMax = mat.s > 0 ? 0.9 / mat.s : 0.9;
      f.set(
        [
          mat.rho0, mat.C0, mat.s, mat.gamma0,
          mat.G, mat.A, mat.B, mat.n,
          mat.C, mat.m, mat.Tm, mat.cp,
          mat.beta, ...mat.D.slice(0, 3),
          ...mat.D.slice(3), Number.isFinite(mat.pmin) ? mat.pmin : -1e30, mat.strength,
          mat.damage, etaMax, 0, 0,
        ],
        PARAMS_HEADER_WORDS + m * MATERIAL_FLOATS,
      );
    }
    return buf;
  }

  /**
   * Записывает `count` шагов в один compute-проход.
   * `aux` — последний шаг пишет v, C и VIZ (нужно перед кадром и чтением v); в режиме full пишут все шаги.
   */
  encodeSteps(encoder: GPUCommandEncoder, count: number, aux = true): void {
    if (count <= 0) return;
    const pass = encoder.beginComputePass({ label: 'mpm-steps' });
    const pg = Math.ceil(this.n / WORKGROUP_SIZE);
    const gg = Math.ceil(this.gridNodes / WORKGROUP_SIZE);
    if (!this.primed) {
      pass.setPipeline(this.pipes.p2g);
      pass.setBindGroup(0, this.bgP2g);
      pass.dispatchWorkgroups(pg);
      this.primed = true;
    }
    for (let k = 0; k < count; k++) {
      pass.setPipeline(this.pipes.grid);
      pass.setBindGroup(0, this.bgGrid);
      pass.dispatchWorkgroups(gg);
      pass.setPipeline(this.pipes.g2p2g);
      pass.setBindGroup(0, aux && k === count - 1 ? this.bgStepAux : this.bgStep);
      pass.dispatchWorkgroups(pg);
      pass.setPipeline(this.pipes.finalize);
      pass.setBindGroup(0, this.bgFinalize);
      pass.dispatchWorkgroups(1);
    }
    pass.end();
    this.stepCount += count;
  }

  step(count: number, aux = true): void {
    const encoder = this.device.createCommandEncoder();
    this.encodeSteps(encoder, count, aux);
    this.device.queue.submit([encoder.finish()]);
  }

  /** Время, Δt и флаги шага с GPU. */
  async readStep(): Promise<StepInfo> {
    const raw = await this.readBuffer(this.stepState, 0, STEP_WORDS * 4);
    const u = new Uint32Array(raw);
    const f = new Float32Array(raw);
    this.info = {
      time: f[STEP.TIME],
      dt: f[STEP.DT_CUR],
      steps: u[STEP.STEPS],
      overflow: (u[STEP.FLAGS] & 1) !== 0,
      removed: u[STEP.REMOVED],
    };
    return this.info;
  }

  /** Снимок первых `planes` плоскостей частиц (раскладка как в PreparedScene.planes). */
  async readParticles(planes = PLANE_COUNT): Promise<Float32Array> {
    return new Float32Array(await this.readBuffer(this.particleBuffer, 0, planes * this.n * 4));
  }

  /** Снимок одной плоскости. */
  async readPlane(plane: number): Promise<Float32Array> {
    return new Float32Array(await this.readBuffer(this.particleBuffer, plane * this.n * 4, this.n * 4));
  }

  /** Бит 0: значение на узле сетки подошло к пределу i32 фиксированной точки. */
  async readStatus(): Promise<number> {
    return (await this.readStep()).overflow ? 1 : 0;
  }

  private async readBuffer(src: GPUBuffer, offset: number, size: number): Promise<ArrayBuffer> {
    const staging = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(src, offset, staging, 0, size);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const copy = staging.getMappedRange().slice(0);
    staging.destroy();
    return copy;
  }

  destroy(): void {
    for (const b of [this.params, this.paramsAux, this.particleBuffer, this.grid, this.gridV, this.stepState]) b.destroy();
  }
}

function mb(bytes: number): string {
  return `${(bytes / 2 ** 20).toFixed(1)} МБ`;
}
