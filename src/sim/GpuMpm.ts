// Хост-часть ядра MPM на WebGPU: буферы, конвейеры, шаги, чтение снимков.
// Ядро не знает об интерфейсе (13): на входе подготовленная сцена, на выходе буфер частиц.
// Шаг = gridUpdate + g2p2g (см. kernels.ts); перед первым шагом — отдельный p2g.

import type { PreparedScene } from '../scene/scene';
import { MATERIAL_BYTES, MPM_WGSL, PARAMS_BYTES } from './kernels';
import {
  BYTES_PER_GRID_NODE,
  DEFAULT_STORAGE_MODE,
  MAX_MATERIALS,
  PLANE_COUNT,
  STORAGE_MODES,
  VizMode,
  WORKGROUP_SIZE,
  type StorageMode,
} from './layout';

interface Pipelines {
  p2g: GPUComputePipeline;
  grid: GPUComputePipeline;
  g2p2g: GPUComputePipeline;
}

const pipelineCache = new WeakMap<GPUDevice, Promise<Pipelines>>();

function getPipelines(device: GPUDevice): Promise<Pipelines> {
  let p = pipelineCache.get(device);
  if (!p) {
    const module = device.createShaderModule({ label: 'mpm', code: MPM_WGSL });
    const make = (entryPoint: string) =>
      device.createComputePipelineAsync({ label: entryPoint, layout: 'auto', compute: { module, entryPoint } });
    p = Promise.all([make('p2g'), make('gridUpdate'), make('g2p2g')]).then(([p2g, grid, g2p2g]) => ({
      p2g,
      grid,
      g2p2g,
    }));
    pipelineCache.set(device, p);
  }
  return p;
}

export class GpuMpm {
  readonly n: number;
  readonly gridNodes: number;
  readonly particleBuffer: GPUBuffer;
  stepCount = 0;

  /** Параметры шага; в режиме l2 g2p2g с ними не пишет v, C и VIZ */
  private readonly params: GPUBuffer;
  /** Те же параметры с записью v, C и VIZ — для последнего шага перед кадром или чтением */
  private readonly paramsAux: GPUBuffer;
  private readonly grid: GPUBuffer;
  private readonly gridV: GPUBuffer;
  private readonly status: GPUBuffer;
  private readonly bgP2g: GPUBindGroup;
  private readonly bgGrid: GPUBindGroup;
  private readonly bgStep: GPUBindGroup;
  private readonly bgStepAux: GPUBindGroup;
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

    const particleBytes = PLANE_COUNT * n * 4;
    const gridBytes = 3 * this.gridNodes * 4;
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
    this.grid = device.createBuffer({ label: 'grid-i32', size: gridBytes, usage: GPUBufferUsage.STORAGE });
    this.gridV = device.createBuffer({ label: 'grid-v', size: this.gridNodes * 8, usage: GPUBufferUsage.STORAGE });
    this.status = device.createBuffer({
      label: 'status',
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    device.queue.writeBuffer(this.particleBuffer, 0, scene.planes as Float32Array<ArrayBuffer>);
    this.writeParams();

    const entries = (bindings: [number, GPUBuffer][]): GPUBindGroupEntry[] =>
      bindings.map(([binding, buffer]) => ({ binding, resource: { buffer } }));
    this.bgP2g = device.createBindGroup({
      layout: pipes.p2g.getBindGroupLayout(0),
      entries: entries([
        [0, this.params],
        [1, this.particleBuffer],
        [2, this.grid],
      ]),
    });
    this.bgGrid = device.createBindGroup({
      layout: pipes.grid.getBindGroupLayout(0),
      entries: entries([
        [0, this.params],
        [2, this.grid],
        [3, this.gridV],
        [4, this.status],
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
        ]),
      });
    this.bgStep = stepGroup(this.params);
    this.bgStepAux = stepGroup(this.paramsAux);
  }

  /** Байт, которые шаг трогает в памяти: поля частиц по режиму + сетка. Сравнивать с кэшем L2. */
  get workingSetBytes(): number {
    return STORAGE_MODES[this.mode].bytesPerParticle * this.n + BYTES_PER_GRID_NODE * this.gridNodes;
  }

  get dt(): number {
    return this.scene.dt;
  }

  /** Время события, мкс */
  get time(): number {
    return this.stepCount * this.scene.dt;
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
    u[0] = s.n;
    u[1] = s.gx;
    u[2] = s.gy;
    u[3] = s.gx * s.gy;
    f[4] = s.h;
    f[5] = 1 / s.h;
    f[6] = s.dt;
    f[7] = s.gravityY;
    f[8] = s.massScale;
    f[9] = s.momScale;
    u[10] = s.boundaryNodes;
    u[11] = this.vizMode;
    u[12] = storeAux ? 1 : 0;
    // Режим l2: масса = ρ·Δx², объём = Δx² — теми же выражениями, что в prepareScene (один Δx на сцену),
    // поэтому после округления до f32 значения побитово равны плоскостям MASS и VOL0
    u[13] = this.mode === 'l2' ? 1 : 0;
    f[14] = s.dx * s.dx;
    for (let m = 0; m < Math.min(s.materials.length, MAX_MATERIALS); m++) {
      const mat = s.materials[m];
      f.set([mat.lambda, mat.mu, mat.rho, mat.c, mat.rho * s.dx * s.dx], 16 + (m * MATERIAL_BYTES) / 4);
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
    }
    pass.end();
    this.stepCount += count;
  }

  step(count: number, aux = true): void {
    const encoder = this.device.createCommandEncoder();
    this.encodeSteps(encoder, count, aux);
    this.device.queue.submit([encoder.finish()]);
  }

  /** Снимок первых `planes` плоскостей частиц (раскладка как в PreparedScene.planes). */
  async readParticles(planes = PLANE_COUNT): Promise<Float32Array> {
    return new Float32Array(await this.readBuffer(this.particleBuffer, planes * this.n * 4));
  }

  /** Бит 0: значение на узле сетки подошло к пределу i32 фиксированной точки. */
  async readStatus(): Promise<number> {
    return new Uint32Array(await this.readBuffer(this.status, 16))[0];
  }

  private async readBuffer(src: GPUBuffer, size: number): Promise<ArrayBuffer> {
    const staging = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(src, 0, staging, 0, size);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const copy = staging.getMappedRange().slice(0);
    staging.destroy();
    return copy;
  }

  destroy(): void {
    for (const b of [this.params, this.paramsAux, this.particleBuffer, this.grid, this.gridV, this.status]) b.destroy();
  }
}

function mb(bytes: number): string {
  return `${(bytes / 2 ** 20).toFixed(1)} МБ`;
}
