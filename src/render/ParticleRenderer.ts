// Рендер частиц сплэтами (11): плоскости X, Y, VIZ, TAG буфера ядра подключаются как
// instance-вершинные буферы по смещению — без копий и без storage-буферов в вершинном шейдере
// (их нет в режиме совместимости WebGPU).

import type { GpuMpm } from '../sim/GpuMpm';
import { PLANE, TAG_BODY_SHIFT, TAG_REMOVED, VizMode } from '../sim/layout';

const RENDER_WGSL = /* wgsl */ `
struct View {
  scale: vec2f,
  offset: vec2f,
  half: vec2f,
  range: vec2f,
  mode: u32,
  _p0: u32,
  _p1: u32,
  _p2: u32,
  /** Где стоят стенки: x0, y0, x1, y1 в мм */
  wall: vec4f,
}
@group(0) @binding(0) var<uniform> V: View;

@vertex
fn vsFrame(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 5>(V.wall.xy, V.wall.zy, V.wall.zw, V.wall.xw, V.wall.xy);
  return vec4f(corners[vi] * V.scale + V.offset, 0.0, 1.0);
}

@fragment
fn fsFrame() -> @location(0) vec4f {
  return vec4f(0.22, 0.25, 0.3, 1.0);
}

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) val: f32,
  @location(2) body: f32,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32,
      @location(0) px: f32, @location(1) py: f32, @location(2) val: f32, @location(3) tag: u32) -> VSOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  var out: VSOut;
  out.pos = vec4f(vec2f(px, py) * V.scale + V.offset + c * V.half, 0.0, 1.0);
  out.uv = c;
  out.val = val;
  out.body = f32((tag >> ${TAG_BODY_SHIFT}u) & 0xffu);
  if ((tag & ${TAG_REMOVED}u) != 0u) {
    // Ушедшие за границу частицы не рисуем
    out.pos = vec4f(2.0, 2.0, 0.0, 1.0);
  }
  return out;
}

// Полиномиальное приближение палитры inferno
fn inferno(t: f32) -> vec3f {
  let c0 = vec3f(0.0002189403691192265, 0.001651004631001012, -0.01948089843709184);
  let c1 = vec3f(0.1065134194856116, 0.5639564367884091, 3.932712388889277);
  let c2 = vec3f(11.60249308247187, -3.972853965665698, -15.9423941062914);
  let c3 = vec3f(-41.70399613139459, 17.43639888205313, 44.35414519872813);
  let c4 = vec3f(77.162935699427, -33.40235894210092, -81.80730925738993);
  let c5 = vec3f(-71.31942824499214, 32.62606426397723, 73.20951985803202);
  let c6 = vec3f(25.13112622477341, -12.24266895238567, -23.07032500287172);
  return clamp(c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6))))), vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let r2 = dot(in.uv, in.uv);
  if (r2 > 1.0) {
    discard;
  }
  var col: vec3f;
  if (V.mode == ${VizMode.Body}u) {
    var palette = array<vec3f, 4>(
      vec3f(0.54, 0.58, 0.65), vec3f(0.88, 0.63, 0.29), vec3f(0.36, 0.66, 0.84), vec3f(0.62, 0.82, 0.45));
    col = palette[u32(in.body + 0.5) % 4u];
  } else if (V.mode == ${VizMode.Pressure}u) {
    // Сжатие — inferno, растяжение — синяя шкала; диапазон симметричный
    let t = clamp(in.val / V.range.y, -1.0, 1.0);
    if (t >= 0.0) {
      col = inferno(0.15 + 0.85 * t);
    } else {
      col = mix(vec3f(0.12, 0.14, 0.2), vec3f(0.35, 0.7, 1.0), -t);
    }
  } else {
    // Низ шкалы — тёмно-фиолетовый, не чёрный: недеформированный металл виден на тёмном фоне
    col = inferno(0.15 + 0.85 * clamp((in.val - V.range.x) / (V.range.y - V.range.x), 0.0, 1.0));
  }
  return vec4f(col * (1.0 - 0.25 * r2), 1.0);
}
`;

export interface ViewRange {
  min: number;
  max: number;
}

