// Получение устройства WebGPU и сведения о нём для отчёта M0.
// Риск из раздела 2: WebGPU внутри Capacitor WebView на конкретном телефоне.

export type FeatureLevel = 'core' | 'compatibility';

export interface GpuReport {
  available: boolean;
  /** Почему WebGPU недоступен */
  reason?: string;
  featureLevel?: FeatureLevel;
  isFallbackAdapter?: boolean;
  adapter?: { vendor: string; architecture: string; device: string; description: string };
  limits?: Record<string, number>;
  userAgent: string;
  /** Запущено внутри Capacitor (APK) */
  native: boolean;
  platform: string;
}

export interface GpuContext {
  device: GPUDevice;
  adapter: GPUAdapter;
  report: GpuReport;
}

const REPORTED_LIMITS = [
  'maxStorageBufferBindingSize',
  'maxBufferSize',
  'maxStorageBuffersPerShaderStage',
  'maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupSizeX',
  'maxComputeWorkgroupsPerDimension',
  'maxStorageBuffersInVertexStage',
  'maxTextureDimension2D',
] as const;

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function baseReport(): GpuReport {
  const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  return {
    available: false,
    userAgent: navigator.userAgent,
    native: cap?.isNativePlatform?.() ?? false,
    platform: cap?.getPlatform?.() ?? 'web',
  };
}

/**
 * Сначала core-адаптер; если его нет — режим совместимости (OpenGL ES 3.1 на старых Android).
 * `forceCompat` — проверить, что ядра укладываются в лимиты режима совместимости.
 */
export async function acquireGpu(opts: { forceCompat?: boolean } = {}): Promise<GpuContext | GpuReport> {
  const report = baseReport();
  if (!('gpu' in navigator) || !navigator.gpu) {
    report.reason = 'navigator.gpu отсутствует: браузер или WebView без WebGPU (или страница не в secure context)';
    return report;
  }
  let adapter: GPUAdapter | null = null;
  let requestedCompat = false;
  try {
    if (!opts.forceCompat) adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      requestedCompat = true;
      adapter = await navigator.gpu.requestAdapter({ featureLevel: 'compatibility', powerPreference: 'high-performance' });
    }
  } catch (e) {
    report.reason = `requestAdapter: ${errorText(e)}`;
    return report;
  }
  if (!adapter) {
    report.reason = 'requestAdapter вернул null: подходящего GPU нет (ни core, ни compatibility)';
    return report;
  }

  const lim = adapter.limits;
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({
      label: 'terminal',
      requiredLimits: {
        maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize,
        maxBufferSize: lim.maxBufferSize,
      },
    });
  } catch (e) {
    report.reason = `requestDevice: ${errorText(e)}`;
    return report;
  }

  const info = adapter.info;
  report.available = true;
  // Устройство с адаптера, запрошенного в compat, валидируется по правилам совместимости, если не
  // включена 'core-features-and-limits'. Старые браузеры этой фичи не знают, но и compat не умеют.
  report.featureLevel =
    !requestedCompat || device.features.has('core-features-and-limits') ? 'core' : 'compatibility';
  // isFallbackAdapter переехал в GPUAdapterInfo; старые версии держат его на адаптере
  report.isFallbackAdapter =
    (info as GPUAdapterInfo & { isFallbackAdapter?: boolean }).isFallbackAdapter ??
    (adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter ??
    false;
  report.adapter = {
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
  };
  report.limits = Object.fromEntries(
    REPORTED_LIMITS.map((k) => [k, (device.limits as unknown as Record<string, number>)[k]]).filter(
      ([, v]) => v !== undefined,
    ),
  );
  return { device, adapter, report };
}

export function isGpuContext(x: GpuContext | GpuReport): x is GpuContext {
  return 'device' in x;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let shared: Promise<GpuContext | GpuReport> | undefined;

/**
 * Одно устройство на страницу: интерфейс, бенчмарк и тесты работают с ним.
 * Режим совместимости включается параметром адреса `?compat`.
 */
export function sharedGpu(): Promise<GpuContext | GpuReport> {
  shared ??= acquireGpu({ forceCompat: new URLSearchParams(location.search).has('compat') });
  return shared;
}
