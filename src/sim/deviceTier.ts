import * as THREE from 'three';

export type DeviceTier = 'high' | 'balanced' | 'efficiency';

export interface DeviceProfile {
  tier: DeviceTier;
  isSoftwareGl: boolean;
  isCoarse: boolean;
  maxDpr: number;
  shadows: boolean;
  shadowMapSize: number;
  envMode: 'pmrem-room' | 'pmrem-fast';
  physicalMaterials: boolean;
  rockSubdiv: 1 | 2;
  granuleCapInitial: number;
  maxAnisotropy: number;
}

const SOFTWARE_GL_RE = /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i;
const LOW_END_GPU_RE =
  /Mali-4|Mali-T|Mali-G3|Mali-G5[12]|Adreno.*?(?:3\d\d|4\d\d|50\d|51\d|61\d)|PowerVR|Tegra|VideoCore/i;

/**
 * Cheap pre-context check (no extra WebGL context created) used solely for antialias opt-out on
 * extremely constrained devices.
 */
export function probePreContextHints(): { antialias: boolean; isCoarse: boolean } {
  const isCoarse =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  const mem = typeof navigator !== 'undefined' ? ((navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4) : 4;
  const antialias = !(mem <= 2 || (isCoarse && cores <= 2));
  return { antialias, isCoarse };
}

/**
 * Reads GPU & hardware signals directly from the active WebGLRenderer context without spinning up a
 * redundant throwaway canvas context.
 */
export function detectDeviceProfile(renderer: THREE.WebGLRenderer): DeviceProfile {
  const isCoarse =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  const mem = typeof navigator !== 'undefined' ? ((navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4) : 4;

  let gpu = '';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    gpu = String(gl.getParameter(param) || '');
  } catch {
    gpu = '';
  }

  const isSoftwareGl = SOFTWARE_GL_RE.test(gpu);
  const isLowEndGpu = LOW_END_GPU_RE.test(gpu);
  const hwMaxAniso = renderer.capabilities.getMaxAnisotropy();

  if (isSoftwareGl) {
    return {
      tier: 'efficiency',
      isSoftwareGl: true,
      isCoarse,
      maxDpr: 1,
      shadows: false,
      shadowMapSize: 0,
      envMode: 'pmrem-fast',
      physicalMaterials: false,
      rockSubdiv: 1,
      granuleCapInitial: 9000,
      maxAnisotropy: 1,
    };
  }

  if (isLowEndGpu || mem <= 2 || (isCoarse && cores <= 4 && mem <= 4)) {
    return {
      tier: 'efficiency',
      isSoftwareGl: false,
      isCoarse,
      maxDpr: isCoarse ? 1.25 : 1.5,
      shadows: true,
      shadowMapSize: 512,
      envMode: 'pmrem-fast',
      physicalMaterials: false,
      rockSubdiv: 1,
      granuleCapInitial: 9000,
      maxAnisotropy: Math.min(2, hwMaxAniso),
    };
  }

  if (isCoarse || cores <= 4 || mem <= 4) {
    return {
      tier: 'balanced',
      isSoftwareGl: false,
      isCoarse,
      maxDpr: isCoarse ? 1.5 : 1.75,
      shadows: true,
      shadowMapSize: 768,
      envMode: 'pmrem-fast',
      physicalMaterials: !isCoarse,
      rockSubdiv: 1,
      granuleCapInitial: 10500,
      maxAnisotropy: Math.min(4, hwMaxAniso),
    };
  }

  return {
    tier: 'high',
    isSoftwareGl: false,
    isCoarse: false,
    maxDpr: 2,
    shadows: true,
    shadowMapSize: 1024,
    envMode: 'pmrem-room',
    physicalMaterials: true,
    rockSubdiv: 2,
    granuleCapInitial: 12000,
    maxAnisotropy: Math.min(4, hwMaxAniso),
  };
}

/**
 * Lightweight studio equirectangular reflection texture (~2ms to pre-filter via PMREMGenerator) that
 * reproduces RoomEnvironment's warm key, cool fill, and dark earth bounce without rendering 6 scene passes.
 */
export function createFastStudioEnvTexture(): THREE.CanvasTexture {
  const w = 128;
  const h = 64;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  const vert = ctx.createLinearGradient(0, 0, 0, h);
  vert.addColorStop(0.0, '#d8e4f2');
  vert.addColorStop(0.38, '#505a68');
  vert.addColorStop(0.55, '#2b241d');
  vert.addColorStop(1.0, '#140f0b');
  ctx.fillStyle = vert;
  ctx.fillRect(0, 0, w, h);

  // Warm overhead-front key lobe matching sunLight
  const key = ctx.createRadialGradient(w * 0.62, h * 0.24, 2, w * 0.62, h * 0.24, w * 0.28);
  key.addColorStop(0.0, 'rgba(255, 241, 214, 0.95)');
  key.addColorStop(0.45, 'rgba(255, 232, 194, 0.35)');
  key.addColorStop(1.0, 'rgba(255, 232, 194, 0)');
  ctx.fillStyle = key;
  ctx.fillRect(0, 0, w, h);

  // Cool back-left rim lobe matching rimLight
  const rim = ctx.createRadialGradient(w * 0.22, h * 0.32, 2, w * 0.22, h * 0.32, w * 0.24);
  rim.addColorStop(0.0, 'rgba(155, 196, 242, 0.72)');
  rim.addColorStop(0.5, 'rgba(136, 180, 232, 0.22)');
  rim.addColorStop(1.0, 'rgba(136, 180, 232, 0)');
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, w, h);

  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