export class ParticleRenderer {
  private readonly pipeline: GPURenderPipeline;
  private readonly framePipeline: GPURenderPipeline;
  private readonly viewBuf: GPUBuffer;
  private readonly viewBufMirror: GPUBuffer;
  private readonly bindGroupMirror: GPUBindGroup;
  private readonly bindGroup: GPUBindGroup;
  readonly format: GPUTextureFormat;

  constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
  ) {
    this.format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: this.format, alphaMode: 'opaque' });
    const module = device.createShaderModule({ label: 'particles', code: RENDER_WGSL });
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
    const scalar = (location: number, format: GPUVertexFormat): GPUVertexBufferLayout => ({
      arrayStride: 4,
      stepMode: 'instance',
      attributes: [{ shaderLocation: location, offset: 0, format }],
    });
    this.pipeline = device.createRenderPipeline({
      label: 'particles',
      layout,
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [scalar(0, 'float32'), scalar(1, 'float32'), scalar(2, 'float32'), scalar(3, 'uint32')],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.framePipeline = device.createRenderPipeline({
      label: 'frame',
      layout,
      vertex: { module, entryPoint: 'vsFrame' },
      fragment: { module, entryPoint: 'fsFrame', targets: [{ format: this.format }] },
      primitive: { topology: 'line-strip' },
    });
    this.viewBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.viewBufMirror = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.viewBuf } }],
    });
    this.bindGroupMirror = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.viewBufMirror } }],
    });
  }

  /**
   * Вписывает область сцены в холст с сохранением пропорций; y вверх.
   * Осесимметричная сцена рисуется целым разрезом: вторая копия отражена относительно оси.
   */
  encode(encoder: GPUCommandEncoder, sim: GpuMpm, mode: VizMode, range: ViewRange): void {
    const canvas = this.context.canvas as HTMLCanvasElement;
    const { xmin, xmax, ymin, ymax } = sim.scene.domain;
    const mirror = sim.scene.mode === 'axisym';
    const x0 = mirror ? -xmax : xmin;
    const w = xmax - x0;
    const h = ymax - ymin;
    const aspect = canvas.width / canvas.height;
    const sceneAspect = w / h;
    const sx = sceneAspect > aspect ? 2 / w : (2 / h) * (1 / aspect);
    const sy = sx * aspect;
    const cx = x0 + w / 2;
    const cy = ymin + h / 2;
    const pack = (flip: number) => {
      const view = new ArrayBuffer(64);
      const f = new Float32Array(view);
      const u = new Uint32Array(view);
      f.set([flip * sx, sy, -cx * sx, -cy * sy]);
      // Радиус сплэта ≈ 0,6·Δx, но не меньше пикселя
      const halfPx = Math.max(0.6 * sim.scene.dx * sx * (canvas.width / 2), 0.75);
      f.set([halfPx / (canvas.width / 2), halfPx / (canvas.height / 2)], 4);
      f.set([range.min, range.max], 6);
      u[8] = mode;
      // Рамка — граница расчётной области
      f.set([xmin, ymin, xmax, ymax], 12);
      return view;
    };
    this.device.queue.writeBuffer(this.viewBuf, 0, pack(1));
    if (mirror) this.device.queue.writeBuffer(this.viewBufMirror, 0, pack(-1));

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0.043, g: 0.051, b: 0.063, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setBindGroup(0, this.bindGroup);
    pass.setPipeline(this.framePipeline);
    pass.draw(5);
    pass.setPipeline(this.pipeline);
    const plane = (p: number) => p * sim.n * 4;
    const size = sim.n * 4;
    pass.setVertexBuffer(0, sim.particleBuffer, plane(PLANE.X), size);
    pass.setVertexBuffer(1, sim.particleBuffer, plane(PLANE.Y), size);
    pass.setVertexBuffer(2, sim.particleBuffer, plane(PLANE.VIZ), size);
    pass.setVertexBuffer(3, sim.particleBuffer, plane(PLANE.TAG), size);
    pass.draw(6, sim.n);
    if (mirror) {
      pass.setBindGroup(0, this.bindGroupMirror);
      pass.setPipeline(this.framePipeline);
      pass.draw(5);
      pass.setPipeline(this.pipeline);
      pass.draw(6, sim.n);
    }
    pass.end();
  }

  destroy(): void {
    this.viewBuf.destroy();
    this.viewBufMirror.destroy();
  }
}
